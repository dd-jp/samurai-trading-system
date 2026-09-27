import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import {
  AlpacaBarsApi,
  ParquetBarStore,
  type RawDailyBar,
} from '../../providers/bar-store/index.js';
import type { Logger } from '../../shared/index.js';
import { barRefreshFor, NO_BAR_REFRESH, refreshAlpacaBars } from './bar-refresh.js';

const stores: ParquetBarStore[] = [];
afterAll(() => {
  for (const store of stores) store.close();
});

async function openStore(): Promise<ParquetBarStore> {
  const root = join(mkdtempSync(join(tmpdir(), 'bar-refresh-')), 'parquet');
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

const rawBar = (t: string, c: number): RawDailyBar => ({ t, o: c, h: c, l: c, c, v: 1 });

interface SymbolFixture {
  readonly adjusted: readonly RawDailyBar[];
  readonly raw?: readonly RawDailyBar[];
}

function fakeApi(fixtures: Record<string, SymbolFixture>): AlpacaBarsApi {
  return new AlpacaBarsApi(
    { apiKey: 'k', apiSecret: 's' },
    async (url) => {
      const params = new URL(url).searchParams;
      const symbol = params.get('symbols') as string;
      const fixture = fixtures[symbol];
      if (fixture === undefined) return { status: 200, body: { bars: {} } };
      const bars =
        params.get('adjustment') === 'raw' ? (fixture.raw ?? fixture.adjusted) : fixture.adjusted;
      return { status: 200, body: { bars: { [symbol]: bars } } };
    },
    async () => {},
    0,
  );
}

function flat(dates: readonly string[], close: number): SymbolFixture {
  return { adjusted: dates.map((date) => rawBar(`${date}T05:00:00Z`, close)) };
}

function existingSeries(symbol: string, dates: readonly string[], close: number) {
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

const DATES = ['2016-01-04', '2016-01-05', '2016-01-06'];
const TRADING_DATE = '2016-01-07';

describe('refreshAlpacaBars', () => {
  it('refreshes SPY first, then the rest of the universe alphabetically', async () => {
    const store = await openStore();
    await store.write('alpaca', [existingSeries('MSFT', DATES, 100)]);
    const api = fakeApi({
      SPY: flat(DATES, 200),
      MSFT: flat(DATES, 100),
      ZTS: flat(DATES, 50),
    });
    const { logger } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['ZTS'],
      logger,
    });
    expect(report.updated.map((u) => u.symbol)).toEqual(['SPY', 'MSFT', 'ZTS']);
    expect(report.attempted).toBe(3);
    expect(report.failed).toEqual([]);
    expect(await store.readSeries('alpaca', 'ZTS')).toBeDefined();
  });

  it('rescales a unit break instead of failing, and logs it', async () => {
    const store = await openStore();
    const api = fakeApi({
      SPY: flat(DATES, 200),
      AAPL: {
        adjusted: [
          rawBar(`${DATES[0]}T05:00:00Z`, 100),
          rawBar(`${DATES[1]}T05:00:00Z`, 100),
          rawBar(`${DATES[2]}T05:00:00Z`, 10_000),
        ],
      },
    });
    const { logger, entries } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['AAPL'],
      logger,
    });
    const aapl = report.updated.find((u) => u.symbol === 'AAPL');
    expect(aapl?.unitBreaks).toBe(1);
    expect(entries.map((e) => e.event)).toContain('v2_bar_refresh_unit_break');
  });

  it('isolates a non-SPY hygiene failure and keeps refreshing the rest', async () => {
    const store = await openStore();
    const api = fakeApi({
      SPY: flat(DATES, 200),
      AAPL: {
        adjusted: [rawBar(`${DATES[0]}T05:00:00Z`, 100), rawBar(`${DATES[1]}T05:00:00Z`, 400)],
      },
      MSFT: flat(DATES, 50),
    });
    const { logger, entries } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['AAPL', 'MSFT'],
      logger,
    });
    expect(report.failed).toEqual([{ symbol: 'AAPL', reason: expect.stringMatching(/data hole/) }]);
    expect(report.updated.map((u) => u.symbol)).toEqual(['SPY', 'MSFT']);
    const failure = entries.find((e) => e.event === 'v2_bar_refresh_failed');
    expect(failure).toMatchObject({
      trace_id: 'v2-bar-refresh',
      stage: 'v2',
      level: 'warn',
      message: expect.stringMatching(/^AAPL: .*data hole/),
    });
  });

  it('records symbols with no Alpaca data as no-new-bars instead of failing', async () => {
    const store = await openStore();
    const api = fakeApi({ SPY: flat(DATES, 200) });
    const { logger } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['DELISTED'],
      logger,
    });
    expect(report.noNewBars).toEqual(['DELISTED']);
    expect(report.failed).toEqual([]);
  });

  it('treats an all-dropped response as no new bars, not a write', async () => {
    const store = await openStore();
    const api = fakeApi({
      SPY: flat(DATES, 200),
      AAPL: flat([TRADING_DATE], 100),
    });
    const { logger } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['AAPL'],
      logger,
    });
    expect(report.noNewBars).toContain('AAPL');
    expect(report.failed).toEqual([]);
    expect(await store.readSeries('alpaca', 'AAPL')).toBeUndefined();
  });

  it('does not gate a non-SPY name on freshness, only SPY', async () => {
    const store = await openStore();
    const staleTradingDate = '2016-01-20';
    const api = fakeApi({
      SPY: flat(['2016-01-18', '2016-01-19'], 200),
      AAPL: flat(DATES, 100),
    });
    const { logger } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: staleTradingDate,
      constituents: ['AAPL'],
      logger,
    });
    expect(report.failed).toEqual([]);
    expect(report.updated.map((u) => u.symbol)).toEqual(['SPY', 'AAPL']);
  });

  it('refuses a same-start response shorter than the stored history (paused pagination)', async () => {
    const store = await openStore();
    await store.write('alpaca', [existingSeries('AAPL', DATES, 90)]);
    const api = fakeApi({
      SPY: flat(DATES, 200),
      AAPL: flat(DATES.slice(0, 2), 100),
    });
    const { logger } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['AAPL'],
      logger,
    });
    expect(report.failed).toEqual([
      {
        symbol: 'AAPL',
        reason:
          'AAPL: refresh would shrink history (had 3 bars from 2016-01-04, got 2 from 2016-01-04) — refusing to overwrite',
      },
    ]);
    expect((await store.readSeries('alpaca', 'AAPL'))?.bars.map((b) => b.date)).toEqual(DATES);
  });

  it('refuses a same-length response starting later than the stored history (truncated head)', async () => {
    const store = await openStore();
    await store.write('alpaca', [existingSeries('AAPL', DATES, 90)]);
    const laterDates = ['2016-01-05', '2016-01-06', '2016-01-07'];
    const laterTradingDate = '2016-01-08';
    const api = fakeApi({
      SPY: flat(laterDates, 200),
      AAPL: flat(laterDates, 100),
    });
    const { logger } = recorder();
    const report = await refreshAlpacaBars({
      api,
      store,
      tradingDate: laterTradingDate,
      constituents: ['AAPL'],
      logger,
    });
    expect(report.failed).toEqual([
      {
        symbol: 'AAPL',
        reason:
          'AAPL: refresh would shrink history (had 3 bars from 2016-01-04, got 3 from 2016-01-05) — refusing to overwrite',
      },
    ]);
    expect((await store.readSeries('alpaca', 'AAPL'))?.bars.map((b) => b.date)).toEqual(DATES);
  });

  it('aborts the run when SPY is still stale after refresh', async () => {
    const store = await openStore();
    const api = fakeApi({ SPY: flat(DATES, 200) });
    const { logger } = recorder();
    await expect(
      refreshAlpacaBars({ api, store, tradingDate: '2016-02-01', constituents: [], logger }),
    ).rejects.toThrow(
      'v2 bar refresh: SPY still stale after refresh (last bar 2016-01-06, trading date 2016-02-01)',
    );
  });

  it('logs the summary event with trace_id, stage and exact counts', async () => {
    const store = await openStore();
    const api = fakeApi({ SPY: flat(DATES, 200), MSFT: flat(DATES, 50) });
    const { logger, entries } = recorder();
    await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['MSFT', 'DELISTED'],
      logger,
    });
    const summary = entries.find((e) => e.event === 'v2_bar_refresh_summary');
    expect(summary).toMatchObject({
      trace_id: 'v2-bar-refresh',
      stage: 'v2',
      level: 'info',
      message: 'refreshed 2/3 symbols, 1 unchanged, 0 failed',
    });
  });

  it('does not log a unit-break event when there are none', async () => {
    const store = await openStore();
    const api = fakeApi({ SPY: flat(DATES, 200), MSFT: flat(DATES, 50) });
    const { logger, entries } = recorder();
    await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['MSFT'],
      logger,
    });
    expect(entries.map((e) => e.event)).not.toContain('v2_bar_refresh_unit_break');
  });

  it('logs the unit-break event with the exact symbol and count', async () => {
    const store = await openStore();
    const api = fakeApi({
      SPY: flat(DATES, 200),
      AAPL: {
        adjusted: [
          rawBar(`${DATES[0]}T05:00:00Z`, 100),
          rawBar(`${DATES[1]}T05:00:00Z`, 100),
          rawBar(`${DATES[2]}T05:00:00Z`, 10_000),
        ],
      },
    });
    const { logger, entries } = recorder();
    await refreshAlpacaBars({
      api,
      store,
      tradingDate: TRADING_DATE,
      constituents: ['AAPL'],
      logger,
    });
    const unitBreak = entries.find((e) => e.event === 'v2_bar_refresh_unit_break');
    expect(unitBreak).toMatchObject({
      trace_id: 'v2-bar-refresh',
      stage: 'v2',
      level: 'warn',
      message: 'AAPL: 1 unit break(s) normalised',
    });
  });
});

