import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { ParquetBarStore, SHAPE_REPAIR_MANIFEST_NOTE } from '../../../providers/bar-store/index.js';
import {
  countShapeViolations,
  planShapeRepairs,
  repairSaxoStore,
  updateManifest,
} from './repair-saxo-bar-shape.js';

const stores: ParquetBarStore[] = [];

afterAll(() => {
  for (const store of stores) store.close();
});

function ohlc(date: string, open: number, high: number, low: number, close: number): DailyBar {
  return { date, open, high, low, close, volume: 100, rawClose: close };
}

async function seedWithoutValidation(
  root: string,
  venue: string,
  series: readonly BarSeries[],
): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const db = await instance.connect();
  await db.run(
    'CREATE TABLE staged (venue VARCHAR, symbol VARCHAR, date VARCHAR, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, raw_close DOUBLE)',
  );
  const appender = await db.createAppender('staged');
  for (const one of series) {
    for (const bar of one.bars) {
      appender.appendVarchar(venue);
      appender.appendVarchar(one.symbol);
      appender.appendVarchar(bar.date);
      for (const value of [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.rawClose]) {
        appender.appendDouble(value);
      }
      appender.endRow();
    }
  }
  appender.closeSync();
  await db.run(
    `COPY (SELECT venue, symbol, CAST(year(CAST(date AS DATE)) AS INTEGER) AS year, CAST(date AS DATE) AS date, open, high, low, close, volume, raw_close FROM staged ORDER BY symbol, date) TO '${root}' (FORMAT parquet, PARTITION_BY (venue, symbol, year), OVERWRITE_OR_IGNORE)`,
  );
  db.closeSync();
  instance.closeSync();
}

const GLITCHED: BarSeries = {
  symbol: 'AAA',
  bars: [
    ohlc('2016-11-21', 17.4, 17.6, 17.2, 17.5),
    ohlc('2016-11-22', 17.5, 17.4, 17.3, 17.6),
    ohlc('2016-11-23', 17.49, 1750.25, 17.5, 17.365),
    ohlc('2016-11-24', 154.37, 97.73, 154.37, 154.37),
    ohlc('2016-11-25', 17.4, 17.7, 17.3, 17.6),
  ],
};
const CLEAN: BarSeries = {
  symbol: 'BBB',
  bars: [ohlc('2016-11-21', 5, 5.2, 4.9, 5.1), ohlc('2016-11-22', 5.1, 5.1, 5.1, 5.1)],
};
const ALPACA: BarSeries = { symbol: 'AAA', bars: [ohlc('2016-11-21', 9, 9.5, 8.9, 9.2)] };

function manifestFor(series: readonly BarSeries[]) {
  return {
    source: 'fixture',
    hygiene: 'weekend-dated and fetch-day bars dropped',
    window_start: '2016-11-22',
    window_binding_line: 'BBB',
    symbols: Object.fromEntries(
      series.map((one) => [
        one.symbol,
        {
          uic: 1,
          first: one.bars[0]?.date ?? '',
          last: one.bars[one.bars.length - 1]?.date ?? '',
          bars: one.bars.length,
          density: 1,
          hygiene: { dropped_dates: [], unit_breaks: [], holes: [] },
        },
      ]),
    ),
    excluded: {},
  };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'repair-saxo-'));
  const root = join(dir, 'parquet');
  await seedWithoutValidation(root, 'saxo', [GLITCHED, CLEAN]);
  await seedWithoutValidation(root, 'alpaca', [ALPACA]);
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifestFor([GLITCHED, CLEAN])));
  const store = await ParquetBarStore.open(root);
  stores.push(store);
  return { root, store, manifestPath };
}

function parquetBytes(root: string): string {
  return execFileSync('find', [root, '-name', '*.parquet', '-exec', 'shasum', '{}', '+'], {
    encoding: 'utf8',
  })
    .split('\n')
    .sort()
    .join('\n');
}

describe('planShapeRepairs', () => {
  it('repairs only the series that need it and counts what changed', () => {
    const plan = planShapeRepairs(
      new Map([
        ['AAA', GLITCHED],
        ['BBB', CLEAN],
      ]),
    );
    expect(plan.changed.map((one) => one.symbol)).toEqual(['AAA']);
    expect(plan.repairs).toHaveLength(1);
    expect(plan.repairs[0]).toMatchObject({
      symbol: 'AAA',
      report: {
        rescaled_fields: [{ date: '2016-11-23', field: 'high', factor: 0.01 }],
        dropped_glitch_dates: ['2016-11-24'],
        ranges_widened: 2,
      },
    });
  });

  it('plans nothing for a repaired series', () => {
    const first = planShapeRepairs(new Map([['AAA', GLITCHED]]));
    const second = planShapeRepairs(new Map(first.changed.map((one) => [one.symbol, one])));
    expect(second).toEqual({ changed: [], repairs: [] });
  });
});

