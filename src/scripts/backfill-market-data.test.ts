import {
  type Bar,
  type BarWindow,
  type DataSource,
  type Mark,
  MarketDataServiceImpl,
  type Quote,
  SqliteMarketDataStore,
  timeframeToMs,
} from '../market-data-service/index.js';
import { DEFAULT_UNIVERSE, type UniverseInstrument } from '../orchestrator/index.js';
import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { backfillMarketData, WARM_START_WINDOWS } from './backfill-market-data.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}
  now(): Date {
    return this.time;
  }
}

/**
 * `count` synthetic bars ending at the START of `asOf`'s current bar
 * interval — i.e. the latest bar's close_time is exactly
 * `floor(asOf/ms) * ms`, which is what makes a freshly-warmed store pass
 * `MarketDataServiceImpl`'s store-recency freshness check (service.ts
 * "Route 2: store recency (#512)"). This is the same shape a real venue
 * response has: the most recent COMPLETE bar closes at the start of the
 * still-forming current interval.
 */
function generateBars(instrument: string, timeframe: string, asOf: Date, count: number): Bar[] {
  const ms = timeframeToMs(timeframe);
  const lastCloseMs = Math.floor(asOf.getTime() / ms) * ms;
  const bars: Bar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const closeMs = lastCloseMs - i * ms;
    bars.push({
      instrument,
      timeframe,
      open_time: new Date(closeMs - ms),
      close_time: new Date(closeMs),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      source: 'fixture',
    });
  }
  return bars;
}

const ASOF = new Date('2026-08-07T12:30:00Z');

function buildDeps(overrides: Partial<Parameters<typeof backfillMarketData>[0]> = {}) {
  const db = openSharedStore(':memory:');
  const store = new SqliteMarketDataStore(db);
  const equityFetches: { symbol: string; window: BarWindow }[] = [];
  const cryptoFetches: { symbol: string; window: BarWindow }[] = [];

  const deps = {
    store,
    asOf: ASOF,
    universe: DEFAULT_UNIVERSE,
    windows: WARM_START_WINDOWS,
    fetchEquityBars: async (symbol: string, window: BarWindow, at: Date) => {
      equityFetches.push({ symbol, window });
      return generateBars(symbol, window.timeframe, at, window.lookback);
    },
    fetchCryptoBars: async (symbol: string, window: BarWindow, at: Date) => {
      cryptoFetches.push({ symbol, window });
      return generateBars(symbol, window.timeframe, at, window.lookback);
    },
    print: () => {},
    ...overrides,
  };

  return { deps, store, equityFetches, cryptoFetches };
}

