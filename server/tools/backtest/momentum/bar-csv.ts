import type { DailyBar } from '../../../pipeline/momentum/index.js';

export const BAR_CSV_HEADER = 'date,open,high,low,close,volume,raw_close';

export function barsToCsv(bars: readonly DailyBar[]): string {
  const lines = [BAR_CSV_HEADER];
  for (const bar of roundBarPrices(bars)) {
    lines.push(
      [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.rawClose].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function roundBarPrices(bars: readonly DailyBar[]): DailyBar[] {
  return bars.map((bar) => ({
    date: bar.date,
    open: price(bar.open),
    high: price(bar.high),
    low: price(bar.low),
    close: price(bar.close),
    volume: bar.volume,
    rawClose: price(bar.rawClose),
  }));
}

function price(value: number): number {
  return Number(value.toFixed(4));
}
