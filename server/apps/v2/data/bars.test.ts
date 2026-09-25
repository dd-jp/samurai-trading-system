import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import { barsBefore, currentConstituents, ParquetBarsSource } from './bars.js';

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

describe('ParquetBarsSource', () => {
  let directory: string;
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('refuses to prime from a venue with no series rather than serve nothing', async () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-bars-'));
    const source = new ParquetBarsSource(join(directory, 'absent'), 'alpaca');
    await expect(source.prime()).rejects.toThrow(/no alpaca series under .*absent/);
    expect(() => source.load('AAPL')).toThrow(/before prime/);
  });

  it('serves a whole venue after prime() and reports a missing symbol as undefined', async () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-bars-'));
    const store = await ParquetBarStore.open(directory);
    await store.write('alpaca', [series('AAPL', 3, 10, 100)]);
    await store.write('saxo', [series('ISF', 2, 7, 1.5)]);
    store.close();
    const source = new ParquetBarsSource(directory, 'alpaca');
    expect(() => source.load('AAPL')).toThrow(/alpaca read before prime\(\)/);
    await source.prime();
    await source.prime();
    expect(source.load('AAPL')).toEqual(series('AAPL', 3, 10, 100));
    expect(source.load('AAPL')).toBe(source.load('AAPL'));
    expect(source.load('ISF')).toBeUndefined();
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
