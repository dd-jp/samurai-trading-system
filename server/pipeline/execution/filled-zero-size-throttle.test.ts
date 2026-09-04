/**
 * #1087 code review — the `FilledZeroSizeThrottle` shape itself, on its own:
 * boundary/sequence behavior is easier to pin here than through a full
 * `ingestFills()` poll (same reasoning as `tick-skip-alert.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  ALERT_AFTER_CONSECUTIVE_ZERO_SIZE,
  ALERT_REPEAT_EVERY_ZERO_SIZE,
  FilledZeroSizeThrottle,
} from './filled-zero-size-throttle.js';

describe('FilledZeroSizeThrottle', () => {
  it('warns on the first observation', () => {
    const throttle = new FilledZeroSizeThrottle();
    expect(throttle.observe('lot-1')).toEqual({ warn: true, consecutive: 1 });
  });

  it('the alert-after threshold is 1 — the first poll, not the second', () => {
    // Pins the constant, not just the behavior: a reader changing this
    // constant should see this test name it explicitly.
    expect(ALERT_AFTER_CONSECUTIVE_ZERO_SIZE).toBe(1);
  });

  it('stays quiet for the next 7 consecutive observations, then warns on the 9th', () => {
    const throttle = new FilledZeroSizeThrottle();
    const results: boolean[] = [];
    for (let i = 0; i < 9; i += 1) {
      results.push(throttle.observe('lot-1').warn);
    }
    expect(results).toEqual([true, false, false, false, false, false, false, false, true]);
    expect(ALERT_REPEAT_EVERY_ZERO_SIZE).toBe(8);
  });

  it('reports the correct consecutive count on every observation, warned or not', () => {
    const throttle = new FilledZeroSizeThrottle();
    const consecutive = Array.from({ length: 3 }, () => throttle.observe('lot-1').consecutive);
    expect(consecutive).toEqual([1, 2, 3]);
  });

  it('counts each lot independently — one wedged lot does not silence another', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1');
    throttle.observe('lot-1');
    // lot-2's FIRST observation still warns, unaffected by lot-1's count.
    expect(throttle.observe('lot-2')).toEqual({ warn: true, consecutive: 1 });
  });

  it('clear() resets a lot so its next observation warns again as a first occurrence', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1');
    throttle.observe('lot-1'); // consecutive: 2, quiet
    throttle.clear('lot-1');
    expect(throttle.observe('lot-1')).toEqual({ warn: true, consecutive: 1 });
  });

  it('clear() on a lot never observed is a no-op, not an error', () => {
    const throttle = new FilledZeroSizeThrottle();
    expect(() => throttle.clear('never-seen')).not.toThrow();
  });
});
