import { describe, expect, it } from 'vitest';
import {
  classifyMarkFreshness,
  MARK_CLOCK_SKEW_TOLERANCE_MS,
  markAgeMs,
} from './mark-freshness.js';
import type { Mark } from './types.js';

const READ_AT = new Date('2026-08-15T12:00:00.000Z');

function markObservedAt(iso: string): Mark {
  return { price: 100, observed_at: new Date(iso), source: 'test', asset_class: 'crypto' };
}

describe('markAgeMs', () => {
  it('measures from observation to the read instant', () => {
    expect(markAgeMs(markObservedAt('2026-08-15T11:59:00.000Z'), READ_AT)).toBe(60_000);
  });

  it('is zero for a mark observed at the read instant', () => {
    expect(markAgeMs(markObservedAt('2026-08-15T12:00:00.000Z'), READ_AT)).toBe(0);
  });

  it('goes negative for a mark observed after the read instant', () => {
    expect(markAgeMs(markObservedAt('2026-08-15T12:00:30.000Z'), READ_AT)).toBe(-30_000);
  });
});

describe('classifyMarkFreshness', () => {
  it('passes a mark inside the bound', () => {
    expect(
      classifyMarkFreshness(markObservedAt('2026-08-15T11:59:00.000Z'), READ_AT, 120_000),
    ).toMatchObject({ status: 'fresh' });
  });

  it('passes a mark exactly at the bound', () => {
    expect(
      classifyMarkFreshness(markObservedAt('2026-08-15T11:58:00.000Z'), READ_AT, 120_000),
    ).toMatchObject({ status: 'fresh' });
  });

  it('reports a mark past the bound as stale, with the age and the bound it broke', () => {
    expect(
      classifyMarkFreshness(markObservedAt('2026-08-15T11:57:59.000Z'), READ_AT, 120_000),
    ).toEqual({ status: 'stale', age_ms: 121_000, bound_ms: 120_000 });
  });

  it('reports a mark observed well after the read instant as a clock disagreement', () => {
    expect(
      classifyMarkFreshness(markObservedAt('2026-08-15T12:20:00.000Z'), READ_AT, 120_000),
    ).toEqual({
      status: 'ahead',
      age_ms: -1_200_000,
      tolerance_ms: MARK_CLOCK_SKEW_TOLERANCE_MS,
    });
  });

  describe('pass latency is not a forward offset against the read instant (#1111)', () => {
    it.each([149, 1_083, 55_815, 83_993, 145_000])(
      'passes a mark read %sms into a pass, its own age well inside the bound',
      (passLatencyMs) => {
        const asOf = new Date(READ_AT.getTime() - passLatencyMs);
        const mark = markObservedAt(new Date(READ_AT.getTime() - 50).toISOString());

        expect(markAgeMs(mark, asOf)).toBeLessThan(0);

        expect(classifyMarkFreshness(mark, READ_AT, 900_000)).toMatchObject({ status: 'fresh' });
      },
    );

    it('still refuses a mark genuinely older than its bound, however long the pass took', () => {
      const mark = markObservedAt('2026-08-15T11:40:00.000Z');
      expect(classifyMarkFreshness(mark, READ_AT, 900_000)).toMatchObject({ status: 'stale' });
    });
  });

  describe('receipt-side skew tolerance', () => {
    it('passes a mark stamped exactly at the tolerance ahead of the read instant', () => {
      const observedAt = new Date(READ_AT.getTime() + MARK_CLOCK_SKEW_TOLERANCE_MS);
      expect(
        classifyMarkFreshness(
          { price: 100, observed_at: observedAt, source: 'test', asset_class: 'crypto' },
          READ_AT,
          120_000,
        ),
      ).toMatchObject({ status: 'fresh' });
    });

    it('reports a mark just past the tolerance as ahead', () => {
      const observedAt = new Date(READ_AT.getTime() + MARK_CLOCK_SKEW_TOLERANCE_MS + 1);
      expect(
        classifyMarkFreshness(
          { price: 100, observed_at: observedAt, source: 'test', asset_class: 'crypto' },
          READ_AT,
          120_000,
        ),
      ).toMatchObject({ status: 'ahead' });
    });
  });

  it.each([0, -1, Number.NaN])('refuses a non-positive or NaN bound (%s)', (bound) => {
    expect(() =>
      classifyMarkFreshness(markObservedAt('2026-08-15T12:00:00.000Z'), READ_AT, bound),
    ).toThrow(/positive number of milliseconds/);
  });

  it('refuses an undefined bound reaching it through a Record lookup', () => {
    const bounds: Record<string, number> = { crypto: 120_000 };
    expect(() =>
      classifyMarkFreshness(
        markObservedAt('2026-08-15T12:00:00.000Z'),
        READ_AT,
        bounds.stocks as number,
      ),
    ).toThrow(/positive number of milliseconds/);
  });
});
