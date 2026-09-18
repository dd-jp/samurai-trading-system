import { DEFAULT_UNIVERSE, type UniverseInstrument } from '../apps/orchestrator/index.js';
import type {
  DataFailoverAlert,
  DataFailoverAlertChannel,
} from '../apps/orchestrator/production/data-failover.js';
import type { Logger } from '../apps/orchestrator/types.js';
import {
  type Bar,
  type BarWindow,
  type DataSource,
  type FailoverEvent,
  type Mark,
  MarketDataServiceImpl,
  type Quote,
  SqliteMarketDataStore,
  timeframeToMs,
} from '../providers/market-data-service/index.js';
import { withOhlcvFailover } from '../providers/market-data-service/sources/ohlcv-failover.js';
import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import {
  backfillMarketData,
  buildBackfillFailoverAlerter,
  WARM_START_WINDOWS,
} from './backfill-market-data.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}
  now(): Date {
    return this.time;
  }
}

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

const HOURLY_WARM_START = ((): number => {
  const window = WARM_START_WINDOWS.find((candidate) => candidate.timeframe === '1h');
  if (window === undefined) throw new Error('expected a 1h window in WARM_START_WINDOWS');
  return window.lookback;
})();

function buildDeps(overrides: Partial<Parameters<typeof backfillMarketData>[0]> = {}) {
  const db = openSharedStore(':memory:');
  const store = new SqliteMarketDataStore(db);
  const equityFetches: { symbol: string; window: BarWindow }[] = [];

  const deps = {
    store,
    asOf: ASOF,
    universe: DEFAULT_UNIVERSE,
    windows: WARM_START_WINDOWS,
    fetchEquityBars: async (symbol: string, window: BarWindow, at: Date) => {
      equityFetches.push({ symbol, window });
      return generateBars(symbol, window.timeframe, at, window.lookback);
    },
    print: () => {},
    ...overrides,
  };

  return { deps, store, equityFetches };
}

