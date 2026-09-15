/**
 * #1543 — the cold-store first pass, measured rather than inherited.
 *
 * The ticket reports "~70s of bar sweep against a 30,000ms deadline". Both
 * numbers have moved (see the arithmetic block at the bottom of this file),
 * but the shape has not: a first pass against an EMPTY store reaches the venue
 * for every distinct (timeframe, lookback) it asks for, where the deadline
 * `production.ts` derives is sized against the far smaller WARM count.
 *
 * These cases drive the REAL `technicalAnalyst.run` through the REAL
 * `MarketDataServiceImpl` against a genuinely empty `SqliteMarketDataStore`,
 * and count what reaches the `DataSource`. Nothing here asserts a hand-derived
 * window list — the counts come out of the analyst's own fetch pattern, which
 * is the only thing that can tell the truth about a cold pass.
 */
import {
  RVOL_5M_LOOKBACK,
  technicalAnalyst,
  WARMUP_5M,
} from '../../../pipeline/analysts/technical-analyst.js';
import { NOOP_ANALYST_TELEMETRY, type Signal } from '../../../pipeline/analysts/types.js';
import {
  AlwaysOpenCalendar,
  type Bar,
  type BarWindow,
  type DataSource,
  FixtureDataSource,
  type Mark,
  type MarketDataService,
  MarketDataServiceImpl,
  type Quote,
  SqliteMarketDataStore,
} from '../../../providers/market-data-service/index.js';
import {
  ALPACA_BARS_RETRY_CONFIG,
  ALPACA_BARS_TIMEOUT_MS,
} from '../../../providers/market-data-service/sources/alpaca-http-client.js';
import { MarketIntelligenceStore } from '../../../providers/market-intelligence/index.js';
import {
  type Clock,
  DEFAULT_VENUE_PACING,
  deriveAnalystTimeoutMs,
  worstCaseFetchMs,
} from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import type { Logger, UniverseInstrument } from '../types.js';
import { FIRST_TICK_BAR_WINDOWS, prefetchBars } from './bar-prefetch.js';

const INSTRUMENT = 'SPY';
const SIGNAL: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };
const UNIVERSE: readonly UniverseInstrument[] = [{ asset: INSTRUMENT, asset_class: 'stocks' }];

/** A 5m/1h/1d boundary all at once, so no fixture bar straddles `ASOF`. */
const ASOF = new Date('2026-06-16T20:00:00.000Z');

const MINUTE_MS = 60_000;

/**
 * Deeper than `RVOL_5M_LOOKBACK` on 5m and than any 1h/1d consumer, so a miss
 * below is the CACHE missing, never the fixture running out of history.
 */
const FIXTURE_DEPTH: Record<string, { count: number; widthMs: number }> = {
  '5m': { count: RVOL_5M_LOOKBACK + 64, widthMs: 5 * MINUTE_MS },
  '1h': { count: 120, widthMs: 60 * MINUTE_MS },
  '1d': { count: 60, widthMs: 24 * 60 * MINUTE_MS },
};

class ManualClock implements Clock {
  constructor(private time: Date) {}
  now(): Date {
    return this.time;
  }
  set(time: Date): void {
    this.time = time;
  }
}

class SilentLogger implements Logger {
  readonly entries: Parameters<Logger['log']>[0][] = [];
  log(entry: Parameters<Logger['log']>[0]): void {
    this.entries.push(entry);
  }
}

function fixtureBars(): Bar[] {
  const bars: Bar[] = [];
  for (const [timeframe, { count, widthMs }] of Object.entries(FIXTURE_DEPTH)) {
    for (let i = count - 1; i >= 0; i--) {
      const close_time = new Date(ASOF.getTime() - i * widthMs);
      const close = 100 + Math.sin(i / 7);
      bars.push({
        instrument: INSTRUMENT,
        timeframe,
        open_time: new Date(close_time.getTime() - widthMs),
        close_time,
        open: close - 0.2,
        high: close + 0.5,
        low: close - 0.6,
        close,
        volume: 1_000 + (i % 5),
        source: 'fixture',
      });
    }
  }
  return bars;
}

/** Records every window that actually reaches the source — a store hit is silent. */
class CountingDataSource implements DataSource {
  readonly windows: string[] = [];
  constructor(private readonly inner: DataSource) {}
  async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
    this.windows.push(`${window.timeframe}/${window.lookback}`);
    return this.inner.fetchBars(instrument, window, asOf);
  }
  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    return this.inner.fetchMark(instrument, asOf, mode);
  }
  async fetchQuote(instrument: string, asOf: Date): Promise<Quote | null> {
    return this.inner.fetchQuote?.(instrument, asOf) ?? null;
  }
}

