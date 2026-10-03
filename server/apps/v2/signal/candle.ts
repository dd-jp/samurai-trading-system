import type { DailyBar } from '../../../shared/index.js';

export interface CandleFeatures {
  readonly body: number;
  readonly upperWick: number;
  readonly lowerWick: number;
}

export function candleFeatures(bar: DailyBar): CandleFeatures | undefined {
  const range = bar.high - bar.low;
  if (range <= 0) return undefined;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);
  const upperWick = (bar.high - bodyTop) / range;
  const lowerWick = (bodyBottom - bar.low) / range;
  if (upperWick < 0 || lowerWick < 0) return undefined;
  return { body: (bodyTop - bodyBottom) / range, upperWick, lowerWick };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function candleLine(candle: CandleFeatures | undefined): string {
  if (candle === undefined) {
    return 'prior-day candle: n/a (zero range, or open/close outside high-low)';
  }
  return (
    `prior-day candle: body ${pct(candle.body)}, upper wick ${pct(candle.upperWick)}, ` +
    `lower wick ${pct(candle.lowerWick)} of range`
  );
}
