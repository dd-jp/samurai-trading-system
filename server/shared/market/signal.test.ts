import { crossSectionalTopK, timeSeriesTrend, trailingReturn } from './signal.js';

const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
const closeAt = (index: number): number | undefined => closes[index];

describe('trailingReturn', () => {
  it('measures close(t - skip) over close(t - lookback), excluding the skipped month', () => {
    const result = trailingReturn(closeAt, 12, { lookbackDays: 10, skipDays: 2 });
    expect(result).toBeCloseTo(110 / 102 - 1);
  });

  it('is undefined before the lookback is available', () => {
    expect(trailingReturn(closeAt, 5, { lookbackDays: 10, skipDays: 2 })).toBeUndefined();
  });

  it('is undefined when either endpoint has no close', () => {
    const sparse = (index: number): number | undefined => (index === 2 ? undefined : closes[index]);
    expect(trailingReturn(sparse, 12, { lookbackDays: 10, skipDays: 2 })).toBeUndefined();
    const sparseEnd = (index: number): number | undefined =>
      index === 10 ? undefined : closes[index];
    expect(trailingReturn(sparseEnd, 12, { lookbackDays: 10, skipDays: 2 })).toBeUndefined();
  });

  it('allows a zero skip and a window starting at index zero', () => {
    expect(trailingReturn(closeAt, 10, { lookbackDays: 10, skipDays: 0 })).toBeCloseTo(
      110 / 100 - 1,
    );
  });

  it('is undefined when the start close is zero', () => {
    const zeroStart = (index: number): number | undefined => (index === 2 ? 0 : closes[index]);
    expect(trailingReturn(zeroStart, 12, { lookbackDays: 10, skipDays: 2 })).toBeUndefined();
  });

  it('rejects a skip that is negative or not shorter than the lookback', () => {
    expect(() => trailingReturn(closeAt, 12, { lookbackDays: 10, skipDays: 10 })).toThrow(
      /skipDays/,
    );
    expect(() => trailingReturn(closeAt, 12, { lookbackDays: 10, skipDays: -1 })).toThrow(
      /skipDays/,
    );
  });
});

describe('timeSeriesTrend', () => {
  it('is long only on a strictly positive trailing return', () => {
    expect(timeSeriesTrend(0.001)).toBe('long');
    expect(timeSeriesTrend(0)).toBe('flat');
    expect(timeSeriesTrend(-0.2)).toBe('flat');
  });
});

describe('crossSectionalTopK', () => {
  it('ranks by score descending and breaks ties by symbol ascending', () => {
    const scores = new Map([
      ['B', 0.2],
      ['A', 0.2],
      ['C', 0.5],
      ['D', -0.1],
    ]);
    expect(crossSectionalTopK(scores, 3)).toEqual(['C', 'A', 'B']);
  });

  it('returns everything when k exceeds the universe', () => {
    expect(crossSectionalTopK(new Map([['A', 1]]), 10)).toEqual(['A']);
  });

  it('accepts k of one', () => {
    expect(
      crossSectionalTopK(
        new Map([
          ['A', 1],
          ['B', 2],
        ]),
        1,
      ),
    ).toEqual(['B']);
  });

  it('rejects a non-positive or fractional k', () => {
    expect(() => crossSectionalTopK(new Map(), 0)).toThrow(/k must be/);
    expect(() => crossSectionalTopK(new Map(), 1.5)).toThrow(/k must be/);
  });
});
