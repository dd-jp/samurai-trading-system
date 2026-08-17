import { DEFAULT_UNIVERSE, type UniverseInstrument } from '../apps/orchestrator/index.js';
import {
  type Bar,
  type BarWindow,
  type DataSource,
  type Mark,
  MarketDataServiceImpl,
  type Quote,
  SqliteMarketDataStore,
  timeframeToMs,
} from '../providers/market-data-service/index.js';
import { withOhlcvFailover } from '../providers/market-data-service/sources/ohlcv-failover.js';
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

/**
 * The derived `1h` depth, read from `WARM_START_WINDOWS` rather than repeated
 * as a literal: #722 moved it from 20 to 57 (the technical analyst's converged
 * RSI warm-up), and three assertions here silently pinned the old number.
 */
const HOURLY_WARM_START = ((): number => {
  const window = WARM_START_WINDOWS.find((candidate) => candidate.timeframe === '1h');
  if (window === undefined) throw new Error('expected a 1h window in WARM_START_WINDOWS');
  return window.lookback;
})();

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

/**
 * #738: `DEFAULT_UNIVERSE` no longer carries any crypto row — crypto is out
 * of Samurai's scope (ADR-0014 amendment), and the default this CLI tool
 * warms is equities-only now. The crypto routing (`fetchCryptoBars`) itself
 * is untouched code, still reachable for a caller that passes a universe
 * with a crypto instrument in it — `MIXED_UNIVERSE` below is exactly that,
 * used only by the routing test, so the DEFAULT-universe test reflects what
 * `DEFAULT_UNIVERSE` actually resolves to.
 */
const MIXED_UNIVERSE: readonly UniverseInstrument[] = [
  ...DEFAULT_UNIVERSE,
  { asset: 'BTC-USD', asset_class: 'crypto' },
  { asset: 'ETH-USD', asset_class: 'crypto' },
];

