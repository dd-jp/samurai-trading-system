import { describe, expect, it } from 'vitest';
import { isMarkStale, MARK_FORWARD_TOLERANCE_MS, markAgeMs } from './mark-freshness.js';
import type { Mark } from './types.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');

function markObservedAt(iso: string): Mark {
  return { price: 100, observed_at: new Date(iso), source: 'test', asset_class: 'crypto' };
}

describe('markAgeMs', () => {
  it('measures from observation to now', () => {
    expect(markAgeMs(markObservedAt('2026-08-15T11:59:00.000Z'), NOW)).toBe(60_000);
  });

  it('is zero for a mark observed at now', () => {
    expect(markAgeMs(markObservedAt('2026-08-15T12:00:00.000Z'), NOW)).toBe(0);
  });

  it('goes negative for a mark observed after now', () => {
    // Not "very fresh" — a clock disagreement. Kept signed rather than
    // absolute so `isMarkStale` can tell the two apart.
    expect(markAgeMs(markObservedAt('2026-08-15T12:00:30.000Z'), NOW)).toBe(-30_000);
  });
});

describe('isMarkStale', () => {
  it('passes a mark inside the bound', () => {
    expect(isMarkStale(markObservedAt('2026-08-15T11:59:00.000Z'), NOW, 120_000)).toBe(false);
  });

  it('passes a mark exactly at the bound', () => {
    // `>` not `>=`: the bound is the oldest ACCEPTABLE age, which keeps a
    // config of 120_000 from rejecting a mark of exactly two minutes and
    // makes the boundary readable in a log line.
    expect(isMarkStale(markObservedAt('2026-08-15T11:58:00.000Z'), NOW, 120_000)).toBe(false);
  });

  it('fails a mark past the bound', () => {
    expect(isMarkStale(markObservedAt('2026-08-15T11:57:59.000Z'), NOW, 120_000)).toBe(true);
  });

  it('fails a mark observed well in the future, beyond the forward-tolerance grace', () => {
    // The case a naive `age > max` check passes: a mark from 20 minutes in the
    // future is not fresh, it is evidence that one of the two clocks is wrong
    // — including the one every other time comparison in the pass uses. This
    // is far outside `MARK_FORWARD_TOLERANCE_MS`, so it still trips the guard.
    expect(isMarkStale(markObservedAt('2026-08-15T12:20:00.000Z'), NOW, 120_000)).toBe(true);
  });

  // #939: `asOf` is the tick's START instant, while marks are read later in
  // the same pass. A data source that stamps `observed_at` from a live quote
  // clock legitimately produces a mark a few hundred milliseconds "ahead" of
  // `asOf` — that is pass latency, not a clock disagreement. A small, named
  // forward tolerance admits that ordering artifact without reopening the
  // door to genuine skew (#640).
  describe('forward tolerance (#939)', () => {
    it('passes a mark observed 149ms after now (soak-observed pass latency)', () => {
      expect(isMarkStale(markObservedAt('2026-08-15T12:00:00.149Z'), NOW, 120_000)).toBe(false);
    });

    it('passes a mark observed 1083ms after now (soak-observed pass latency)', () => {
      expect(isMarkStale(markObservedAt('2026-08-15T12:00:01.083Z'), NOW, 120_000)).toBe(false);
    });

    it('passes a mark observed exactly at the forward-tolerance bound', () => {
      const observedAt = new Date(NOW.getTime() + MARK_FORWARD_TOLERANCE_MS);
      expect(
        isMarkStale(
          { price: 100, observed_at: observedAt, source: 'test', asset_class: 'crypto' },
          NOW,
          120_000,
        ),
      ).toBe(false);
    });

    it('fails a mark observed just past the forward-tolerance bound', () => {
      const observedAt = new Date(NOW.getTime() + MARK_FORWARD_TOLERANCE_MS + 1);
      expect(
        isMarkStale(
          { price: 100, observed_at: observedAt, source: 'test', asset_class: 'crypto' },
          NOW,
          120_000,
        ),
      ).toBe(true);
    });

    it('still fails a mark observed minutes in the future — genuine clock skew, not pass latency', () => {
      expect(isMarkStale(markObservedAt('2026-08-15T12:20:00.000Z'), NOW, 120_000)).toBe(true);
    });
  });

  it.each([0, -1, Number.NaN])('refuses a non-positive or NaN bound (%s)', (bound) => {
    // An omitted config key reads as `undefined` through a `Record` lookup and
    // arrives here as NaN or 0. Silently treating that as "everything is
    // stale" would arm a kill switch nobody configured, and the symptom — no
    // trades, `stale_feed` on every tick — looks like a dead feed rather than
    // a typo.
    expect(() => isMarkStale(markObservedAt('2026-08-15T12:00:00.000Z'), NOW, bound)).toThrow(
      /positive number of milliseconds/,
    );
  });

  it('refuses an undefined bound reaching it through a Record lookup', () => {
    const bounds: Record<string, number> = { crypto: 120_000 };
    expect(() =>
      isMarkStale(markObservedAt('2026-08-15T12:00:00.000Z'), NOW, bounds.stocks as number),
    ).toThrow(/positive number of milliseconds/);
  });
});
