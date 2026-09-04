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
  it('stays quiet for the first two observations — not a warning-on-first design (#1087 review, pass 2)', () => {
    // Threshold 3, not 1: `ingest-fills.ts`'s own doc names "once or twice"
    // of this as ordinary live-arm propagation lag, not a defect.
    const throttle = new FilledZeroSizeThrottle();
    expect(throttle.observe('lot-1')).toEqual({ warn: false, consecutive: 1 });
    expect(throttle.observe('lot-1')).toEqual({ warn: false, consecutive: 2 });
  });

  it('the alert-after threshold is 3, covering the documented "once or twice" benign lag with a poll of margin', () => {
    // Pins the constant, not just the behavior: a reader changing this
    // constant should see this test name it explicitly.
    expect(ALERT_AFTER_CONSECUTIVE_ZERO_SIZE).toBe(3);
  });

  it('warns on the 3rd consecutive observation, stays quiet for the next 7, then warns on the 11th', () => {
    const throttle = new FilledZeroSizeThrottle();
    const results: boolean[] = [];
    for (let i = 0; i < 11; i += 1) {
      results.push(throttle.observe('lot-1').warn);
    }
    expect(results).toEqual([
      false, // 1
      false, // 2
      true, // 3 — ALERT_AFTER_CONSECUTIVE_ZERO_SIZE
      false, // 4
      false, // 5
      false, // 6
      false, // 7
      false, // 8
      false, // 9
      false, // 10
      true, // 11 — 3 + ALERT_REPEAT_EVERY_ZERO_SIZE
    ]);
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
    throttle.observe('lot-1'); // consecutive: 3, warns
    // lot-2's FIRST observation is still below threshold, unaffected by
    // lot-1's count — no shared state between lots.
    expect(throttle.observe('lot-2')).toEqual({ warn: false, consecutive: 1 });
  });

  it('clear() resets a lot so its next observation restarts the grace window', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1');
    throttle.observe('lot-1'); // consecutive: 2, quiet
    throttle.clear('lot-1');
    expect(throttle.observe('lot-1')).toEqual({ warn: false, consecutive: 1 });
  });

  it('clear() on a lot never observed is a no-op, not an error', () => {
    const throttle = new FilledZeroSizeThrottle();
    expect(() => throttle.clear('never-seen')).not.toThrow();
  });
});