describe('countShapeViolations', () => {
  it('counts bars with open or close outside the high-low range', () => {
    expect(countShapeViolations(new Map([['AAA', GLITCHED]]))).toBe(3);
    expect(countShapeViolations(new Map([['BBB', CLEAN]]))).toBe(0);
  });
});

describe('updateManifest', () => {
  it('refreshes the counts of a repaired line, records the repair and notes the hygiene step once', () => {
    const plan = planShapeRepairs(new Map([['AAA', GLITCHED]]));
    const manifest = manifestFor([GLITCHED, CLEAN]);
    const updated = updateManifest(manifest, plan.repairs, plan.changed);
    expect(updated.symbols.AAA).toMatchObject({
      first: '2016-11-21',
      last: '2016-11-25',
      bars: 4,
      hygiene: {
        dropped_dates: [],
        shape_repair: {
          rescaled_fields: [{ date: '2016-11-23', field: 'high', factor: 0.01 }],
          dropped_glitch_dates: ['2016-11-24'],
          ranges_widened: 2,
        },
      },
    });
    expect(updated.symbols.BBB).toEqual(manifest.symbols.BBB);
    expect(updated.hygiene).toBe(`${manifest.hygiene}; ${SHAPE_REPAIR_MANIFEST_NOTE}`);
    expect(updateManifest(updated, plan.repairs, plan.changed).hygiene).toBe(updated.hygiene);
  });

  it('moves the window start to the latest first bar when the binding line lost its first bar', () => {
    const series: BarSeries = {
      symbol: 'BBB',
      bars: [ohlc('2016-11-22', 5, 50, 4.9, 5.1), ohlc('2016-11-23', 5, 5.2, 4.9, 5.1)],
    };
    const plan = planShapeRepairs(new Map([['BBB', series]]));
    const updated = updateManifest(manifestFor([series]), plan.repairs, plan.changed);
    expect(updated.symbols.BBB?.first).toBe('2016-11-23');
    expect(updated.window_start).toBe('2016-11-23');
    expect(updated.window_binding_line).toBe('BBB');
  });

  it('refuses a repaired line the manifest does not list', () => {
    const plan = planShapeRepairs(new Map([['AAA', GLITCHED]]));
    expect(() => updateManifest(manifestFor([CLEAN]), plan.repairs, plan.changed)).toThrow(/AAA/);
  });
});

describe('repairSaxoStore', () => {
  it('repairs the stored Saxo series in place, refreshes the manifest and leaves other venues and clean series alone', async () => {
    const { store, manifestPath } = await fixture();
    const result = await repairSaxoStore(store, manifestPath);
    expect(result).toMatchObject({
      series: 2,
      repairedSymbols: ['AAA'],
      barsBefore: 7,
      barsAfter: 6,
      rescaledFields: 1,
      rangesWidened: 2,
      droppedBars: 1,
      violationsBefore: 3,
      violationsAfter: 0,
    });
    const saxo = await store.readVenue('saxo');
    expect(saxo.get('AAA')?.bars.map((bar) => bar.date)).toEqual([
      '2016-11-21',
      '2016-11-22',
      '2016-11-23',
      '2016-11-25',
    ]);
    expect(saxo.get('AAA')?.bars[2]).toEqual(ohlc('2016-11-23', 17.49, 17.5025, 17.365, 17.365));
    expect(saxo.get('AAA')?.bars[1]).toEqual(ohlc('2016-11-22', 17.5, 17.6, 17.3, 17.6));
    expect(saxo.get('BBB')).toEqual(CLEAN);
    expect((await store.readVenue('alpaca')).get('AAA')).toEqual(ALPACA);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.symbols.AAA.bars).toBe(4);
    expect(manifest.symbols.BBB.bars).toBe(2);
  });

  it('is idempotent: a second run changes no bytes and reports zeros', async () => {
    const { root, store, manifestPath } = await fixture();
    await repairSaxoStore(store, manifestPath);
    const parquetAfterFirst = parquetBytes(root);
    const manifestAfterFirst = readFileSync(manifestPath, 'utf8');
    const second = await repairSaxoStore(store, manifestPath);
    expect(second).toMatchObject({
      repairedSymbols: [],
      rescaledFields: 0,
      rangesWidened: 0,
      droppedBars: 0,
      violationsBefore: 0,
      violationsAfter: 0,
    });
    expect(parquetBytes(root)).toBe(parquetAfterFirst);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestAfterFirst);
  });

  it('runs without a manifest', async () => {
    const { store } = await fixture();
    const result = await repairSaxoStore(store, undefined);
    expect(result.repairedSymbols).toEqual(['AAA']);
  });
});