describe('backfillMarketData', () => {
  it('fetches and fills every (instrument, window) pair from an empty store', async () => {
    const { deps, equityFetches, cryptoFetches } = buildDeps();

    const coverage = await backfillMarketData(deps);

    expect(coverage).toHaveLength(DEFAULT_UNIVERSE.length * WARM_START_WINDOWS.length);
    expect(coverage.every((row) => row.satisfied)).toBe(true);
    // 4 equities x 2 windows, 2 crypto x 2 windows.
    expect(equityFetches).toHaveLength(8);
    expect(cryptoFetches).toHaveLength(4);
  });

  it('routes stocks to fetchEquityBars and crypto to fetchCryptoBars', async () => {
    const { deps, equityFetches, cryptoFetches } = buildDeps();
    await backfillMarketData(deps);

    expect([...new Set(equityFetches.map((f) => f.symbol))].sort()).toEqual([
      'AAPL',
      'QQQ',
      'SPY',
      'TSLA',
    ]);
    expect([...new Set(cryptoFetches.map((f) => f.symbol))].sort()).toEqual(['BTC-USD', 'ETH-USD']);
  });

  it('is idempotent — a second run against an already-warm store makes no fetch calls', async () => {
    const { deps, equityFetches, cryptoFetches } = buildDeps();
    await backfillMarketData(deps);
    equityFetches.length = 0;
    cryptoFetches.length = 0;

    const coverage = await backfillMarketData(deps);

    expect(equityFetches).toHaveLength(0);
    expect(cryptoFetches).toHaveLength(0);
    expect(coverage.every((row) => row.satisfied)).toBe(true);
  });

  it('is resumable — only fetches the pairs a prior partial run left short', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);
    // Simulate a prior run that completed SPY's 1h window only.
    store.appendBars(generateBars('SPY', '1h', ASOF, 20));

    const equityFetches: { symbol: string; window: BarWindow }[] = [];
    const cryptoFetches: { symbol: string; window: BarWindow }[] = [];
    const coverage = await backfillMarketData({
      store,
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) => {
        equityFetches.push({ symbol, window });
        return generateBars(symbol, window.timeframe, at, window.lookback);
      },
      fetchCryptoBars: async (symbol, window, at) => {
        cryptoFetches.push({ symbol, window });
        return generateBars(symbol, window.timeframe, at, window.lookback);
      },
      print: () => {},
    });

    // SPY/1h was already warm and must not be re-fetched.
    expect(equityFetches.some((f) => f.symbol === 'SPY' && f.window.timeframe === '1h')).toBe(
      false,
    );
    // SPY/1d and every other pair were still missing and must be fetched.
    expect(equityFetches.some((f) => f.symbol === 'SPY' && f.window.timeframe === '1d')).toBe(true);
    expect(coverage.every((row) => row.satisfied)).toBe(true);
  });

  it('never double-writes a bar on re-run — appendBars is INSERT OR IGNORE on the PK', async () => {
    const { deps, store } = buildDeps();
    await backfillMarketData(deps);
    await backfillMarketData(deps); // re-run, should be a no-op fetch-wise (idempotent test above) and a no-op write-wise here

    const rows = store.readBars('SPY', '1h', ASOF, 1000);
    expect(rows).toHaveLength(20); // not 40
  });

  it('reports first bar / last bar / row count per (instrument, timeframe)', async () => {
    const { deps } = buildDeps();
    const coverage = await backfillMarketData(deps);

    const spy1h = coverage.find((row) => row.instrument === 'SPY' && row.timeframe === '1h');
    expect(spy1h).toMatchObject({ rows: 20, required: 20, satisfied: true });
    expect(spy1h?.first_bar).toBeDefined();
    expect(spy1h?.last_bar).toBeDefined();
    if (spy1h?.first_bar === undefined || spy1h?.last_bar === undefined) {
      throw new Error('expected first_bar/last_bar to be defined');
    }
    expect(new Date(spy1h.first_bar).getTime()).toBeLessThan(new Date(spy1h.last_bar).getTime());
  });

  it('marks a pair unsatisfied and does not silently under-report when the fetcher returns fewer bars than required', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

    const coverage = await backfillMarketData({
      store,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) => generateBars(symbol, window.timeframe, at, 5), // short
      fetchCryptoBars: async () => [],
      print: () => {},
    });

    expect(coverage).toEqual([
      expect.objectContaining({ instrument: 'SPY', timeframe: '1h', rows: 5, satisfied: false }),
    ]);
  });

  it('turns a thrown fetch into a SHORT row and keeps going — one bad pair does not abort the run', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);
    const fetchedInstruments: string[] = [];

    const coverage = await backfillMarketData({
      store,
      universe: [
        { asset: 'SPY', asset_class: 'stocks' },
        { asset: 'QQQ', asset_class: 'stocks' },
      ] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) => {
        fetchedInstruments.push(symbol);
        if (symbol === 'SPY') {
          throw new Error('AlpacaDataUnderfetchError: SPY 1h requested 20 received 3');
        }
        return generateBars(symbol, window.timeframe, at, window.lookback);
      },
      fetchCryptoBars: async () => [],
      print: () => {},
    });

    // Both pairs were attempted — SPY's throw did not stop QQQ from running.
    expect(fetchedInstruments).toEqual(['SPY', 'QQQ']);
    expect(coverage).toEqual([
      expect.objectContaining({
        instrument: 'SPY',
        timeframe: '1h',
        rows: 0,
        satisfied: false,
        error: expect.stringContaining('AlpacaDataUnderfetchError') as string,
      }),
      expect.objectContaining({
        instrument: 'QQQ',
        timeframe: '1h',
        rows: 20,
        satisfied: true,
        error: undefined,
      }),
    ]);
  });

  it('reports the bars a partially-successful append durably wrote, not the pre-fetch count', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

    // `appendBars` writes per bar (`INSERT OR IGNORE`), so a throw partway
    // through leaves the earlier bars durably stored. Reporting `existing`
    // here would say 0 rows while the store actually holds 12, sending the
    // operator back to re-fetch bars already on disk.
    const partiallyAppending = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'appendBars') {
          return (bars: Bar[]) => {
            target.appendBars(bars.slice(0, 12));
            throw new Error('SqliteError: database is locked');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const coverage = await backfillMarketData({
      store: partiallyAppending,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) =>
        generateBars(symbol, window.timeframe, at, window.lookback),
      fetchCryptoBars: async () => [],
      print: () => {},
    });

    expect(coverage).toEqual([
      expect.objectContaining({
        instrument: 'SPY',
        timeframe: '1h',
        // The 12 that landed, NOT the 0 the store held before the attempt.
        rows: 12,
        satisfied: false,
        error: expect.stringContaining('database is locked') as string,
      }),
    ]);
  });
});

