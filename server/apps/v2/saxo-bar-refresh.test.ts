import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import {
  type ChartSample,
  type InstrumentDetails,
  isSpliced,
  LSE_MOMENTUM_LINES,
  type SaxoLine,
} from '../../providers/saxo-bars/index.js';
import type { Logger } from '../../shared/index.js';
import {
  historyRescaleFactor,
  refreshSaxoBars,
  saxoBarRefreshFor,
  saxoRefreshLines,
} from './saxo-bar-refresh.js';
import { LSE_LINES } from './signal/index.js';

const stores: ParquetBarStore[] = [];
afterAll(() => {
  for (const store of stores) store.close();
});

function storeRoot(): string {
  return join(mkdtempSync(join(tmpdir(), 'saxo-bar-refresh-')), 'parquet');
}

async function openStore(root: string = storeRoot()): Promise<ParquetBarStore> {
  const store = await ParquetBarStore.open(root);
  stores.push(store);
  return store;
}

function recorder() {
  const entries: Parameters<Logger['log']>[0][] = [];
  const logger: Logger = {
    log: (entry) => {
      entries.push(entry);
    },
  };
  return { entries, logger };
}

function line(tidm: string): SaxoLine {
  const found = LSE_MOMENTUM_LINES.find((candidate) => candidate.tidm === tidm);
  if (found === undefined) throw new Error(`no line ${tidm}`);
  return found;
}

const ISF = line('ISF');
const VMID = line('VMID');
const CUKS = line('CUKS');

interface Fixture {
  readonly samples: readonly ChartSample[];
  readonly priceToContractFactor?: number;
}

function quoted(saxoLine: SaxoLine, gbp: number): number {
  return saxoLine.unit === 'GBX' ? gbp * 100 : gbp;
}

function samplesFor(saxoLine: SaxoLine, closes: Record<string, number>): ChartSample[] {
  return Object.entries(closes).map(([date, gbp]) => {
    const price = quoted(saxoLine, gbp);
    return {
      Time: `${date}T00:00:00.000000Z`,
      Open: price,
      High: price,
      Low: price,
      Close: price,
      Volume: 1,
    };
  });
}

function fakeApi(fixtures: Record<string, Fixture>) {
  const byUic = new Map(
    LSE_MOMENTUM_LINES.flatMap((saxoLine) => {
      const fixture = fixtures[saxoLine.tidm];
      return fixture === undefined ? [] : [[saxoLine.uic, { saxoLine, fixture }] as const];
    }),
  );
  return {
    instrumentDetails: async (uic: number): Promise<InstrumentDetails> => {
      const entry = byUic.get(uic);
      const unit = entry?.saxoLine.unit;
      return {
        symbol: entry?.saxoLine.tidm ?? '',
        currencyCode: unit ?? '',
        priceToContractFactor: entry?.fixture.priceToContractFactor ?? (unit === 'GBX' ? 0.01 : 1),
        isTradable: true,
        isComplex: false,
        exchangeId: 'LSE_ETF',
      };
    },
    dailyHistory: async (uic: number) => ({
      firstSampleTime: undefined,
      delayedByMinutes: 15,
      samples: [...(byUic.get(uic)?.fixture.samples ?? [])],
    }),
  };
}

function closes(dates: readonly string[], value: number): Record<string, number> {
  return Object.fromEntries(dates.map((date) => [date, value]));
}

function storedSeries(symbol: string, dates: readonly string[], close: number): BarSeries {
  const bars: DailyBar[] = dates.map((date) => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    rawClose: close,
  }));
  return { symbol, bars };
}

const DATES = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
const TRADING_DATE = '2026-09-25';

async function refresh(
  store: ParquetBarStore,
  fixtures: Record<string, Fixture>,
  lines: readonly SaxoLine[] = [ISF, VMID],
  tradingDate: string = TRADING_DATE,
) {
  const { entries, logger } = recorder();
  const report = await refreshSaxoBars({
    api: fakeApi(fixtures),
    store,
    tradingDate,
    lines,
    logger,
  });
  return { report, entries };
}

