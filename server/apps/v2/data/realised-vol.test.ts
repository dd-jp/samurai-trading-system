import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../../contracts/index.js';
import { realisedVolatility } from './realised-vol.js';

function datedBars(closes: readonly number[]): V2Bar[] {
  const start = Date.parse('2025-01-01T00:00:00.000Z');
  return closes.map((close, index) => ({
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
    rawClose: close,
  }));
}

function flatCloses(length: number, close = 100): number[] {
  return Array.from({ length }, () => close);
}

// Alternating ±step closes give ten up and ten down log returns over the 20-day window, so the
// mean is exactly zero and the volatility has a closed form
function alternatingCloses(step: number, length: number): number[] {
  return Array.from({ length }, (_, index) => (index % 2 === 0 ? 100 : 100 + step));
}

describe('realisedVolatility', () => {
  it('is undefined until window + 1 closes exist', () => {
    expect(realisedVolatility(datedBars(flatCloses(20)), 20)).toBeUndefined();
    expect(realisedVolatility(datedBars(flatCloses(21)), 20)).toBe(0);
  });

  it('annualises the sample deviation of log returns by sqrt(252)', () => {
    const step = Math.log(101 / 100);
    const expected = Math.sqrt(((20 * step ** 2) / 19) * 252);
    expect(realisedVolatility(datedBars(alternatingCloses(1, 21)), 20)).toBeCloseTo(expected, 12);
  });

  it('subtracts the mean, so a constant daily return has zero volatility', () => {
    const closes = Array.from({ length: 21 }, (_, index) => 100 * 1.01 ** index);
    expect(realisedVolatility(datedBars(closes), 20)).toBeCloseTo(0, 12);
  });

  it('reads only the last window + 1 closes', () => {
    const closes = [1, 1_000, ...flatCloses(21)];
    expect(realisedVolatility(datedBars(closes), 20)).toBe(0);
  });

  it('fails closed on a non-positive close inside the window', () => {
    const closes = flatCloses(21);
    closes[5] = 0;
    expect(realisedVolatility(datedBars(closes), 20)).toBeUndefined();
    closes[5] = -1;
    expect(realisedVolatility(datedBars(closes), 20)).toBeUndefined();
  });

  it('ignores a non-positive close before the window', () => {
    expect(realisedVolatility(datedBars([0, ...flatCloses(21)]), 20)).toBe(0);
  });
});
