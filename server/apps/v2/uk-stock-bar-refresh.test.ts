import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ParquetBarStore } from '../../providers/bar-store/index.js';
import {
  type ChartPage,
  type ChartSample,
  SAXO_CHART_PAGE,
} from '../../providers/saxo-bars/index.js';
import type { Logger } from '../../shared/index.js';
import {
  type CfdCatalogue,
  MultiVenueBarsSource,
  ParquetBarsSource,
  parseCfdCatalogue,
} from './data/index.js';
import {
  type UkStockBarsApi,
  ukStockBarLines,
  ukStockBarRefreshFor,
} from './uk-stock-bar-refresh.js';

const stores: ParquetBarStore[] = [];
afterAll(() => {
  for (const store of stores) store.close();
});

const TRADING_DATE = '2026-09-25';
const DATES = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];

function recorder() {
  const entries: Parameters<Logger['log']>[0][] = [];
  const logger: Logger = { log: (entry) => void entries.push(entry) };
  return { entries, logger };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface Row {
  readonly symbol: string;
  readonly uic: number;
  readonly bid?: number | undefined;
  readonly ask?: number | undefined;
  readonly averageVolume30Days?: number;
  readonly currency?: 'GBP' | 'USD';
  readonly priceToContractFactor?: number;
}

function ukRow(symbol: string, uic: number, overrides: Partial<Row> = {}): Row {
  return { symbol, uic, bid: 5, ask: 5.01, averageVolume30Days: 10_000_000, ...overrides };
}

function catalogueOf(rows: readonly Row[], asOf: string = TRADING_DATE): CfdCatalogue {
  return parseCfdCatalogue(
    JSON.stringify({
      asOf,
      instruments: rows.map((row) => ({
        symbol: row.symbol,
        saxoSymbol: `${row.symbol}:xlon`,
        uic: row.uic,
        assetType: 'CfdOnStock',
        currency: row.currency ?? 'GBP',
        priceToContractFactor: row.priceToContractFactor ?? 0.01,
        tradable: true,
        shortTradeDisabled: false,
        borrowCostPerDay: null,
        bid: row.bid,
        ask: row.ask,
        averageVolume30Days: row.averageVolume30Days,
      })),
    }),
  );
}

function pencePage(
  dates: readonly string[],
  pence: number,
  revised: Readonly<Record<string, number>> = {},
): ChartPage {
  const samples: ChartSample[] = dates.map((date) => {
    const price = revised[date] ?? pence;
    return {
      Time: `${date}T00:00:00.000000Z`,
      Open: price,
      High: price,
      Low: price,
      Close: price,
      Volume: 1_000,
    };
  });
  return { firstSampleTime: undefined, delayedByMinutes: 15, samples };
}

function weekdaysEndingOn(last: string, count: number): string[] {
  const dates: string[] = [];
  const day = new Date(`${last}T00:00:00Z`);
  while (dates.length < count) {
    if (day.getUTCDay() % 6 !== 0) dates.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return dates;
}

type PageFor = (uic: number) => Promise<ChartPage>;

function recordingApi(pageFor: PageFor) {
  const calls: [number, string][] = [];
  const api: UkStockBarsApi = {
    dailyPage: (uic, assetType) => {
      calls.push([uic, assetType]);
      return pageFor(uic);
    },
  };
  return { api, calls };
}

async function runLeg(
  rows: readonly Row[],
  pageFor: PageFor,
  options: { root?: string; catalogue?: CfdCatalogue | undefined } = {},
) {
  const root = options.root ?? join(tempDir('uk-stock-bars-'), 'parquet');
  const { entries, logger } = recorder();
  const { api, calls } = recordingApi(pageFor);
  const stopped: string[] = [];
  const catalogue = 'catalogue' in options ? options.catalogue : catalogueOf(rows);
  const report = await ukStockBarRefreshFor({}, TRADING_DATE, logger, {
    storeRoot: root,
    tokenPath: join(tempDir('uk-stock-bars-token-'), 'live.json'),
    catalogue: () => catalogue,
    connect: () => ({ api, stop: async () => void stopped.push('stop') }),
  }).run();
  return { report, entries, calls, stopped, root };
}

async function storedCloses(root: string, symbol: string): Promise<[string, number][]> {
  const store = await ParquetBarStore.open(root);
  stores.push(store);
  return ((await store.readSeries('saxo', symbol))?.bars ?? []).map((bar) => [bar.date, bar.close]);
}

describe('ukStockBarLines', () => {
  it('pools the UK stocks that pass the price and ADV screens, whatever their spread', () => {
    const catalogue = catalogueOf([
      ukRow('RR_XLON', 1),
      ukRow('WIDE_XLON', 2, { bid: 2, ask: 2.02 }),
      ukRow('THIN_XLON', 3, { averageVolume30Days: 100 }),
      ukRow('PENNY_XLON', 4, { bid: 0.5, ask: 0.501 }),
      ukRow('NOQUOTE_XLON', 5, { bid: undefined, ask: undefined }),
      ukRow('AAPL', 6, { currency: 'USD', priceToContractFactor: 1 }),
    ]);
    const { entries, logger } = recorder();
    const lines = ukStockBarLines(
      catalogue,
      TRADING_DATE,
      recordingApi(async () => pencePage([], 1)).api,
      logger,
    );
    expect(lines.map((line) => [line.tidm, line.pageStartMoves])).toEqual([
      ['RR_XLON', true],
      ['WIDE_XLON', true],
    ]);
    expect(entries.map((entry) => [entry.event, entry.message])).toEqual([
      [
        'v2_uk_stock_bar_pool',
        `2 UK stock CFDs pass the price and ADV screens in the ${TRADING_DATE} catalogue; pulling their bars`,
      ],
    ]);
  });

  it('refuses a missing catalogue and one too old for the trading date', () => {
    const { api } = recordingApi(async () => pencePage([], 1));
    const { logger } = recorder();
    expect(() => ukStockBarLines(undefined, TRADING_DATE, api, logger)).toThrow(
      `no CFD catalogue fresh on ${TRADING_DATE}`,
    );
    const old = catalogueOf([ukRow('RR_XLON', 1)], '2026-09-21');
    expect(() => ukStockBarLines(old, TRADING_DATE, api, logger)).toThrow(
      `no CFD catalogue fresh on ${TRADING_DATE}`,
    );
  });
});

describe('ukStockBarRefreshFor', () => {
  it('pulls one CfdOnStock page per pooled name and stores its pence closes in pounds', async () => {
    const { report, calls, stopped, root, entries } = await runLeg(
      [ukRow('RR_XLON', 11), ukRow('VOD_XLON', 12, { priceToContractFactor: 1 })],
      async (uic) => pencePage(DATES, uic === 11 ? 450 : 7),
    );
    expect(report.failed).toEqual([]);
    expect(calls).toEqual([
      [11, 'CfdOnStock'],
      [12, 'CfdOnStock'],
    ]);
    expect(report.updated.map((updated) => [updated.symbol, updated.bars])).toEqual([
      ['RR_XLON', 4],
      ['VOD_XLON', 4],
    ]);
    expect(stopped).toEqual(['stop']);
    expect((await storedCloses(root, 'RR_XLON')).map(([, close]) => close)).toEqual([
      4.5, 4.5, 4.5, 4.5,
    ]);
    expect((await storedCloses(root, 'VOD_XLON')).map(([, close]) => close)).toEqual([7, 7, 7, 7]);
    expect(entries.map((entry) => entry.event)).not.toContain('v2_saxo_line_unguarded');
    expect(entries.at(-1)?.message).toBe('refreshed 2/2 UK stock CFD bars, 0 failed');
  });

  it('serves the stored series to the sleeves read path, and an unpulled name as absent', async () => {
    const { root } = await runLeg([ukRow('RR_XLON', 11)], async () => pencePage(DATES, 450));
    const alpaca = new ParquetBarsSource(root, 'alpaca', { optional: true });
    const saxo = new ParquetBarsSource(root, 'saxo');
    await alpaca.prime();
    await saxo.prime();
    const bars = new MultiVenueBarsSource([alpaca, saxo]);
    expect(bars.load('RR_XLON')?.bars.map((bar) => bar.date)).toEqual(DATES);
    expect(bars.load('VOD_XLON')).toBeUndefined();
  });

  it('keeps the stored bars older than the page start when the page rolls forward', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const { root } = await runLeg(rows, async () => pencePage(['2026-09-18', ...DATES], 450));
    const { report } = await runLeg(rows, async () => pencePage(DATES, 450), { root });
    expect(report.failed).toEqual([]);
    expect(report.updated.map((updated) => updated.bars)).toEqual([5]);
    expect((await storedCloses(root, 'RR_XLON')).map(([date]) => date)).toEqual([
      '2026-09-18',
      ...DATES,
    ]);
  });

  it('accepts a page whose first bar is one the stored copy lacks', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const { root } = await runLeg(rows, async () => pencePage(DATES.slice(1), 450));
    const { report } = await runLeg(rows, async () => pencePage(DATES, 450), { root });
    expect(report.failed).toEqual([]);
    expect((await storedCloses(root, 'RR_XLON')).map(([date]) => date)).toEqual(DATES);
  });

  it('keeps a history longer than a Saxo page and refuses a page truncated against it', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const history = weekdaysEndingOn('2026-09-24', SAXO_CHART_PAGE + 10);
    const { root } = await runLeg(rows, async () => pencePage(history, 450));
    const { report: full } = await runLeg(
      rows,
      async () => pencePage(history.slice(-SAXO_CHART_PAGE), 450),
      { root },
    );
    expect(full.failed).toEqual([]);
    expect((await storedCloses(root, 'RR_XLON')).map(([date]) => date)).toEqual(history);
    const { report: truncated } = await runLeg(
      rows,
      async () => pencePage(history.slice(-(SAXO_CHART_PAGE - 6)), 450),
      { root },
    );
    expect(truncated.failed.map((failed) => failed.reason)).toEqual([
      expect.stringContaining(
        `the Saxo page is truncated (${SAXO_CHART_PAGE - 6} samples where ${SAXO_CHART_PAGE} were expected)`,
      ),
    ]);
  });

  it('refuses a page more than five bars short of a stored history under a page long', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const seeded = weekdaysEndingOn('2026-09-24', 18);
    const { root } = await runLeg(rows, async () => pencePage(seeded, 450));
    const { report: short } = await runLeg(rows, async () => pencePage(seeded.slice(-12), 450), {
      root,
    });
    expect(short.failed.map((failed) => failed.reason)).toEqual([
      expect.stringContaining('the Saxo page is truncated (12 samples where 18 were expected)'),
    ]);
    const { report: slack } = await runLeg(rows, async () => pencePage(seeded.slice(-13), 450), {
      root,
    });
    expect(slack.failed).toEqual([]);
    expect((await storedCloses(root, 'RR_XLON')).map(([date]) => date)).toEqual(seeded);
  });

  it('still refuses a page that drops a stored bar inside it', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const { root } = await runLeg(rows, async () => pencePage(DATES, 450));
    const gapped = [DATES[0], DATES[2], DATES[3]] as string[];
    const { report } = await runLeg(rows, async () => pencePage(gapped, 450), { root });
    expect(report.failed.map((failed) => failed.reason)).toEqual([
      expect.stringContaining('drops stored bar(s) 2026-09-22'),
    ]);
    expect((await storedCloses(root, 'RR_XLON')).map(([date]) => date)).toEqual(DATES);
  });

  it('refuses a page that revises a stored close inside it', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const { root } = await runLeg(rows, async () => pencePage(['2026-09-18', ...DATES], 450));
    const { report } = await runLeg(
      rows,
      async () => pencePage(DATES, 450, { '2026-09-22': 460 }),
      { root },
    );
    expect(report.failed.map((failed) => failed.reason)).toEqual([
      expect.stringContaining('revises stored close(s) by more than 0.5%: 2026-09-22 4.5 to 4.6'),
    ]);
  });

  it('refuses a page Saxo rewrote while older stored bars keep the old scale', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const { root } = await runLeg(rows, async () => pencePage(['2026-09-18', ...DATES], 450));
    const { report } = await runLeg(rows, async () => pencePage(DATES, 900), { root });
    expect(report.failed.map((failed) => failed.reason)).toEqual([
      expect.stringContaining('the Saxo page rewrites the stored bars by 0.5x; refusing to write'),
    ]);
    expect((await storedCloses(root, 'RR_XLON')).map(([, close]) => close)).toEqual([
      4.5, 4.5, 4.5, 4.5, 4.5,
    ]);
  });

  it('refuses a page that shares no bar with the stored history', async () => {
    const rows = [ukRow('RR_XLON', 11)];
    const { root } = await runLeg(rows, async () => pencePage(DATES.slice(0, 2), 450));
    const { report } = await runLeg(rows, async () => pencePage(DATES.slice(2), 450), { root });
    expect(report.failed.map((failed) => failed.reason)).toEqual([
      expect.stringContaining('the Saxo page starts at 2026-09-23, after every stored bar'),
    ]);
  });

  it('fails a name whose catalogue unit is neither GBX nor GBP, and pulls nothing for it', async () => {
    const { report, calls } = await runLeg(
      [ukRow('ODD_XLON', 21, { priceToContractFactor: 0.1 })],
      async () => pencePage(DATES, 450),
    );
    expect(calls).toEqual([]);
    expect(report.failed).toEqual([
      {
        symbol: 'ODD_XLON',
        reason: 'ODD_XLON: GBP at PriceToContractFactor 0.1 is not a GBX or GBP quote',
      },
    ]);
  });

  it('stops after five failures in a row, and a success resets the count', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ukRow(`N${i}_XLON`, 100 + i));
    const fails = new Set([100, 101, 102, 103, 105, 106, 107, 108, 109, 110, 111]);
    const { report, calls, entries } = await runLeg(rows, async (uic) => {
      if (fails.has(uic)) throw new Error('Saxo chart: malformed sample {"Time":"x"}');
      return pencePage(DATES, 450);
    });
    expect(calls.map(([uic]) => uic)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(report.updated.map((updated) => updated.symbol)).toEqual(['N4_XLON']);
    expect(report.failed).toHaveLength(9);
    expect(entries.filter((entry) => entry.event === 'v2_bar_refresh_stopped')).toEqual([
      expect.objectContaining({
        level: 'warn',
        message:
          'stopped refreshing UK stock CFD bars after 5 failures in a row; the rest keep their stored bars',
      }),
    ]);
  });

  it('reports the leg unavailable and stops the session when no fresh catalogue is on disk', async () => {
    const { report, calls, stopped, entries } = await runLeg(
      [],
      async () => pencePage(DATES, 450),
      {
        catalogue: undefined,
      },
    );
    expect(calls).toEqual([]);
    expect(stopped).toEqual(['stop']);
    expect(report.failed).toEqual([
      { symbol: 'saxo', reason: `no CFD catalogue fresh on ${TRADING_DATE}` },
    ]);
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ['v2_uk_stock_bar_refresh_unavailable', 'warn'],
    ]);
    expect(entries[0]?.message).toBe(
      `UK stock CFD bars not refreshed (no CFD catalogue fresh on ${TRADING_DATE}); UK stock reads keep the last stored bars and fail closed once they go stale`,
    );
  });
});
