import type { BarSeries } from './bars.js';
import {
  assertSortedUniqueDates,
  coverageSatisfied,
  MIN_WINDOW_COVERAGE,
  windowCoverage,
} from './bars.js';

const calendar = Array.from(
  { length: 12 },
  (_, index) => `2024-01-${String(index + 1).padStart(2, '0')}`,
);

function series(dates: readonly string[]): BarSeries {
  return {
    symbol: 'X',
    bars: dates.map((date) => ({
      date,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 0,
      rawClose: 1,
    })),
  };
}

describe('assertSortedUniqueDates', () => {
  it('accepts strictly ascending ISO dates', () => {
    expect(() => assertSortedUniqueDates(series(['2024-01-01', '2024-01-02']))).not.toThrow();
  });

  it('rejects a duplicate date', () => {
    expect(() => assertSortedUniqueDates(series(['2024-01-01', '2024-01-01']))).toThrow(
      /not strictly ascending/,
    );
  });

  it('rejects a descending date', () => {
    expect(() => assertSortedUniqueDates(series(['2024-01-02', '2024-01-01']))).toThrow(
      /not strictly ascending/,
    );
  });

  it('rejects a non-ISO date', () => {
    expect(() => assertSortedUniqueDates(series(['01/02/2024']))).toThrow(/not YYYY-MM-DD/);
  });
});

describe('windowCoverage', () => {
  it('counts every calendar day in the window when bars are complete', () => {
    const coverage = windowCoverage(calendar, new Set(calendar), 10, 5);
    expect(coverage).toEqual({ required: 6, present: 6, ratio: 1, endsOnDecisionDay: true });
    expect(coverageSatisfied(coverage)).toBe(true);
  });

  it('reports a gap inside the window and stays satisfied above the floor', () => {
    const dates = new Set(calendar.filter((date) => date !== '2024-01-08'));
    const coverage = windowCoverage(calendar, dates, 10, 10);
    expect(coverage.present).toBe(10);
    expect(coverage.required).toBe(11);
    expect(coverage.ratio).toBeCloseTo(10 / 11);
    expect(coverageSatisfied(coverage, 0.9)).toBe(true);
    expect(coverageSatisfied(coverage, MIN_WINDOW_COVERAGE)).toBe(false);
  });

  it('is unsatisfied when the decision day itself has no bar, whatever the ratio', () => {
    const dates = new Set(calendar.filter((date) => date !== calendar[10]));
    const coverage = windowCoverage(calendar, dates, 10, 5);
    expect(coverage.endsOnDecisionDay).toBe(false);
    expect(coverageSatisfied(coverage, 0.5)).toBe(false);
  });

  it('is zero when the window starts before the calendar', () => {
    const coverage = windowCoverage(calendar, new Set(calendar), 3, 5);
    expect(coverage).toEqual({ required: 6, present: 0, ratio: 0, endsOnDecisionDay: false });
  });

  it('accepts decision index zero with lookback one as an incomplete window', () => {
    expect(windowCoverage(calendar, new Set(calendar), 0, 1).ratio).toBe(0);
    expect(windowCoverage(calendar, new Set(calendar), 1, 1).ratio).toBe(1);
  });

  it('is satisfied at exactly the minimum ratio', () => {
    const coverage = windowCoverage(calendar, new Set(calendar), 10, 5);
    expect(coverageSatisfied(coverage, 1)).toBe(true);
  });

  it('rejects an ISO date with leading or trailing characters', () => {
    expect(() => assertSortedUniqueDates(series(['2024-01-01T00:00']))).toThrow(/not YYYY-MM-DD/);
    expect(() => assertSortedUniqueDates(series(['x2024-01-01']))).toThrow(/not YYYY-MM-DD/);
  });

  it('rejects an out-of-range decision index and a non-positive lookback', () => {
    expect(() => windowCoverage(calendar, new Set(), 12, 5)).toThrow(/outside calendar/);
    expect(() => windowCoverage(calendar, new Set(), 5, 0)).toThrow(/lookbackDays/);
  });
});