describe('refreshSaxoBars', () => {
  it('re-pulls each line in order and writes GBP prices to the saxo venue', async () => {
    const store = await openStore();
    const { report } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)) },
      VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
    });
    expect(report.attempted).toBe(2);
    expect(report.updated.map((u) => [u.symbol, u.bars])).toEqual([
      ['ISF', 4],
      ['VMID', 4],
    ]);
    expect(report.failed).toEqual([]);
    const isf = await store.readSeries('saxo', 'ISF');
    expect(isf?.bars.map((b) => b.close)).toEqual([8.5, 8.5, 8.5, 8.5]);
    expect(isf?.bars.map((b) => b.rawClose)).toEqual([8.5, 8.5, 8.5, 8.5]);
    expect((await store.readSeries('saxo', 'VMID'))?.bars[0]?.close).toBe(30);
  });

  it('drops the fetch-day bar and weekend bars', async () => {
    const store = await openStore();
    await refresh(store, {
      ISF: {
        samples: samplesFor(ISF, {
          ...closes(DATES, 8.5),
          '2026-09-19': 8.5,
          [TRADING_DATE]: 8.6,
        }),
      },
      VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
    });
    expect((await store.readSeries('saxo', 'ISF'))?.bars.map((b) => b.date)).toEqual(DATES);
  });

  it('replaces the whole series after a split, leaving no price step in the history', async () => {
    const store = await openStore();
    const preSplit = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
    await store.write('saxo', [storedSeries('ISF', preSplit, 100)]);
    const adjustedHistory = closes(preSplit, 10);
    const postSplit = { '2026-09-21': 10.1, '2026-09-22': 10.2, '2026-09-23': 10.15 };
    const { report, entries } = await refresh(
      store,
      {
        ISF: { samples: samplesFor(ISF, { ...adjustedHistory, ...postSplit }) },
        VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
      },
      [ISF, VMID],
      '2026-09-24',
    );
    expect(report.failed).toEqual([]);
    const series = await store.readSeries('saxo', 'ISF');
    const closesAfter = series?.bars.map((b) => b.close) ?? [];
    expect(closesAfter).toEqual([10, 10, 10, 10, 10.1, 10.2, 10.15]);
    const steps = closesAfter.slice(1).map((close, index) => close / (closesAfter[index] ?? 1));
    expect(Math.max(...steps)).toBeLessThan(1.05);
    expect(Math.min(...steps)).toBeGreaterThan(0.95);
    const warning = entries.find((entry) => entry.event === 'v2_saxo_history_rescaled');
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toMatch(/^ISF: .*by 10x/);
  });

  it('does not warn when the re-pull reproduces the stored history', async () => {
    const store = await openStore();
    await store.write('saxo', [storedSeries('ISF', DATES, 8.5)]);
    const { entries } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)) },
      VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
    });
    expect(entries.map((entry) => entry.event)).not.toContain('v2_saxo_history_rescaled');
  });

  it('refuses a response shorter than the stored history and leaves the store untouched', async () => {
    const store = await openStore();
    await store.write('saxo', [storedSeries('VMID', DATES, 29)]);
    const { report, entries } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)) },
      VMID: { samples: samplesFor(VMID, closes(DATES.slice(0, 3), 30)) },
    });
    expect(report.failed).toEqual([
      {
        symbol: 'VMID',
        reason:
          'VMID: refresh would shrink history (had 4 bars from 2026-09-21, got 3 from 2026-09-21) — refusing to overwrite',
      },
    ]);
    expect(entries.some((entry) => entry.event === 'v2_bar_refresh_failed')).toBe(true);
    expect((await store.readSeries('saxo', 'VMID'))?.bars.map((b) => b.close)).toEqual([
      29, 29, 29, 29,
    ]);
  });

  it('refuses a response that starts later than the stored history', async () => {
    const store = await openStore();
    await store.write('saxo', [storedSeries('VMID', DATES, 29)]);
    const later = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
    const { report } = await refresh(
      store,
      {
        ISF: { samples: samplesFor(ISF, closes(later, 8.5)) },
        VMID: { samples: samplesFor(VMID, closes(later, 30)) },
      },
      [ISF, VMID],
      '2026-09-26',
    );
    expect(report.failed.map((f) => f.symbol)).toEqual(['VMID']);
    expect((await store.readSeries('saxo', 'VMID'))?.bars[0]?.date).toBe('2026-09-21');
  });

  it('fails a line Saxo returns no bars for, instead of treating it as unchanged', async () => {
    const store = await openStore();
    const { report } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)) },
      VMID: { samples: [] },
    });
    expect(report.failed).toEqual([{ symbol: 'VMID', reason: 'VMID: Saxo returned no bars' }]);
    expect(report.noNewBars).toEqual([]);
    expect(await store.readSeries('saxo', 'VMID')).toBeUndefined();
  });

  it('fails a line whose only bars are dropped by hygiene', async () => {
    const store = await openStore();
    const { report } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)) },
      VMID: { samples: samplesFor(VMID, { [TRADING_DATE]: 30 }) },
    });
    expect(report.failed).toEqual([{ symbol: 'VMID', reason: 'VMID: Saxo returned no bars' }]);
  });

  it('isolates a unit mismatch to its own line', async () => {
    const store = await openStore();
    const { report } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)), priceToContractFactor: 1 },
      VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
    });
    expect(report.failed).toEqual([
      { symbol: 'ISF', reason: expect.stringMatching(/PriceToContractFactor is 1/) },
    ]);
    expect(report.updated.map((u) => u.symbol)).toEqual(['VMID']);
    expect(await store.readSeries('saxo', 'ISF')).toBeUndefined();
  });

  it('isolates a hygiene refusal to its own line', async () => {
    const store = await openStore();
    const { report } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, { '2026-09-21': 8.5, '2026-09-22': 85 }) },
      VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
    });
    expect(report.failed).toEqual([{ symbol: 'ISF', reason: expect.stringMatching(/data hole/) }]);
    expect(report.updated.map((u) => u.symbol)).toEqual(['VMID']);
  });

  it('reports a line still stale after the refresh as failed, without stopping the rest', async () => {
    const store = await openStore();
    const { report } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(['2026-09-10', '2026-09-11'], 8.5)) },
      VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
    });
    expect(report.failed).toEqual([
      {
        symbol: 'ISF',
        reason: `ISF: last bar 2026-09-11 is stale for trading date ${TRADING_DATE} after refresh`,
      },
    ]);
    expect(report.updated.map((u) => u.symbol)).toEqual(['VMID']);
    expect((await store.readSeries('saxo', 'ISF'))?.bars.at(-1)?.date).toBe('2026-09-11');
  });

  it('logs a summary', async () => {
    const store = await openStore();
    const { entries } = await refresh(store, {
      ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)) },
      VMID: { samples: samplesFor(VMID, closes(DATES, 30)) },
    });
    const summary = entries.find((entry) => entry.event === 'v2_saxo_bar_refresh_summary');
    expect(summary).toMatchObject({
      level: 'info',
      message: 'refreshed 2/2 Saxo lines, 0 failed',
    });
  });

  it('refuses a spliced line rather than skipping its splice', async () => {
    const store = await openStore();
    const spliced = LSE_MOMENTUM_LINES.find((candidate) => candidate.tidm === 'IHCU');
    if (spliced === undefined) throw new Error('no spliced line in the list');
    const { report } = await refresh(store, {}, [spliced]);
    expect(report.failed).toEqual([
      { symbol: 'IHCU', reason: expect.stringMatching(/spliced from a USD sibling/) },
    ]);
  });

  it('treats a CUKS-style zero-volume bar like any other bar', async () => {
    const store = await openStore();
    const { report } = await refresh(
      store,
      {
        ISF: { samples: samplesFor(ISF, closes(DATES, 8.5)) },
        CUKS: {
          samples: samplesFor(CUKS, closes(DATES, 5)).map((sample) => ({ ...sample, Volume: 0 })),
        },
      },
      [ISF, CUKS],
    );
    expect(report.failed).toEqual([]);
    expect((await store.readSeries('saxo', 'CUKS'))?.bars.map((b) => b.volume)).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe('saxoRefreshLines', () => {
  it('covers exactly the 22 v2 LSE lines, ISF first, none spliced', () => {
    const lines = saxoRefreshLines();
    expect(lines.map((l) => l.tidm)).toEqual(LSE_LINES.map((l) => l.tidm));
    expect(lines[0]?.tidm).toBe('ISF');
    expect(lines.filter(isSpliced)).toEqual([]);
  });
});

describe('historyRescaleFactor', () => {
  const series = (closesByDate: Record<string, number>): BarSeries => ({
    symbol: 'X',
    bars: Object.entries(closesByDate).map(([date, close]) => ({
      date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
      rawClose: close,
    })),
  });

  it('is undefined when the overlap is unchanged', () => {
    expect(historyRescaleFactor(series({ a: 10, b: 10 }), series({ a: 10, b: 10 }).bars)).toBe(
      undefined,
    );
  });

  it('is undefined for ordinary revisions inside tolerance', () => {
    expect(historyRescaleFactor(series({ a: 10, b: 10 }), series({ a: 10.2, b: 9.9 }).bars)).toBe(
      undefined,
    );
  });

  it('reports the old-to-new ratio when the whole overlap is rescaled', () => {
    expect(
      historyRescaleFactor(series({ a: 100, b: 100, c: 50 }), series({ a: 10, b: 10, c: 10 }).bars),
    ).toBe(10);
  });

  it('takes the median so one revised bar does not trigger it', () => {
    expect(
      historyRescaleFactor(series({ a: 10, b: 10, c: 10 }), series({ a: 10, b: 10, c: 1 }).bars),
    ).toBe(undefined);
  });

  it('sorts the ratios before taking the median', () => {
    expect(
      historyRescaleFactor(series({ a: 10, b: 100, c: 10 }), series({ a: 10, b: 10, c: 10 }).bars),
    ).toBe(undefined);
  });

  it('averages the two middle ratios of an even overlap', () => {
    expect(historyRescaleFactor(series({ a: 10, b: 30 }), series({ a: 10, b: 10 }).bars)).toBe(2);
  });

  it('flags a factor just outside tolerance and not one just inside', () => {
    expect(historyRescaleFactor(series({ a: 106 }), series({ a: 100 }).bars)).toBe(1.06);
    expect(historyRescaleFactor(series({ a: 104 }), series({ a: 100 }).bars)).toBe(undefined);
    expect(historyRescaleFactor(series({ a: 94 }), series({ a: 100 }).bars)).toBe(0.94);
    expect(historyRescaleFactor(series({ a: 96 }), series({ a: 100 }).bars)).toBe(undefined);
  });

  it('skips a replaced bar whose close is zero', () => {
    expect(historyRescaleFactor(series({ a: 10, b: 10 }), series({ a: 0, b: 10 }).bars)).toBe(
      undefined,
    );
  });

  it('is undefined with no overlapping dates', () => {
    expect(historyRescaleFactor(series({ a: 10 }), series({ b: 1 }).bars)).toBe(undefined);
  });

  it('reports a reverse split as a factor below one', () => {
    expect(historyRescaleFactor(series({ a: 1, b: 1 }), series({ a: 10, b: 10 }).bars)).toBe(0.1);
  });
});

describe('saxoBarRefreshFor', () => {
  const stopped: string[] = [];
  const connectWith = (fixtures: Record<string, Fixture>) => () => ({
    api: fakeApi(fixtures),
    stop: async () => {
      stopped.push('stop');
    },
  });

  it('refreshes every v2 LSE line with ISF first, then stops the session', async () => {
    const root = storeRoot();
    const store = await openStore(root);
    const fixtures = Object.fromEntries(
      LSE_LINES.map(({ tidm }) => {
        const saxoLine = line(tidm);
        return [tidm, { samples: samplesFor(saxoLine, closes(DATES, 10)) }];
      }),
    );
    const { logger } = recorder();
    stopped.length = 0;
    const report = await saxoBarRefreshFor({}, TRADING_DATE, logger, {
      storeRoot: root,
      connect: connectWith(fixtures),
    }).run();
    expect(report.failed).toEqual([]);
    expect(report.updated).toHaveLength(22);
    expect(report.updated[0]?.symbol).toBe('ISF');
    expect(stopped).toEqual(['stop']);
    expect((await store.readVenue('saxo')).size).toBe(22);
  });

  it('stops the session and reports the venue unavailable when the stored bars cannot be read', async () => {
    const root = storeRoot();
    const corrupt = join(root, 'venue=saxo', 'symbol=ISF', 'year=2026');
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, 'data_0.parquet'), 'not parquet');
    const { entries, logger } = recorder();
    stopped.length = 0;
    const report = await saxoBarRefreshFor({}, TRADING_DATE, logger, {
      storeRoot: root,
      connect: connectWith({}),
    }).run();
    expect(report.failed.map((f) => f.symbol)).toEqual(['saxo']);
    expect(stopped).toEqual(['stop']);
    expect(entries.map((entry) => entry.event)).toEqual(['v2_saxo_bar_refresh_unavailable']);
  });

  it('reports the venue as unavailable when the session cannot open, without throwing', async () => {
    const { entries, logger } = recorder();
    const report = await saxoBarRefreshFor({}, TRADING_DATE, logger, {
      storeRoot: storeRoot(),
      connect: () => {
        throw new Error('Saxo token dead, needs `npm run saxo:login` (expired)');
      },
    }).run();
    expect(report).toEqual({
      attempted: 1,
      updated: [],
      noNewBars: [],
      failed: [{ symbol: 'saxo', reason: 'Saxo token dead, needs `npm run saxo:login` (expired)' }],
    });
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'v2_saxo_bar_refresh_unavailable',
        level: 'warn',
        message: expect.stringContaining('npm run saxo:login'),
      }),
    ]);
  });
});