describe('backfillMarketData', () => {
  it('fetches and fills every (instrument, window) pair from an empty store', async () => {
    const { deps, equityFetches } = buildDeps();

    const coverage = await backfillMarketData(deps);

    expect(coverage).toHaveLength(DEFAULT_UNIVERSE.length * WARM_START_WINDOWS.length);
    expect(coverage.every((row) => row.satisfied)).toBe(true);
    expect(equityFetches).toHaveLength(DEFAULT_UNIVERSE.length * WARM_START_WINDOWS.length);
  });

  it('refuses a crypto instrument as a SHORT row instead of silently routing it to fetchEquityBars (#1157)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);
    const equityFetches: { symbol: string; window: BarWindow }[] = [];

    const coverage = await backfillMarketData({
      store,
      universe: [
        { asset: 'QQQ', asset_class: 'stocks' },
        { asset: 'BTC-USD', asset_class: 'crypto' },
      ] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) => {
        equityFetches.push({ symbol, window });
        return generateBars(symbol, window.timeframe, at, window.lookback);
      },
      print: () => {},
    });

    expect(equityFetches.map((f) => f.symbol)).toEqual(['QQQ']);
    expect(coverage).toEqual([
      expect.objectContaining({ instrument: 'QQQ', satisfied: true, error: undefined }),
      expect.objectContaining({
        instrument: 'BTC-USD',
        rows: 0,
        satisfied: false,
        error: expect.stringContaining('crypto') as string,
      }),
    ]);
  });

  it('refuses a crypto instrument even when the store already holds enough bars to satisfy it (#1157)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);
    store.appendBars(generateBars('BTC-USD', '1h', ASOF, 20));

    const coverage = await backfillMarketData({
      store,
      universe: [{ asset: 'BTC-USD', asset_class: 'crypto' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) =>
        generateBars(symbol, window.timeframe, at, window.lookback),
      print: () => {},
    });

    expect(coverage).toEqual([
      expect.objectContaining({
        instrument: 'BTC-USD',
        rows: 20,
        satisfied: false,
        error: expect.stringContaining('crypto') as string,
      }),
    ]);
  });

  it('is idempotent — a second run against an already-warm store makes no fetch calls', async () => {
    const { deps, equityFetches } = buildDeps();
    await backfillMarketData(deps);
    equityFetches.length = 0;

    const coverage = await backfillMarketData(deps);

    expect(equityFetches).toHaveLength(0);
    expect(coverage.every((row) => row.satisfied)).toBe(true);
  });

  it('is resumable — only fetches the pairs a prior partial run left short', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);
    store.appendBars(generateBars('QQQ', '1h', ASOF, HOURLY_WARM_START));

    const equityFetches: { symbol: string; window: BarWindow }[] = [];
    const coverage = await backfillMarketData({
      store,
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) => {
        equityFetches.push({ symbol, window });
        return generateBars(symbol, window.timeframe, at, window.lookback);
      },
      print: () => {},
    });

    expect(equityFetches.some((f) => f.symbol === 'QQQ' && f.window.timeframe === '1h')).toBe(
      false,
    );
    expect(equityFetches.some((f) => f.symbol === 'QQQ' && f.window.timeframe === '1d')).toBe(true);
    expect(coverage.every((row) => row.satisfied)).toBe(true);
  });

  it('never double-writes a bar on re-run — appendBars is INSERT OR IGNORE on the PK', async () => {
    const { deps, store } = buildDeps();
    await backfillMarketData(deps);
    await backfillMarketData(deps);

    const rows = store.readBars('QQQ', '1h', ASOF, 1000);
    expect(rows).toHaveLength(HOURLY_WARM_START);
  });

  it('reports first bar / last bar / row count per (instrument, timeframe)', async () => {
    const { deps } = buildDeps();
    const coverage = await backfillMarketData(deps);

    const qqq1h = coverage.find((row) => row.instrument === 'QQQ' && row.timeframe === '1h');
    expect(qqq1h).toMatchObject({
      rows: HOURLY_WARM_START,
      required: HOURLY_WARM_START,
      satisfied: true,
    });
    expect(qqq1h?.first_bar).toBeDefined();
    expect(qqq1h?.last_bar).toBeDefined();
    if (qqq1h?.first_bar === undefined || qqq1h?.last_bar === undefined) {
      throw new Error('expected first_bar/last_bar to be defined');
    }
    expect(new Date(qqq1h.first_bar).getTime()).toBeLessThan(new Date(qqq1h.last_bar).getTime());
  });

  it('marks a pair unsatisfied and does not silently under-report when the fetcher returns fewer bars than required', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

    const coverage = await backfillMarketData({
      store,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars: async (symbol, window, at) => generateBars(symbol, window.timeframe, at, 5),
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
      print: () => {},
    });

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
      print: () => {},
    });

    expect(coverage).toEqual([
      expect.objectContaining({
        instrument: 'SPY',
        timeframe: '1h',
        rows: 12,
        satisfied: false,
        error: expect.stringContaining('database is locked') as string,
      }),
    ]);
  });

  it('keeps going and says coverage may be wrong when the re-read ALSO fails', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

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
      print: () => {},
    });

    expect(attempted).toEqual(['SPY', 'QQQ']);
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
    const { deps } = buildDeps();
    const coverage = await backfillMarketData(deps);

    const qqq1h = coverage.find((row) => row.instrument === 'QQQ' && row.timeframe === '1h');
    expect(qqq1h?.source).toBe('fixture');
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
      print: () => {},
    });

    expect(coverage[0]?.source).toBeUndefined();
  });
});

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
      print: () => {},
    });

    expect(coverage[0]).toMatchObject({ satisfied: true, source: 'polygon' });

    const stored = store.readBars('SPY', '1h', ASOF, 20);
    expect(stored).toHaveLength(20);
    expect(stored.every((bar) => bar.source === 'polygon')).toBe(true);
  });

  it('flags the pair QUARANTINED when the equities fallback served a polygon-stamped bar (#791 AC2)', async () => {
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
      print: () => {},
    });

    expect(coverage[0]?.quarantined).toBe(true);
  });

  it('does NOT flag a pair the equities primary served cleanly — quarantine is not a default-true flag', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteMarketDataStore(db);

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
      alert: () => {},
    });

    const coverage = await backfillMarketData({
      store,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }] satisfies UniverseInstrument[],
      windows: [{ timeframe: '1h', lookback: 20 }],
      asOf: ASOF,
      fetchEquityBars,
      print: () => {},
    });

    expect(coverage[0]?.quarantined).toBe(false);
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
      print: () => {},
    });

    expect(alert).not.toHaveBeenCalled();
    const stored = store.readBars('SPY', '1h', ASOF, 20);
    expect(stored.every((bar) => bar.source === 'alpaca')).toBe(true);
  });
});

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

    const tickAsOf = new Date(ASOF.getTime() + 2 * 60_000);
    const source = new CountingDataSource();
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

