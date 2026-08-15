import { describe, expect, it } from 'vitest';
import { isMarkStale, markAgeMs } from './mark-freshness.js';
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

  it('fails a mark observed in the future, however small the skew', () => {
    // The case a naive `age > max` check passes: a mark from 20 minutes in the
    // future is not fresh, it is evidence that one of the two clocks is wrong
    // — including the one every other time comparison in the pass uses.
    expect(isMarkStale(markObservedAt('2026-08-15T12:20:00.000Z'), NOW, 120_000)).toBe(true);
    expect(isMarkStale(markObservedAt('2026-08-15T12:00:00.001Z'), NOW, 120_000)).toBe(true);
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