interface Harness {
  source: CountingDataSource;
  marketData: MarketDataServiceImpl;
  clock: ManualClock;
  logger: SilentLogger;
}

/** A cold store and a fresh service — the state a just-booted process is in. */
function coldHarness(): Harness {
  const clock = new ManualClock(ASOF);
  const source = new CountingDataSource(
    new FixtureDataSource(
      fixtureBars(),
      { price: 100, observed_at: ASOF, source: 'fixture' },
      'stocks',
    ),
  );
  const marketData = new MarketDataServiceImpl(
    source,
    clock,
    'live',
    new SqliteMarketDataStore(openSharedStore(':memory:')),
  );
  return { source, marketData, clock, logger: new SilentLogger() };
}

async function runTechnicalPass(harness: Harness): Promise<void> {
  await technicalAnalyst.run({
    trace_id: 'trace-1543',
    signal: SIGNAL,
    clock: harness.clock,
    bar: harness.clock.now(),
    market_intelligence: new MarketIntelligenceStore(harness.clock),
    market_data: harness.marketData,
    calendar: new AlwaysOpenCalendar(),
    telemetry: NOOP_ANALYST_TELEMETRY,
  });
}

const distinct = (windows: readonly string[]): string[] => [...new Set(windows)].sort();

describe('the cold-store first pass (#1543)', () => {
  it('reaches the venue for more distinct windows than the warm count the deadline is sized on', async () => {
    const harness = coldHarness();

    await runTechnicalPass(harness);

    // Measured, not quoted: `service.ts`'s own AC3 comment records EIGHT
    // windows from a `npm run smoke` run, but that fixture cannot serve the
    // deeper 5m windows, so its narrower specs missed on row COUNT rather
    // than on freshness. Against history deep enough to satisfy every
    // window — which is what a real cold venue is — the narrow 5m specs
    // collapse onto the shared warm-up through `cachedBars` route 1 and the
    // genuinely distinct cold sweep is smaller. It is still more than the
    // warm count the analyst deadline is derived from, which is the defect.
    expect(distinct(harness.source.windows)).toEqual([
      `1h/${20}`,
      `5m/${WARMUP_5M}`,
      `5m/${RVOL_5M_LOOKBACK}`,
    ]);
    expect(harness.source.windows).toHaveLength(3);
  });

  it('a prefetched store serves that same first pass without reaching the venue at all', async () => {
    const harness = coldHarness();

    const result = await prefetchBars({
      marketData: harness.marketData,
      universe: UNIVERSE,
      asOf: ASOF,
      logger: harness.logger,
      traceId: 'startup',
    });
    expect(result).toEqual({ warmed: FIRST_TICK_BAR_WINDOWS.length, failed: 0 });

    const prefetchCalls = harness.source.windows.length;
    await runTechnicalPass(harness);

    expect(harness.source.windows).toHaveLength(prefetchCalls);
  });

  it('bounds the first pass to one fetch per timeframe even when a bar interval rolls before the tick', async () => {
    // The prefetch cannot freeze time: a 5m bar closes between boot and the
    // first tick, and `cachedBars`' freshness routes correctly refuse the
    // stored window. What the prefetch still buys is DEPTH — the refreshed
    // 5m fetch lands once and every WIDER 5m window is then served off the
    // prefetched rows through route 1, so the deep 936-row crawl stays off
    // the tick path and the sweep is the warm shape, not the cold one.
    const harness = coldHarness();
    await prefetchBars({
      marketData: harness.marketData,
      universe: UNIVERSE,
      asOf: ASOF,
      logger: harness.logger,
      traceId: 'startup',
    });
    harness.source.windows.length = 0;

    harness.clock.set(new Date(ASOF.getTime() + 6 * MINUTE_MS));
    await runTechnicalPass(harness);

    expect(distinct(harness.source.windows)).toEqual([`5m/${WARMUP_5M}`]);
  });

  it('RED CHECK: without the prefetch the same rolled-interval pass pays the full cold sweep', async () => {
    const harness = coldHarness();

    harness.clock.set(new Date(ASOF.getTime() + 6 * MINUTE_MS));
    await runTechnicalPass(harness);

    expect(distinct(harness.source.windows).length).toBeGreaterThan(1);
  });
});

