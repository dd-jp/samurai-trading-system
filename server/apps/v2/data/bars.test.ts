import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ParquetBarStore } from '../../../providers/bar-store/index.js';
import type { BarSeries, DailyBar } from '../../../shared/index.js';
import {
  barsBefore,
  calendarReferenceFor,
  currentConstituents,
  MultiVenueBarsSource,
  ParquetBarsSource,
  sessionsBefore,
  windowCovered,
} from './bars.js';

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
    await expect(source.prime()).rejects.toThrow(
      /no alpaca series under .*absent \(npm run bars:snapshot restores/,
    );
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

  it('primes an optional venue to an empty series set instead of throwing when it has none', async () => {
    directory = mkdtempSync(join(tmpdir(), 'v2-bars-'));
    const source = new ParquetBarsSource(join(directory, 'absent'), 'saxo', { optional: true });
    await expect(source.prime()).resolves.toBeUndefined();
    expect(source.load('ISF')).toBeUndefined();
  });
});

describe('MultiVenueBarsSource', () => {
  const alpaca = {
    load: (symbol: string) =>
      symbol === 'AAPL' || symbol === 'TSCO' ? series(symbol, 1, 1, 1) : undefined,
  };
  const saxo = {
    load: (symbol: string) =>
      symbol === 'ISF' || symbol === 'TSCO' ? series(symbol, 1, 2, 2) : undefined,
  };
  const bars = new MultiVenueBarsSource([alpaca, saxo]);

  it('serves a symbol from the one venue that holds it', () => {
    expect(bars.load('AAPL')).toEqual(series('AAPL', 1, 1, 1));
    expect(bars.load('ISF')).toEqual(series('ISF', 1, 2, 2));
    expect(bars.load('ZZZZ')).toBeUndefined();
  });

  it('serves no bars for a symbol two venues both hold, rather than one venue for the other (#1914)', () => {
    expect(bars.load('TSCO')).toBeUndefined();
    expect(new MultiVenueBarsSource([saxo, alpaca]).load('TSCO')).toBeUndefined();
  });

  it('fails a windowed read keyed on a clashing symbol closed', () => {
    const sessions = sessionsBefore(bars, '2026-09-03', 'AAPL');
    expect(sessions).toEqual(['2026-09-01']);
    expect(sessionsBefore(bars, '2026-09-03', 'TSCO')).toEqual([]);
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

describe('calendarReferenceFor', () => {
  it('reads saxo off ISF and every other venue off SPY', () => {
    expect(calendarReferenceFor('saxo')).toBe('ISF');
    expect(calendarReferenceFor('alpaca')).toBe('SPY');
  });
});

describe('window coverage against the SPY calendar (#1791)', () => {
  const spy = series('SPY', 25, 1, 1);
  const calendar = { load: (symbol: string) => (symbol === 'SPY' ? spy : undefined) };
  const sessions = sessionsBefore(calendar, '2026-09-26');
  const history = series('X', 25, 1, 1).bars;

  it('reads sessions strictly before the date and fails closed on a missing or stale reference', () => {
    expect(sessions).toHaveLength(25);
    expect(sessionsBefore(calendar, '2026-09-20').at(-1)).toBe('2026-09-19');
    expect(sessionsBefore(calendar, '2026-09-30')).toHaveLength(25);
    expect(sessionsBefore(calendar, '2026-10-01')).toEqual([]);
    expect(sessionsBefore({ load: () => undefined }, '2026-09-26')).toEqual([]);
    expect(windowCovered(history, [], 2)).toBe(false);
  });

  it('needs 95% of the window, a bar on the last session and a full window of bars', () => {
    expect(windowCovered(history, sessions, 20)).toBe(true);
    expect(
      windowCovered(
        history.filter((bar) => bar.date !== '2026-09-10'),
        sessions,
        20,
      ),
    ).toBe(true);
    const twoMissing = history.filter((bar) => !['2026-09-10', '2026-09-11'].includes(bar.date));
    expect(windowCovered(twoMissing, sessions, 20)).toBe(false);
    expect(windowCovered(history.slice(0, -1), sessions, 2)).toBe(false);
    expect(windowCovered(history.slice(-19), sessions, 19)).toBe(true);
    expect(windowCovered(history.slice(-19), sessions, 20)).toBe(false);
    expect(windowCovered(history, sessions, 26)).toBe(false);
  });

  it('reads sessions off a chosen reference symbol, not just SPY', () => {
    const isf = series('ISF', 25, 1, 1);
    const source = { load: (symbol: string) => (symbol === 'ISF' ? isf : undefined) };
    expect(sessionsBefore(source, '2026-09-26', 'ISF')).toHaveLength(25);
    expect(sessionsBefore(source, '2026-09-26')).toEqual([]);
  });

  it('ignores a bar on a date the calendar lacks', () => {
    const gapped = { symbol: 'SPY', bars: spy.bars.filter((bar) => bar.date !== '2026-09-24') };
    const withoutDay = sessionsBefore({ load: () => gapped }, '2026-09-26');
    expect(windowCovered(history, withoutDay, 2)).toBe(true);
  });
});