describe('NO_BAR_REFRESH', () => {
  it('resolves an empty report', async () => {
    await expect(NO_BAR_REFRESH.run()).resolves.toEqual({
      attempted: 0,
      updated: [],
      noNewBars: [],
      failed: [],
    });
  });
});

describe('barRefreshFor', () => {
  it('is a no-op on a dry run, without reading constituents or credentials', () => {
    expect(barRefreshFor(true, {}, TRADING_DATE, '/does/not/exist.csv', recorder().logger)).toBe(
      NO_BAR_REFRESH,
    );
  });

  it('refuses synchronously without Alpaca credentials', () => {
    expect(() =>
      barRefreshFor(false, {}, TRADING_DATE, '/does/not/exist.csv', recorder().logger),
    ).toThrow(/ALPACA_API_KEY and ALPACA_API_SECRET must be set/);
  });

  it('refuses synchronously when the constituents file is missing', () => {
    const env = { ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' };
    expect(() =>
      barRefreshFor(false, env, TRADING_DATE, '/does/not/exist.csv', recorder().logger),
    ).toThrow(/ENOENT/);
  });

  it('reads the constituents file for the trading date and builds a runnable refresh', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bar-refresh-csv-')), 'constituents.csv');
    writeFileSync(path, 'date,tickers\n2016-01-01,"AAPL,MSFT"\n');
    const env = { ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' };
    const refresh = barRefreshFor(false, env, TRADING_DATE, path, recorder().logger);
    expect(refresh).not.toBe(NO_BAR_REFRESH);
    expect(typeof refresh.run).toBe('function');
  });
});
