import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { assertSortedUniqueDates } from '../../../pipeline/momentum/index.js';

export const BAR_CSV_HEADER = 'date,open,high,low,close,volume,raw_close';
const SAXO_HEADER = 'date,open,high,low,close,volume';

export function barsToCsv(bars: readonly DailyBar[]): string {
  const lines = [BAR_CSV_HEADER];
  for (const bar of bars) {
    lines.push(
      [
        bar.date,
        price(bar.open),
        price(bar.high),
        price(bar.low),
        price(bar.close),
        String(bar.volume),
        price(bar.rawClose),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function price(value: number): string {
  return Number(value.toFixed(4)).toString();
}

export function parseBarCsv(symbol: string, text: string): BarSeries {
  const lines = text.split('\n').filter((line) => line.length > 0);
  const header = lines[0];
  if (header !== BAR_CSV_HEADER && header !== SAXO_HEADER) {
    throw new Error(`${symbol}: unexpected bar CSV header '${header}'`);
  }
  const hasRawClose = header === BAR_CSV_HEADER;
  const bars = lines.slice(1).map((line) => parseLine(symbol, line, hasRawClose));
  const series = { symbol, bars };
  assertSortedUniqueDates(series);
  return series;
}

function parseLine(symbol: string, line: string, hasRawClose: boolean): DailyBar {
  const cells = line.split(',');
  const expected = hasRawClose ? 7 : 6;
  if (cells.length !== expected) {
    throw new Error(`${symbol}: bar row '${line}' has ${cells.length} cells, expected ${expected}`);
  }
  const numbers = cells.slice(1).map((cell) => {
    const value = Number(cell);
    if (!Number.isFinite(value))
      throw new Error(`${symbol}: non-numeric cell '${cell}' in '${line}'`);
    return value;
  });
  const [open, high, low, close, volume, rawClose] = numbers as [
    number,
    number,
    number,
    number,
    number,
    number | undefined,
  ];
  return {
    date: cells[0] as string,
    open,
    high,
    low,
    close,
    volume,
    rawClose: rawClose ?? close,
  };
}

export function loadBarDirectory(directory: string): Map<string, BarSeries> {
  const series = new Map<string, BarSeries>();
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.csv'))
    .sort();
  for (const file of files) {
    const symbol = file.slice(0, -'.csv'.length);
    series.set(symbol, parseBarCsv(symbol, readFileSync(join(directory, file), 'utf8')));
  }
  return series;
}
