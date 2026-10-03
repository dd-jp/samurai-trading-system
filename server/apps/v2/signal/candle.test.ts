import type { DailyBar } from '../../../shared/index.js';
import { candleFeatures, candleLine } from './candle.js';

function bar(open: number, high: number, low: number, close: number): DailyBar {
  return { date: '2024-01-01', open, high, low, close, volume: 0, rawClose: close };
}

describe('candleFeatures', () => {
  it('splits an ordinary bar into body, upper wick and lower wick fractions of the range', () => {
    const features = candleFeatures(bar(10, 20, 0, 16));
    expect(features).toEqual({ body: 0.3, upperWick: 0.2, lowerWick: 0.5 });
  });

  it('is all body for a bullish marubozu, open at the low and close at the high', () => {
    expect(candleFeatures(bar(10, 20, 10, 20))).toEqual({
      body: 1,
      upperWick: 0,
      lowerWick: 0,
    });
  });

  it('is all body for a bearish marubozu, open at the high and close at the low', () => {
    expect(candleFeatures(bar(20, 20, 10, 10))).toEqual({
      body: 1,
      upperWick: 0,
      lowerWick: 0,
    });
  });

  it('is near-zero body for a doji, split unevenly between the wicks', () => {
    const features = candleFeatures(bar(15, 20, 0, 15.2));
    expect(features?.body).toBeCloseTo(0.01);
    expect(features?.upperWick).toBeCloseTo(0.24);
    expect(features?.lowerWick).toBeCloseTo(0.75);
  });

  it('keeps every fraction inside [0, 1] for any valid bar', () => {
    for (const [open, high, low, close] of [
      [10, 20, 0, 16],
      [10, 20, 10, 20],
      [20, 20, 10, 10],
      [15, 20, 0, 15.2],
      [12, 12.5, 11.5, 11.8],
    ] as const) {
      const features = candleFeatures(bar(open, high, low, close));
      for (const value of [features?.body, features?.upperWick, features?.lowerWick]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is undefined for a zero-range bar (high equals low)', () => {
    expect(candleFeatures(bar(10, 10, 10, 10))).toBeUndefined();
  });

  it('is undefined rather than a wrong number for a corrupt bar whose high is below its low', () => {
    expect(candleFeatures(bar(10, 9, 11, 10))).toBeUndefined();
  });

  it('is undefined for a real-data shape defect: close above the bar high (#1772 follow-up)', () => {
    expect(candleFeatures(bar(10, 20, 10, 25))).toBeUndefined();
  });

  it('is undefined for a real-data shape defect: open below the bar low (#1772 follow-up)', () => {
    expect(candleFeatures(bar(5, 20, 10, 15))).toBeUndefined();
  });
});

describe('candleLine', () => {
  it('reports the three fractions as percentages of range', () => {
    expect(candleLine({ body: 0.6, upperWick: 0.2, lowerWick: 0.2 })).toBe(
      'prior-day candle: body 60.00%, upper wick 20.00%, lower wick 20.00% of range',
    );
  });

  it('reports the unavailable cases explicitly instead of a computed value', () => {
    expect(candleLine(undefined)).toBe(
      'prior-day candle: n/a (zero range, or open/close outside high-low)',
    );
  });
});