class RecordingLogger implements Logger {
  readonly entries: Parameters<Logger['log']>[0][] = [];
  log(entry: Parameters<Logger['log']>[0]): void {
    this.entries.push(entry);
  }
}

const FAILOVER_EVENT: FailoverEvent = {
  leg: 'equities',
  symbol: 'SPY',
  timeframe: '1h',
  primaryName: 'alpaca',
  fallbackName: 'polygon',
  primaryError: 'Alpaca 403: SIP data window',
};

describe('buildBackfillFailoverAlerter (#791 AC1 — backfill failover reaches the routed channel)', () => {
  it('posts to the routed dataFailoverAlerts channel, not console.error', () => {
    const posted: DataFailoverAlert[] = [];
    const channel: DataFailoverAlertChannel = {
      postDataFailoverAlert: async (alert) => {
        posted.push(alert);
      },
    };
    const logger = new RecordingLogger();
    const now = new Date('2026-08-18T09:00:00Z');

    const alerter = buildBackfillFailoverAlerter({ alertChannel: channel, logger, now: () => now });
    alerter(FAILOVER_EVENT);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      ...FAILOVER_EVENT,
      reported_at: now,
      suppressed_since_last: 0,
    });
  });

  it('preserves the BEFORE-fallback alert ordering through withOhlcvFailover', async () => {
    const posted: DataFailoverAlert[] = [];
    const order: string[] = [];
    const channel: DataFailoverAlertChannel = {
      postDataFailoverAlert: async (alert) => {
        order.push('alert');
        posted.push(alert);
      },
    };
    const alerter = buildBackfillFailoverAlerter({
      alertChannel: channel,
      logger: new RecordingLogger(),
      now: () => new Date(),
    });

    const fetch = withOhlcvFailover({
      leg: 'equities',
      primaryName: 'alpaca',
      fallbackName: 'polygon',
      alert: alerter,
      primary: async () => {
        throw new Error('Alpaca 403: SIP data window');
      },
      fallback: async () => {
        order.push('fallback');
        return [];
      },
    });

    await fetch('SPY', { timeframe: '1h', lookback: 20 }, new Date());

    expect(order).toEqual(['alert', 'fallback']);
    expect(posted).toHaveLength(1);
  });

  it('does not mask the fallback result or throw when postDataFailoverAlert REJECTS (#791 AC1 non-masking)', async () => {
    const logger = new RecordingLogger();
    const channel: DataFailoverAlertChannel = {
      postDataFailoverAlert: async () => {
        throw new Error('Telegram 500');
      },
    };
    const alerter = buildBackfillFailoverAlerter({
      alertChannel: channel,
      logger,
      now: () => new Date(),
    });

    const fetch = withOhlcvFailover({
      leg: 'equities',
      primaryName: 'alpaca',
      fallbackName: 'polygon',
      alert: alerter,
      primary: async () => {
        throw new Error('Alpaca 403: SIP data window');
      },
      fallback: async () => [
        {
          instrument: 'SPY',
          timeframe: '1h',
          open_time: new Date(0),
          close_time: new Date(1),
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          source: 'polygon',
        } satisfies Bar,
      ],
    });

    const bars = await fetch('SPY', { timeframe: '1h', lookback: 20 }, new Date());
    expect(bars).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
  });
});
