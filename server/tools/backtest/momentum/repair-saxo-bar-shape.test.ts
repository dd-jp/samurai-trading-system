import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { ParquetBarStore, SHAPE_REPAIR_MANIFEST_NOTE } from '../../../providers/bar-store/index.js';
import { seedWithoutValidation } from '../../__fixtures__/seed-unvalidated.js';
import {
  countShapeViolations,
  planShapeRepairs,
  repairFromArgs,
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
const WIDEN_ONLY: BarSeries = {
  symbol: 'CCC',
  bars: [ohlc('2016-11-21', 8, 8.1, 8.2, 8.05)],
};
const RESCALE_ONLY: BarSeries = {
  symbol: 'DDD',
  bars: [ohlc('2016-11-21', 10, 1000, 9.9, 9.95)],
};
const DROP_ONLY: BarSeries = {
  symbol: 'EEE',
  bars: [
    ohlc('2016-11-21', 10, 10.5, 9.8, 10.2),
    ohlc('2016-11-22', 10, 10, 6.5, 10),
    ohlc('2016-11-23', 6.8, 6.8, 6.8, 6.8),
  ],
};
const REPLACE_ONLY: BarSeries = {
  symbol: 'FFF',
  bars: [ohlc('2016-11-21', 10, 12, 10, 10)],
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
  await seedWithoutValidation(root, 'saxo', [GLITCHED, CLEAN, WIDEN_ONLY]);
  await seedWithoutValidation(root, 'alpaca', [ALPACA]);
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifestFor([GLITCHED, CLEAN, WIDEN_ONLY])));
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
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      symbol: 'AAA',
      report: {
        rescaled_fields: [{ date: '2016-11-23', field: 'high', factor: 0.01 }],
        dropped_glitch_dates: ['2016-11-24'],
        ranges_widened: 2,
      },
    });
  });

  it('counts a rescale alone, a drop alone and a neighbour replacement alone as a change', () => {
    const plan = planShapeRepairs(
      new Map([
        ['DDD', RESCALE_ONLY],
        ['EEE', DROP_ONLY],
        ['FFF', REPLACE_ONLY],
      ]),
    );
    expect(plan.map((repair) => repair.report)).toEqual([
      {
        rescaled_fields: [{ date: '2016-11-21', field: 'high', factor: 0.01 }],
        neighbour_repairs: [],
        dropped_glitch_dates: [],
        ranges_widened: 0,
      },
      {
        rescaled_fields: [],
        neighbour_repairs: [],
        dropped_glitch_dates: ['2016-11-22'],
        ranges_widened: 0,
      },
      {
        rescaled_fields: [],
        neighbour_repairs: [{ date: '2016-11-21', field: 'high' }],
        dropped_glitch_dates: [],
        ranges_widened: 0,
      },
    ]);
    expect(plan.map((repair) => repair.repaired.bars.length)).toEqual([1, 2, 1]);
  });

  it('plans nothing for a repaired series', () => {
    const first = planShapeRepairs(new Map([['AAA', GLITCHED]]));
    const second = planShapeRepairs(
      new Map(first.map((repair) => [repair.symbol, repair.repaired])),
    );
    expect(second).toEqual([]);
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
    const updated = updateManifest(manifest, plan);
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
    expect(updated.symbols.BBB).toEqual({
      ...manifest.symbols.BBB,
      hygiene: {
        ...manifest.symbols.BBB?.hygiene,
        shape_repair: {
          rescaled_fields: [],
          neighbour_repairs: [],
          dropped_glitch_dates: [],
          ranges_widened: 0,
        },
      },
    });
    expect(updated.hygiene).toBe(`${manifest.hygiene}; ${SHAPE_REPAIR_MANIFEST_NOTE}`);
    expect(updateManifest(updated, plan).hygiene).toBe(updated.hygiene);
  });

  it('moves the window start to the latest first bar when the binding line lost its first bar', () => {
    const series: BarSeries = {
      symbol: 'BBB',
      bars: [ohlc('2016-11-22', 5, 5, 3.3, 5), ohlc('2016-11-23', 3.5, 3.5, 3.5, 3.5)],
    };
    const plan = planShapeRepairs(new Map([['BBB', series]]));
    const updated = updateManifest(manifestFor([series]), plan);
    expect(updated.symbols.BBB?.first).toBe('2016-11-23');
    expect(updated.window_start).toBe('2016-11-23');
    expect(updated.window_binding_line).toBe('BBB');
  });

  it('gives every line a shape_repair and replaces a stale note instead of appending a second one', () => {
    const stale = {
      ...manifestFor([CLEAN]),
      hygiene: `weekend-dated bars dropped; then the bar shape is repaired because an old rule (#1838): per-line counts in symbols.<TIDM>.hygiene.shape_repair`,
    };
    const refreshed = updateManifest(stale, []);
    expect(refreshed.hygiene).toBe(`weekend-dated bars dropped; ${SHAPE_REPAIR_MANIFEST_NOTE}`);
    expect(refreshed.symbols.BBB).toMatchObject({
      hygiene: {
        shape_repair: {
          rescaled_fields: [],
          neighbour_repairs: [],
          dropped_glitch_dates: [],
          ranges_widened: 0,
        },
      },
    });
    expect(updateManifest(refreshed, [])).toEqual(refreshed);
  });

  it('keeps the counts an earlier repair recorded and adds a later one without repeating a replayed entry', () => {
    const base = manifestFor([REPLACE_ONLY]);
    const earlier = {
      rescaled_fields: [{ date: '2016-01-04', field: 'low' as const, factor: 100 as const }],
      dropped_glitch_dates: ['2016-01-05'],
      ranges_widened: 7,
    };
    const manifest = {
      ...base,
      symbols: {
        FFF: {
          ...base.symbols.FFF,
          hygiene: { ...base.symbols.FFF?.hygiene, shape_repair: earlier },
        },
      },
    };
    const plan = planShapeRepairs(new Map([['FFF', REPLACE_ONLY]]));
    const expected = {
      rescaled_fields: earlier.rescaled_fields,
      neighbour_repairs: [{ date: '2016-11-21', field: 'high' }],
      dropped_glitch_dates: ['2016-01-05'],
      ranges_widened: 7,
    };
    const once = updateManifest(manifest, plan);
    expect(once.symbols.FFF?.hygiene.shape_repair).toEqual(expected);
    expect(updateManifest(once, plan).symbols.FFF?.hygiene.shape_repair).toEqual(expected);
  });

  it('refuses a repaired line the manifest does not list', () => {
    const plan = planShapeRepairs(new Map([['AAA', GLITCHED]]));
    expect(() => updateManifest(manifestFor([CLEAN]), plan)).toThrow(/AAA/);
  });
});

