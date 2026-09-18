import { describe, expect, it } from 'vitest';
import {
  ALERT_AFTER_CONSECUTIVE_ZERO_SIZE,
  FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS,
  FilledZeroSizeThrottle,
} from './filled-zero-size-throttle.js';

const T0 = new Date('2026-09-01T00:00:00Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

describe('FilledZeroSizeThrottle', () => {
  it('stays quiet for the first two observations — not a warning-on-first design (#1087 review, pass 2)', () => {
    const throttle = new FilledZeroSizeThrottle();
    expect(throttle.observe('lot-1', at(0))).toEqual({ announce: null, consecutive: 1 });
    expect(throttle.observe('lot-1', at(1))).toEqual({ announce: null, consecutive: 2 });
  });

  it('the alert-after threshold is 3, covering the documented "once or twice" benign lag with a poll of margin', () => {
    expect(ALERT_AFTER_CONSECUTIVE_ZERO_SIZE).toBe(3);
  });

  it('the FIRST occurrence announces at warn — not info, not silent (#1383 AC3)', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1', at(0));
    throttle.observe('lot-1', at(1));
    expect(throttle.observe('lot-1', at(2))).toEqual({ announce: 'warn', consecutive: 3 });
  });

  it('stays quiet for many further polls inside the reannounce window, then announces at info — never warn again', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1', at(0));
    throttle.observe('lot-1', at(1));
    expect(throttle.observe('lot-1', at(2))).toMatchObject({ announce: 'warn' });

    const announcements: (string | null)[] = [];
    for (let i = 1; i <= 40; i += 1) {
      announcements.push(throttle.observe('lot-1', at(2 + i * 1_000)).announce);
    }
    expect(announcements.every((a) => a === null)).toBe(true);

    const reannounced = throttle.observe('lot-1', at(2 + FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1));
    expect(reannounced.announce).toBe('info');
    expect(reannounced.consecutive).toBeGreaterThan(3);
  });

  it('reports the correct consecutive count on every observation, announced or not', () => {
    const throttle = new FilledZeroSizeThrottle();
    const consecutive = Array.from(
      { length: 3 },
      (_, i) => throttle.observe('lot-1', at(i)).consecutive,
    );
    expect(consecutive).toEqual([1, 2, 3]);
  });

  it('counts each lot independently — one wedged lot does not silence another', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1', at(0));
    throttle.observe('lot-1', at(1));
    throttle.observe('lot-1', at(2));
    expect(throttle.observe('lot-2', at(3))).toEqual({ announce: null, consecutive: 1 });
  });

  it('a different lot crossing threshold warns independently of an already-warned lot', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1', at(0));
    throttle.observe('lot-1', at(1));
    expect(throttle.observe('lot-1', at(2))).toEqual({ announce: 'warn', consecutive: 3 });
    throttle.observe('lot-2', at(3));
    throttle.observe('lot-2', at(4));
    expect(throttle.observe('lot-2', at(5))).toEqual({ announce: 'warn', consecutive: 3 });
  });

  it('clear() resets a lot so its next observation restarts the grace window and can warn again', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1', at(0));
    throttle.observe('lot-1', at(1));
    throttle.observe('lot-1', at(2));
    throttle.clear('lot-1');
    expect(throttle.observe('lot-1', at(3))).toEqual({ announce: null, consecutive: 1 });
    throttle.observe('lot-1', at(4));
    expect(throttle.observe('lot-1', at(5))).toEqual({ announce: 'warn', consecutive: 3 });
  });

  it('clear() reports whether the cleared episode had actually warned', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1', at(0));
    throttle.observe('lot-1', at(1));
    expect(throttle.clear('lot-1')).toEqual({ hadWarned: false });

    throttle.observe('lot-2', at(0));
    throttle.observe('lot-2', at(1));
    throttle.observe('lot-2', at(2));
    expect(throttle.clear('lot-2')).toEqual({ hadWarned: true });
  });

  it('clear() on a lot never observed is a no-op, not an error, and reports hadWarned: false', () => {
    const throttle = new FilledZeroSizeThrottle();
    expect(() => throttle.clear('never-seen')).not.toThrow();
    expect(throttle.clear('never-seen')).toEqual({ hadWarned: false });
  });

  it('an episode that never clears stays warned forever — never re-warns even after many reannounce windows (documents the accepted leak, see class doc)', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1', at(0));
    throttle.observe('lot-1', at(1));
    expect(throttle.observe('lot-1', at(2))).toMatchObject({ announce: 'warn' });

    let t = 2;
    const announcements: (string | null)[] = [];
    for (let i = 0; i < 10; i += 1) {
      t += FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1;
      announcements.push(throttle.observe('lot-1', at(t)).announce);
    }
    expect(announcements.every((a) => a === 'info')).toBe(true);
  });
});
