import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { barsBefore, CsvBarsSource, currentConstituents, parseBarsCsv } from './bars.js';

const HEADER = 'date,open,high,low,close,volume,raw_close';

function series(symbol: string, days: number, price: number, volume: number): BarSeries {
  const bars: DailyBar[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    bars.push({
      date: `2026-09-${day}`,
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume,
      rawClose: price,
    });
  }
  return { symbol, bars };
}

describe('parseBarsCsv', () => {
  it('reads the committed column order into DailyBar', () => {
    const parsed = parseBarsCsv('AAPL', `${HEADER}\n2026-09-22,1,2,0.5,1.5,100,150\n`);
    expect(parsed.bars).toEqual([
      { date: '2026-09-22', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, rawClose: 150 },
    ]);
  });

  it('rejects a foreign header, a bad row, or unsorted dates', () => {
    expect(() => parseBarsCsv('X', 'a,b\n')).toThrow(/unexpected header/);
    expect(() => parseBarsCsv('X', `${HEADER}\n2026-09-22,1,2,0.5,0,100,150`)).toThrow(/bad row/);
    expect(() =>
      parseBarsCsv('X', `${HEADER}\n2026-09-23,1,2,0.5,1,1,1\n2026-09-22,1,2,0.5,1,1,1`),
    ).toThrow();
  });
});

describe('CsvBarsSource', () => {
  let directory: string;
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('loads a symbol file once and reports a missing symbol as undefined', () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-bars-'));
    writeFileSync(join(directory, 'AAPL.csv'), `${HEADER}\n2026-09-22,1,2,0.5,1.5,100,150\n`);
    const source = new CsvBarsSource(directory);
    expect(source.load('AAPL')?.bars).toHaveLength(1);
    expect(source.load('AAPL')).toBe(source.load('AAPL'));
    expect(source.load('ZZZZ')).toBeUndefined();
  });
});

describe('currentConstituents', () => {
  const csv = 'date,tickers\n2016-01-04,"A,B"\n2026-06-01,"B,C,D"\n2026-12-01,"E"\n';

  it('takes the last membership row on or before the trading date', () => {
    expect(currentConstituents(csv, '2026-09-25')).toEqual(['B', 'C', 'D']);
    expect(currentConstituents(csv, '2026-06-01')).toEqual(['B', 'C', 'D']);
    expect(currentConstituents(csv, '2020-01-01')).toEqual(['A', 'B']);
  });

  it('rejects a date before the first row or a foreign header', () => {
    expect(() => currentConstituents(csv, '2015-01-01')).toThrow(/no row/);
    expect(() => currentConstituents('x,y\n', '2026-01-01')).toThrow(/header/);
  });
});

describe('coverage invariant', () => {
  it('reads only bars strictly before the entry date, so a bar dated the entry day is excluded', () => {
    const before = series('X', 26, 100, 1);
    expect(
      barsBefore(before, '2026-09-26')
        .map((bar) => bar.date)
        .at(-1),
    ).toBe('2026-09-25');
    expect(
      barsBefore(before, '2026-09-25')
        .map((bar) => bar.date)
        .at(-1),
    ).toBe('2026-09-24');
    expect(barsBefore(before, '2026-09-25')).toHaveLength(24);
    expect(barsBefore(before, '2026-09-01')).toEqual([]);
  });
});