describe('backfillMarketData', () => {
  it('fetches and fills every (instrument, window) pair from an empty store', async () => {
    const { deps, equityFetches, cryptoFetches } = buildDeps();

    const coverage = await backfillMarketData(deps);

    expect(coverage).toHaveLength(DEFAULT_UNIVERSE.length * WARM_START_WINDOWS.length);
    expect(coverage.every((row) => row.satisfied)).toBe(true);
    // 4 equities x WARM_START_WINDOWS.length windows, 0 crypto — DEFAULT_UNIVERSE
    // is equities-only since #738. Derived from WARM_START_WINDOWS.length
    // rather than a literal so this doesn't rot the next time that list
    // gains/loses a timeframe (#742 added '5m').
    expect(equityFetches).toHaveLength(4 * WARM_START_WINDOWS.length);
    expect(cryptoFetches).toHaveLength(0);
  });

  it('routes stocks to fetchEquityBars and crypto to fetchCryptoBars', async () => {
    const { deps, equityFetches, cryptoFetches } = buildDeps({ universe: MIXED_UNIVERSE });
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
    store.appendBars(generateBars('SPY', '1h', ASOF, HOURLY_WARM_START));

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
    expect(rows).toHaveLength(HOURLY_WARM_START); // not twice that
  });

  it('reports first bar / last bar / row count per (instrument, timeframe)', async () => {
    const { deps } = buildDeps();
    const coverage = await backfillMarketData(deps);

    const spy1h = coverage.find((row) => row.instrument === 'SPY' && row.timeframe === '1h');
    expect(spy1h).toMatchObject({
      rows: HOURLY_WARM_START,
      required: HOURLY_WARM_START,
      satisfied: true,
    });
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

  it('keeps going and says coverage may be wrong when the re-read ALSO fails', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

    // A SQLITE_BUSY that spans the append and the re-read immediately after
    // it, then clears — the transient contention the guard is written for.
    // The re-read inside the catch is therefore the second failure in a row,
    // and it must not throw out of the handler: that would abort QQQ, which
    // is the whole reason the catch is there.
    //
    // Deliberately transient, not permanent. `backfillMarketData` reads the
    // store once per pair BEFORE the try block, to decide whether a fetch is
    // needed at all, and that read is unguarded on purpose: a store that
    // cannot be read is not a partial-coverage problem to be reported, it is
    // a dead backfill, and it should abort loudly rather than print a table
    // of zeroes. Modelling a permanent failure here would assert on that
    // separate (and correct) behaviour instead of on this fallback.
    let storeIsBusy = false;
    const failingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'appendBars') {
          return () => {
            storeIsBusy = true;
            throw new Error('SqliteError: database is locked');
          };
        }
        if (property === 'readBars') {
          return (...args: Parameters<SqliteMarketDataStore['readBars']>) => {
            if (storeIsBusy) {
              storeIsBusy = false;
              throw new Error('SqliteError: database is locked');
            }
            return target.readBars(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const attempted: string[] = [];
    const coverage = await backfillMarketData({
      store: failingStore,
      universe: [
        { asset: 'SPY', asset_class: 'stocks' },
        { asset: 'QQQ', asset_class: 'stocks' },
      ] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) => {
        attempted.push(symbol);
        return generateBars(symbol, window.timeframe, at, window.lookback);
      },
      fetchCryptoBars: async () => [],
      print: () => {},
    });

    // The run did not abort: QQQ was still attempted after SPY's double
    // failure.
    expect(attempted).toEqual(['SPY', 'QQQ']);
    // And the operator is TOLD the count is untrustworthy rather than being
    // handed a confident 0.
    expect(coverage[0]).toEqual(
      expect.objectContaining({
        instrument: 'SPY',
        rows: 0,
        satisfied: false,
        error: expect.stringContaining('coverage may under-report') as string,
      }),
    );
  });

  it("reports the source of the most recently stored bar per pair (#496) — 'surface which one served'", async () => {
    const { deps } = buildDeps(); // generateBars stamps source: 'fixture'
    const coverage = await backfillMarketData(deps);

    const spy1h = coverage.find((row) => row.instrument === 'SPY' && row.timeframe === '1h');
    expect(spy1h?.source).toBe('fixture');
  });

  it('reports source: undefined for a pair with no bars at all, rather than fabricating one', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

    const coverage = await backfillMarketData({
      store,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async () => [],
      fetchCryptoBars: async () => [],
      print: () => {},
    });

    expect(coverage[0]?.source).toBeUndefined();
  });
});

/**
 * #496: the failover mechanism, exercised through the REAL composition
 * `backfillMarketData` provides — a throwing primary wrapped by
 * `withOhlcvFailover` (the same wrapper `backfill-market-data.ts`'s
 * `runFromEnvironment` wires around the real Alpaca/Polygon and
 * Coinbase/Bitstamp clients) — and read back from a REAL
 * `SqliteMarketDataStore`, not asserted against the in-memory return value
 * alone. This is what answers "is provenance populated by real production
 * code" rather than only a client-level unit test.
 */
describe('OHLCV failover provenance, through the real store (#496)', () => {
  it('persists the FALLBACK source per bar when the primary throws — readable back from SqliteMarketDataStore', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

    const fetchEquityBars = withOhlcvFailover({
      leg: 'equities',
      primary: async () => {
        throw new Error('Alpaca 403: SIP data window');
      },
      primaryName: 'alpaca',
      fallback: async (symbol, window, at) =>
        generateBars(symbol, window.timeframe, at, window.lookback).map((bar) => ({
          ...bar,
          source: 'polygon',
        })),
      fallbackName: 'polygon',
      alert: () => {},
    });

    const coverage = await backfillMarketData({
      store,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars,
      fetchCryptoBars: async () => [],
      print: () => {},
    });

    expect(coverage[0]).toMatchObject({ satisfied: true, source: 'polygon' });

    // Read back from the REAL store, not the in-memory return value — proves
    // `SqliteMarketDataStore.appendBars` actually persisted the fallback's
    // `source` column (`bars.source`, `0001_init.sql`) rather than the
    // provenance only existing in a test double's memory.
    const stored = store.readBars('SPY', '1h', ASOF, 20);
    expect(stored).toHaveLength(20);
    expect(stored.every((bar) => bar.source === 'polygon')).toBe(true);
  });

  it('persists the CRYPTO fallback source (bitstamp) the same way', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

    const fetchCryptoBars = withOhlcvFailover({
      leg: 'crypto',
      primary: async () => {
        throw new Error('Coinbase network error');
      },
      primaryName: 'coinbase',
      fallback: async (symbol, window, at) =>
        generateBars(symbol, window.timeframe, at, window.lookback).map((bar) => ({
          ...bar,
          source: 'bitstamp',
        })),
      fallbackName: 'bitstamp',
      alert: () => {},
    });

    await backfillMarketData({
      store,
      universe: [{ asset: 'BTC-USD', asset_class: 'crypto' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1d', lookback: 30 }],
      asOf: ASOF,
      fetchEquityBars: async () => [],
      fetchCryptoBars,
      print: () => {},
    });

    const stored = store.readBars('BTC-USD', '1d', ASOF, 30);
    expect(stored).toHaveLength(30);
    expect(stored.every((bar) => bar.source === 'bitstamp')).toBe(true);
  });

  it('leaves provenance at the PRIMARY source when the primary succeeds — failover never fires needlessly', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);
    const alert = vi.fn();

    const fetchEquityBars = withOhlcvFailover({
      leg: 'equities',
      primary: async (symbol, window, at) =>
        generateBars(symbol, window.timeframe, at, window.lookback).map((bar) => ({
          ...bar,
          source: 'alpaca',
        })),
      primaryName: 'alpaca',
      fallback: async () => {
        throw new Error('fallback must not be called');
      },
      fallbackName: 'polygon',
      alert,
    });

    await backfillMarketData({
      store,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars,
      fetchCryptoBars: async () => [],
      print: () => {},
    });

    expect(alert).not.toHaveBeenCalled();
    const stored = store.readBars('SPY', '1h', ASOF, 20);
    expect(stored.every((bar) => bar.source === 'alpaca')).toBe(true);
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

    // A couple of minutes later, still inside the same 5m/1h/1d interval as
    // ASOF (12:30:00Z). #742 added a '5m' window to WARM_START_WINDOWS; a
    // 5-minute offset from a bar boundary would cross into the NEXT 5m bar
    // and legitimately trigger a fetch for that timeframe, which is not what
    // this AC is testing — 2 minutes stays inside [12:30, 12:35).
    const tickAsOf = new Date(ASOF.getTime() + 2 * 60_000);
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
