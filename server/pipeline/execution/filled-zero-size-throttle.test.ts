/**
 * #1087 code review — the `FilledZeroSizeThrottle` shape itself, on its own:
 * boundary/sequence behavior is easier to pin here than through a full
 * `ingestFills()` poll (same reasoning as `tick-skip-alert.test.ts`).
 *
 * #1383: rebuilt from bounded-repeat (warn at 3, then every 8th thereafter)
 * to transition-only (warn once per episode, silent until `clear()`) — the
 * periodic repeat was itself the flood a 20h soak measured: one lot wedged
 * for the whole run produced ~600 warns on that cadence alone.
 */
import { describe, expect, it } from 'vitest';
import {
  ALERT_AFTER_CONSECUTIVE_ZERO_SIZE,
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

  it('warns exactly once on the 3rd consecutive observation, then stays quiet for as long as the lot stays wedged (#1383)', () => {
    const throttle = new FilledZeroSizeThrottle();
    const results: boolean[] = [];
    for (let i = 0; i < 40; i += 1) {
      results.push(throttle.observe('lot-1').warn);
    }
    expect(results.filter(Boolean)).toEqual([true]);
    expect(results.indexOf(true)).toBe(2); // 0-indexed: the 3rd observation
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

  it('a different lot crossing threshold warns independently of an already-warned lot', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1');
    throttle.observe('lot-1');
    expect(throttle.observe('lot-1')).toEqual({ warn: true, consecutive: 3 }); // lot-1 warns
    throttle.observe('lot-2');
    throttle.observe('lot-2');
    // lot-2 reaching the same threshold warns too — the silence is per-lot,
    // not a single global "one warning ever" latch.
    expect(throttle.observe('lot-2')).toEqual({ warn: true, consecutive: 3 });
  });

  it('clear() resets a lot so its next observation restarts the grace window and can warn again', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1');
    throttle.observe('lot-1');
    throttle.observe('lot-1'); // consecutive: 3, warns
    throttle.clear('lot-1');
    expect(throttle.observe('lot-1')).toEqual({ warn: false, consecutive: 1 });
    throttle.observe('lot-1');
    // A second episode for the same lot (cleared, then wedged again) warns
    // again on its own 3rd — clearing genuinely ends the prior episode.
    expect(throttle.observe('lot-1')).toEqual({ warn: true, consecutive: 3 });
  });

  it('clear() reports whether the cleared episode had actually warned', () => {
    const throttle = new FilledZeroSizeThrottle();
    throttle.observe('lot-1');
    throttle.observe('lot-1'); // consecutive: 2 — never reached the warn threshold
    expect(throttle.clear('lot-1')).toEqual({ hadWarned: false });

    throttle.observe('lot-2');
    throttle.observe('lot-2');
    throttle.observe('lot-2'); // consecutive: 3 — warned
    expect(throttle.clear('lot-2')).toEqual({ hadWarned: true });
  });

  it('clear() on a lot never observed is a no-op, not an error, and reports hadWarned: false', () => {
    const throttle = new FilledZeroSizeThrottle();
    expect(() => throttle.clear('never-seen')).not.toThrow();
    expect(throttle.clear('never-seen')).toEqual({ hadWarned: false });
  });
});
