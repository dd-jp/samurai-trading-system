import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import { ParquetBarStore } from './index.js';

const stores: ParquetBarStore[] = [];

afterAll(() => {
  for (const store of stores) store.close();
});

async function openStore(prefix = 'bar-store-'): Promise<{ store: ParquetBarStore; root: string }> {
  const root = join(mkdtempSync(join(tmpdir(), prefix)), 'parquet');
  const store = await ParquetBarStore.open(root);
  stores.push(store);
  return { store, root };
}

function bar(date: string, close: number, volume = 1_000): DailyBar {
  return {
    date,
    open: close * 0.99,
    high: close * 1.01,
    low: close * 0.98,
    close,
    volume,
    rawClose: close * 1.5,
  };
}

const BRK: BarSeries = {
  symbol: 'BRK.B',
  bars: [bar('2019-12-31', 228.1), bar('2020-01-02', 228.39, 2_561.25), bar('2021-01-04', 227.6)],
};
const SPY: BarSeries = {
  symbol: 'SPY',
  bars: [bar('2020-01-02', 1 / 3), bar('2020-01-03', 0.1 + 0.2)],
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.parquet'))
    .sort();
}

describe('ParquetBarStore', () => {
  it('round-trips bars exactly, dotted tickers and fractional volume included', async () => {
    const { store } = await openStore();
    await store.write('alpaca', [BRK, SPY]);
    const venue = await store.readVenue('alpaca');
    expect([...venue.keys()]).toEqual(['BRK.B', 'SPY']);
    expect(venue.get('BRK.B')).toEqual(BRK);
    expect(venue.get('SPY')).toEqual(SPY);
    expect(await store.readSeries('alpaca', 'SPY')).toEqual(SPY);
  });

  it('partitions by venue, symbol and year', async () => {
    const { store, root } = await openStore();
    await store.write('alpaca', [BRK]);
    expect(filesUnder(root)).toEqual([
      join('venue=alpaca', 'symbol=BRK.B', 'year=2019', 'data_0.parquet'),
      join('venue=alpaca', 'symbol=BRK.B', 'year=2020', 'data_0.parquet'),
      join('venue=alpaca', 'symbol=BRK.B', 'year=2021', 'data_0.parquet'),
    ]);
  });

  it('keeps venues apart and reports absent data as empty', async () => {
    const { store } = await openStore();
    expect(await store.readVenue('saxo')).toEqual(new Map());
    await store.write('saxo', [SPY]);
    expect(await store.readVenue('alpaca')).toEqual(new Map());
    expect(await store.readSeries('alpaca', 'SPY')).toBeUndefined();
    expect(await store.readSeries('saxo', 'ISF')).toBeUndefined();
    expect((await store.readVenue('saxo')).get('SPY')).toEqual(SPY);
  });

  it('reports an empty venue directory as empty rather than failing the read', async () => {
    const { store, root } = await openStore();
    mkdirSync(join(root, 'venue=alpaca'), { recursive: true });
    expect(await store.readVenue('alpaca')).toEqual(new Map());
  });

  it('replaces a rewritten symbol whole and leaves the others alone', async () => {
    const { store, root } = await openStore();
    await store.write('alpaca', [BRK, SPY]);
    const shorter: BarSeries = { symbol: 'BRK.B', bars: [bar('2021-01-05', 230)] };
    await store.write('alpaca', [shorter]);
    const venue = await store.readVenue('alpaca');
    expect(venue.get('BRK.B')).toEqual(shorter);
    expect(venue.get('SPY')).toEqual(SPY);
    expect(existsSync(join(root, 'venue=alpaca', 'symbol=BRK.B', 'year=2019'))).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith('.staging-'))).toEqual([]);
  });

  it('writes byte-identical files for the same bars', async () => {
    const a = await openStore();
    const b = await openStore();
    await a.store.write('alpaca', [BRK, SPY]);
    await b.store.write('alpaca', [SPY, BRK]);
    const files = filesUnder(a.root);
    expect(filesUnder(b.root)).toEqual(files);
    for (const file of files) {
      expect(readFileSync(join(b.root, file)).equals(readFileSync(join(a.root, file)))).toBe(true);
    }
  });

  // CPU-heavy: ~42 s under coverage at load 25
  it('writes one file per partition and reads back across chunks however many rows a write carries', {
    timeout: 180_000,
  }, async () => {
    const { store, root } = await openStore();
    const dates = Array.from({ length: 500 }, (_, day) =>
      new Date(Date.UTC(2019, 0, 1 + day)).toISOString().slice(0, 10),
    );
    const many = Array.from({ length: 1500 }, (_, index) => ({
      symbol: `S${index}`,
      bars: dates.map((date, day) => bar(date, 10 + index + day / 1000)),
    }));
    await store.write('alpaca', many);
    const files = filesUnder(root);
    expect(files).toHaveLength(3000);
    expect(files.every((file) => file.endsWith('data_0.parquet'))).toBe(true);
    expect(await store.readVenue('alpaca')).toEqual(new Map(many.map((one) => [one.symbol, one])));
  });

  it('handles a root path containing a quote', async () => {
    const { store } = await openStore("bar-store-o'brien-");
    await store.write('alpaca', [SPY]);
    expect(await store.readSeries('alpaca', 'SPY')).toEqual(SPY);
  });

  it('treats an empty write as a no-op', async () => {
    const { store, root } = await openStore();
    await store.write('alpaca', []);
    expect(existsSync(root)).toBe(false);
  });

  it.each([
    ['invalid venue', 'Alpaca', [SPY], /invalid venue/],
    ['invalid symbol', 'alpaca', [{ symbol: '../x', bars: SPY.bars }], /invalid symbol/],
    ['duplicate symbol', 'alpaca', [SPY, SPY], /SPY written twice/],
    ['empty series', 'alpaca', [{ symbol: 'SPY', bars: [] }], /no bars to write/],
    ['unsorted dates', 'alpaca', [{ symbol: 'SPY', bars: [...SPY.bars].reverse() }], /ascending/],
    [
      'zero close',
      'alpaca',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), close: 0 }] }],
      /price/,
    ],
    [
      'infinite high',
      'alpaca',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), high: Number.POSITIVE_INFINITY }] }],
      /price/,
    ],
    [
      'zero raw close',
      'alpaca',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), rawClose: 0 }] }],
      /price/,
    ],
    [
      'NaN volume',
      'alpaca',
      [{ symbol: 'SPY', bars: [bar('2020-01-02', 1, Number.NaN)] }],
      /volume/,
    ],
    ['negative volume', 'alpaca', [{ symbol: 'SPY', bars: [bar('2020-01-02', 1, -1)] }], /volume/],
    [
      'open above high',
      'alpaca',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), open: 1.02 }] }],
      /shape.*2020-01-02/,
    ],
    [
      'close above high',
      'saxo',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), close: 1.02 }] }],
      /shape/,
    ],
    [
      'open below low',
      'saxo',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), open: 0.97 }] }],
      /shape/,
    ],
    [
      'close below low',
      'alpaca',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), close: 0.97 }] }],
      /shape/,
    ],
    [
      'high below low',
      'saxo',
      [{ symbol: 'SPY', bars: [{ ...bar('2020-01-02', 1), high: 0.9, low: 1.1 }] }],
      /shape/,
    ],
  ] as const)('refuses %s and leaves the store untouched', async (_name, venue, series, error) => {
    const { store, root } = await openStore();
    await store.write('alpaca', [BRK]);
    const before = filesUnder(root);
    await expect(store.write(venue, series as readonly BarSeries[])).rejects.toThrow(error);
    expect(filesUnder(root)).toEqual(before);
    expect((await store.readVenue('alpaca')).get('BRK.B')).toEqual(BRK);
  });

  it('accepts bars whose open, high, low and close touch', async () => {
    const { store } = await openStore();
    const flat: DailyBar = {
      date: '2020-01-02',
      open: 5,
      high: 5,
      low: 5,
      close: 5,
      volume: 0,
      rawClose: 5,
    };
    const touching: DailyBar = { ...flat, date: '2020-01-03', open: 5, high: 5, low: 4, close: 4 };
    const series = { symbol: 'FLAT', bars: [flat, touching] };
    await store.write('saxo', [series]);
    expect(await store.readSeries('saxo', 'FLAT')).toEqual(series);
  });

  it('refuses invalid names on read', async () => {
    const { store } = await openStore();
    await expect(store.readVenue('../x')).rejects.toThrow(/invalid venue/);
    await expect(store.readSeries('alpaca', "S'")).rejects.toThrow(/invalid symbol/);
  });
});