describe('the prefetch window list is the max per timeframe over the first pass (#1543)', () => {
  it('covers every window a cold first pass asks for, at least as deep', async () => {
    const harness = coldHarness();
    await runTechnicalPass(harness);

    for (const asked of harness.source.windows) {
      const [timeframe, lookback] = asked.split('/');
      const covering = FIRST_TICK_BAR_WINDOWS.find(
        (window) => window.timeframe === timeframe && window.lookback >= Number(lookback),
      );
      expect(covering, `no prefetch window covers ${asked}`).toBeDefined();
    }
  });

  it("carries RVOL's 936-bar 5m read, which the pre-#1543 list did not", () => {
    const fiveMinute = FIRST_TICK_BAR_WINDOWS.find((window) => window.timeframe === '5m');

    expect(fiveMinute?.lookback).toBe(RVOL_5M_LOOKBACK);
    expect(RVOL_5M_LOOKBACK).toBeGreaterThan(WARMUP_5M);
  });
});

describe('what the cold sweep costs against the derived deadline (#1543 premise)', () => {
  /**
   * The ticket's two headline numbers are both stale, and the correction
   * belongs on the record rather than being patched around. The deadline is
   * not a 30,000ms literal any more — #1542 made the composition root derive
   * it from the RESOLVED pacing — and the cold sweep is not eight windows per
   * instrument once the venue has depth to serve the narrow specs from
   * (measured above: three). What the ticket reports survives both
   * corrections, because the gap is not in the drain term at all: the
   * derivation budgets the queue plus exactly ONE bounded fetch, and a cold
   * pass runs its venue fetches SERIALLY.
   */
  it('budgets one bounded fetch where the measured cold pass runs three, two of them serial', async () => {
    const universeSize = 20;
    const fetchBoundMs = worstCaseFetchMs(ALPACA_BARS_TIMEOUT_MS, ALPACA_BARS_RETRY_CONFIG);
    const deadlineMs = deriveAnalystTimeoutMs(
      DEFAULT_VENUE_PACING.alpaca,
      universeSize,
      fetchBoundMs,
    );

    const harness = coldHarness();
    await runTechnicalPass(harness);

    // `technical-analyst.ts` awaits the shared 5m warm-up BEFORE the RVOL
    // read (its own doc says why: two concurrent fetches for the same
    // instrument+timeframe would race the store write), so these two are
    // strictly sequential, and the deadline has room for one of them.
    expect(harness.source.windows.at(0)).toBe(`5m/${WARMUP_5M}`);
    expect(harness.source.windows.at(-1)).toBe(`5m/${RVOL_5M_LOOKBACK}`);

    const coldWorstCaseMs = deadlineMs + fetchBoundMs;
    expect(coldWorstCaseMs).toBeGreaterThan(deadlineMs);

    // A warm pass is what the deadline was derived against, and the prefetch
    // is what makes the first pass one: zero venue fetches, hence zero
    // unbudgeted serial round trips.
    const warm = coldHarness();
    await prefetchBars({
      marketData: warm.marketData,
      universe: UNIVERSE,
      asOf: ASOF,
      logger: warm.logger,
      traceId: 'startup',
    });
    warm.source.windows.length = 0;
    await runTechnicalPass(warm);

    expect(warm.source.windows).toHaveLength(0);
  });
});

describe('prefetchBars fail-soft per (instrument, window) pair', () => {
  it('does not throw when getBars fails for one pair, counts it as failed, still warms the rest, and logs the failure', async () => {
    const logger = new SilentLogger();
    const windows: readonly BarWindow[] = [
      { timeframe: '5m', lookback: 10 },
      { timeframe: '1h', lookback: 20 },
    ];
    const universe: readonly UniverseInstrument[] = [
      { asset: 'SPY', asset_class: 'stocks' },
      { asset: 'QQQ', asset_class: 'stocks' },
    ];
    const calls: string[] = [];
    const marketData: Pick<MarketDataService, 'getBars'> = {
      getBars: async (instrument, window) => {
        calls.push(`${instrument}/${window.timeframe}/${window.lookback}`);
        if (instrument === 'SPY' && window.timeframe === '5m') {
          throw new Error('venue unreachable');
        }
        return [];
      },
    };

    const result = await prefetchBars({
      marketData,
      universe,
      asOf: ASOF,
      logger,
      traceId: 'startup',
      windows,
    });

    expect(result).toEqual({ warmed: 3, failed: 1 });
    // Every pair was attempted — the one failure did not short-circuit the loop.
    expect(calls).toEqual(['SPY/5m/10', 'SPY/1h/20', 'QQQ/5m/10', 'QQQ/1h/20']);

    const failureEntry = logger.entries.find(
      (entry) => entry.event === 'bar_prefetch_window_failed',
    );
    expect(failureEntry).toBeDefined();
    expect(failureEntry?.payload).toMatchObject({
      instrument: 'SPY',
      timeframe: '5m',
      lookback: 10,
    });
  });
});