/**
 * The AC 5 proof: "a warm first tick over the full universe issues no bar
 * HTTP calls beyond the current interval's forming bar." Uses
 * `WARM_START_WINDOWS`/`DEFAULT_UNIVERSE` — the DERIVED list — not a
 * hand-picked timeframe, and a fresh `MarketDataServiceImpl` instance (empty
 * `lastBarFetch`, exactly what a newly started orchestrator process
 * constructs) reading the store `backfillMarketData` just warmed.
 */
describe('warm-start payoff (#512 AC: no bar HTTP calls on a warm first tick)', () => {
  class CountingDataSource implements DataSource {
    fetches = 0;
    async fetchBars(_instrument: string, _window: BarWindow, _asOf: Date): Promise<Bar[]> {
      this.fetches += 1;
      return [];
    }
    async fetchMark(_instrument: string, asOf: Date): Promise<Mark> {
      return { price: 0, observed_at: asOf, asset_class: 'stocks', source: 'counting' };
    }
    async fetchQuote(_instrument: string, _asOf: Date): Promise<Quote | null> {
      return null;
    }
  }

  it('a fresh MarketDataServiceImpl serves every DEFAULT_UNIVERSE instrument, at every derived window, with zero fetchBars calls', async () => {
    const { deps, store } = buildDeps();
    await backfillMarketData(deps);

    // A few minutes later, still inside the same 1h/1d interval as ASOF.
    const tickAsOf = new Date(ASOF.getTime() + 5 * 60_000);
    const source = new CountingDataSource();
    // Fresh instance: empty lastBarFetch, the same as a newly started process.
    const service = new MarketDataServiceImpl(source, new ManualClock(tickAsOf), 'live', store);

    for (const instrument of DEFAULT_UNIVERSE) {
      for (const window of WARM_START_WINDOWS) {
        const bars = await service.getBars(instrument.asset, window, tickAsOf);
        expect(bars).toHaveLength(window.lookback);
      }
    }

    expect(source.fetches).toBe(0);
  });

  it('RED CHECK: the same scenario against an UNWARMED store does make fetchBars calls', async () => {
    // Sanity check that the zero-fetch result above is the backfill's doing,
    // not an artifact of the test harness.
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);
    const tickAsOf = new Date(ASOF.getTime() + 5 * 60_000);
    const source = new CountingDataSource();
    const service = new MarketDataServiceImpl(source, new ManualClock(tickAsOf), 'live', store);
    const [firstInstrument] = DEFAULT_UNIVERSE;
    const [firstWindow] = WARM_START_WINDOWS;
    if (firstInstrument === undefined || firstWindow === undefined) {
      throw new Error('expected DEFAULT_UNIVERSE and WARM_START_WINDOWS to be non-empty');
    }

    await service.getBars(firstInstrument.asset, firstWindow, tickAsOf);

    expect(source.fetches).toBe(1);
  });
});