describe('repairFromArgs', () => {
  it('repairs the store and manifest it is pointed at and formats the manifest once', async () => {
    const { root, manifestPath } = await fixture();
    const formatted: string[] = [];
    const first = await repairFromArgs(['--store', root, '--manifest', manifestPath], (path) =>
      formatted.push(path),
    );
    expect(first.repairedSymbols).toEqual(['AAA', 'CCC']);
    expect(formatted).toEqual([manifestPath]);
    const second = await repairFromArgs(['--store', root, '--manifest', manifestPath], (path) =>
      formatted.push(path),
    );
    expect(second.repairedSymbols).toEqual([]);
    expect(formatted).toHaveLength(1);
  });

  it('refreshes a manifest that lags a clean store and formats it once', async () => {
    const { root, manifestPath } = await fixture();
    const formatted: string[] = [];
    await repairFromArgs(['--store', root, '--manifest', manifestPath], () => {});
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.hygiene = 'weekend-dated and fetch-day bars dropped';
    delete manifest.symbols.BBB.hygiene.shape_repair;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await repairFromArgs(['--store', root, '--manifest', manifestPath], (path) =>
      formatted.push(path),
    );
    expect(result).toMatchObject({ repairedSymbols: [], manifestUpdated: true });
    expect(formatted).toEqual([manifestPath]);
    const refreshed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(refreshed.symbols.BBB.hygiene.shape_repair.ranges_widened).toBe(0);
    expect(refreshed.hygiene.endsWith(SHAPE_REPAIR_MANIFEST_NOTE)).toBe(true);
  });

  it('refuses a flag it does not know', async () => {
    await expect(repairFromArgs(['--stroe', 'x'], () => {})).rejects.toThrow(/stroe/);
  });
});

describe('repairSaxoStore', () => {
  it('repairs the stored Saxo series in place, refreshes the manifest and leaves other venues and clean series alone', async () => {
    const { store, manifestPath } = await fixture();
    const result = await repairSaxoStore(store, manifestPath);
    expect(result).toMatchObject({
      series: 3,
      repairedSymbols: ['AAA', 'CCC'],
      barsBefore: 8,
      barsAfter: 7,
      rescaledFields: 1,
      rangesWidened: 3,
      droppedBars: 1,
      droppedDates: { AAA: ['2016-11-24'] },
      violationsBefore: 4,
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

  it('brings the manifest in line with the bars when the first run died after the parquet write', async () => {
    const { root, store, manifestPath } = await fixture();
    const realWrite = store.write.bind(store);
    const crash = vi.spyOn(store, 'write').mockImplementationOnce(async (venue, series) => {
      await realWrite(venue, series);
      throw new Error('crash');
    });
    await expect(repairSaxoStore(store, manifestPath)).rejects.toThrow('crash');
    crash.mockRestore();
    expect(countShapeViolations(await store.readVenue('saxo'))).toBe(0);
    await repairSaxoStore(store, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.symbols.AAA.bars).toBe(4);
    expect(manifest.hygiene.split(SHAPE_REPAIR_MANIFEST_NOTE)).toHaveLength(2);
    const settled = parquetBytes(root);
    await repairSaxoStore(store, manifestPath);
    expect(parquetBytes(root)).toBe(settled);
  });

  it('runs without a manifest', async () => {
    const { store } = await fixture();
    const result = await repairSaxoStore(store, undefined);
    expect(result.repairedSymbols).toEqual(['AAA', 'CCC']);
  });
});
