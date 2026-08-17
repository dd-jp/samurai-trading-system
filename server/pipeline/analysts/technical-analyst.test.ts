import type {
  Bar,
  BarWindow,
  DataSource,
  Mark,
  Quote,
} from '../../providers/market-data-service/index.js';
import {
  computeIndicator,
  FixtureDataSource,
  InsufficientBarsError,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { confidenceFrom, RSI_SPEC, technicalAnalyst, WARMUP_5M } from './technical-analyst.js';
import type { AnalystInput, Signal } from './types.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }

  set(time: Date): void {
    this.time = time;
  }
}

const INSTRUMENT = 'BTC-USD';
/**
 * The technical read moved from 1h to 5m in #742; fixtures below are stamped
 * '5m' so they reach `SMA_SPEC`/`RSI_SPEC` (both now `timeframe: '5m'`) via
 * `FixtureDataSource`'s `bar.timeframe === window.timeframe` filter.
 * `CONTEXT_TF` bars are also supplied by default so the ordinary test path
 * exercises the real production shape (both series populated) rather than
 * only the degraded no-context path — that path gets its own dedicated test
 * below ("falls back to ... when no 1h bars exist").
 */
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;
const CONTEXT_TF = '1h';
const CONTEXT_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Must be >= RSI_SPEC.lookback (57): the single-fetch collapse test needs the
 * fixture to hold at least as many 5m bars as RSI_SPEC's own window asks
 * for, or `MarketDataServiceImpl.cachedBars`'s `rows.length < window.lookback`
 * guard falls through to a real second fetch for RSI_SPEC alone — the
 * fixture running thin, not a collapse defect. 70 leaves margin.
 */
const BAR_COUNT = 70;
/** Matches the analyst's own `CONTEXT_CANDLE_LOOKBACK` (20); any count > 0 exercises the real path. */
const CONTEXT_BAR_COUNT = 20;

/** A steady uptrend so SMA/RSI produce a non-neutral, deterministic reading. */
function buildBars(): Bar[] {
  const bars: Bar[] = [];
  const start = new Date('2026-07-14T00:00:00Z').getTime();
  for (let i = 0; i < BAR_COUNT; i++) {
    const closeTime = new Date(start + i * BAR_INTERVAL_MS);
    const close = 100 + i;
    bars.push({
      instrument: INSTRUMENT,
      timeframe: TIMEFRAME,
      open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
      close_time: closeTime,
      open: close - 1,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10 + i,
      source: 'fixture',
    });
  }
  return bars;
}

/** 1h context bars — populated by default so the ordinary test path exercises the real (non-degraded) context read. */
function buildContextBars(): Bar[] {
  const bars: Bar[] = [];
  const start = new Date('2026-07-10T00:00:00Z').getTime();
  for (let i = 0; i < CONTEXT_BAR_COUNT; i++) {
    const closeTime = new Date(start + i * CONTEXT_INTERVAL_MS);
    const close = 100 + i;
    bars.push({
      instrument: INSTRUMENT,
      timeframe: CONTEXT_TF,
      open_time: new Date(closeTime.getTime() - CONTEXT_INTERVAL_MS),
      close_time: closeTime,
      open: close - 1,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + i,
      source: 'fixture',
    });
  }
  return bars;
}

const BARS = [...buildBars(), ...buildContextBars()];
const ASOF = buildBars()[buildBars().length - 1].close_time;

function buildInput(signal: Signal, trace_id: string, bars: Bar[] = BARS): AnalystInput {
  // Derived from the '5m' series specifically, not `bars.at(-1)`: `bars` may
  // interleave two timeframes (5m technical + 1h context) whose array order
  // is incidental, and asOf must sit at/after the LATEST bar of whichever
  // series the caller cares about driving to completion. The 5m series is
  // always the later-dated one in this file's fixtures, so this also covers
  // (>=) any 1h bars present.
  const fiveMinuteBars = bars.filter((bar) => bar.timeframe === TIMEFRAME);
  const asOf = (fiveMinuteBars.at(-1) ?? bars.at(-1))?.close_time as Date;
  const clock = new ManualClock(asOf);
  const dataSource = new FixtureDataSource(
    bars,
    { price: 999, observed_at: asOf, source: 'fixture-live' },
    signal.asset_class,
  );
  const marketData = new MarketDataServiceImpl(
    dataSource,
    clock,
    'backtest',
    new SqliteMarketDataStore(openSharedStore(':memory:')),
  );

  const marketIntelligence = new MarketIntelligenceStore(clock);
  marketIntelligence.ingest({
    agent_id: 'deepresearch',
    timestamp: asOf,
    asset_class: signal.asset_class,
    items: [
      {
        id: 'item-1',
        source: 'bloomberg',
        type: 'news',
        timestamp: asOf,
        entity: signal.asset,
        headline: 'Steady uptrend continues',
        sentiment: 1,
        confidence: 0.6,
      },
    ],
  });

  return {
    trace_id,
    signal,
    clock,
    market_intelligence: marketIntelligence,
    market_data: marketData,
  };
}

describe('technicalAnalyst', () => {
  const signal: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };

  it('produces a deterministic AnalystView from (Signal, asOf) given fixed MDS/MI responses', async () => {
    const first = await technicalAnalyst.run(buildInput(signal, 'trace-1'));
    const second = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(second).toEqual(first);
  });

  it('produces the fixed AnalystView shape', async () => {
    const view = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(view.analyst_type).toBe('technical');
    expect(['bullish', 'bearish', 'neutral']).toContain(view.direction);
    expect(view.confidence).toBeGreaterThanOrEqual(0);
    expect(view.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(view.key_points)).toBe(true);
    expect(view.timestamp).toEqual(ASOF);
  });

  it('reports real avg volume for the 1h context read by default (#742)', async () => {
    // BARS includes both the '5m' technical series and a populated '1h'
    // context series (buildContextBars) — this is the ordinary production
    // shape, not the degraded no-context path below.
    const view = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    const contextLine = view.key_points.find((line) => line.startsWith('Context (1h):'));
    expect(contextLine).toBe(`Context (1h): ${CONTEXT_BAR_COUNT} candles, avg volume 1009.5`);
  });

  it('reports "unavailable", never a fabricated 0/NaN, for the 1h context read when no 1h bars exist (#742)', async () => {
    // Strip the '1h' context bars out of the fixture (keep only the '5m'
    // series the technical read itself needs). The separate 1h context read
    // (`CONTEXT_TIMEFRAME`) then always misses. Before this fix the analyst
    // reported a fabricated 'avg volume 0' — a false claim about the tape,
    // the same fabrication class #319 made `computeIndicator` throw on
    // instead of silently answering. It must degrade the prose only, never
    // invent a number.
    const fiveMinuteOnly = buildBars();
    const view = await technicalAnalyst.run(buildInput(signal, 'trace-1', fiveMinuteOnly));

    expect(view.key_points).toContain('Context (1h): unavailable');
    expect(view.key_points.some((line) => line.includes('NaN'))).toBe(false);
  });

  it('produces a valid AnalystView given no weight information (AnalystInput carries no weight field)', async () => {
    const input = buildInput(signal, 'trace-1');
    expect(input).not.toHaveProperty('weight');

    const view = await technicalAnalyst.run(input);

    expect(view.analyst_type).toBe('technical');
    expect(['bullish', 'bearish', 'neutral']).toContain(view.direction);
    expect(view.confidence).toBeGreaterThanOrEqual(0);
    expect(view.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(view.key_points)).toBe(true);
    expect(view.timestamp).toEqual(ASOF);
  });

  /**
   * The analyst labels its output "RSI(14)". Before #319 that label was
   * false: `RSI_SPEC` asked for 14 bars with no pinned period, so
   * `computeIndicator` saw 13 changes, divided by 14 anyway, and reported the
   * result as a 14-period RSI. The guard turned that into a throw, so the
   * spec was widened to `lookback: 15` with `period: 14`, and #722 widened it
   * further to the converged `recommendedWarmupFor` of 57. The label has to
   * keep matching the arithmetic through both moves, which is what this pins.
   *
   * Zig-zag closes, not the module's steady uptrend: a monotonic series has
   * `avgLoss === 0`, so `rsi` short-circuits to 100 and a 13-change window is
   * indistinguishable from a 14-change one. This fixture is what makes the
   * width observable.
   */
  const ZIGZAG = ((): Bar[] => {
    const start = new Date('2026-07-14T00:00:00Z').getTime();
    return Array.from({ length: 20 }, (_, i) => {
      const closeTime = new Date(start + i * BAR_INTERVAL_MS);
      const close = 100 + Math.sin(i / 2) * 5 + i * 0.3;
      return {
        instrument: INSTRUMENT,
        timeframe: TIMEFRAME,
        open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
        close_time: closeTime,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 10 + i,
        source: 'fixture',
      };
    });
  })();

  it('reports an RSI genuinely seeded over 14 changes, not 13 divided by 14 (#319)', async () => {
    const view = await technicalAnalyst.run(buildInput(signal, 'trace-1', ZIGZAG));

    // Recomputed from the same bars with the REAL spec, not a rebuilt copy: a
    // literal would keep passing if `RSI_SPEC` drifted, which is the mistake
    // #722 had to correct here (the copy pinned `lookback: 15` and went on
    // asserting the floor's value after the live spec moved to 57). Only
    // `params.period` reaches the arithmetic, so passing all 20 fixture bars
    // with a 57-bar spec computes exactly what the analyst computed from the
    // 20 the fixture source could serve.
    const honest = computeIndicator(ZIGZAG, RSI_SPEC);
    // The nearest computable stand-in for what it used to report. The exact
    // old value — 13 changes divided by 14 — is no longer expressible: the
    // guard is what stops `computeIndicator` producing it. An honest RSI(13)
    // over the same 14-bar window is the same WIDTH of history, and it
    // differs, which is what makes the assertion above evidence rather than a
    // coincidence: the analyst could not have printed `honest` off 14 bars.
    const narrower = computeIndicator(ZIGZAG.slice(-14), {
      indicator: 'rsi',
      params: { period: 13 },
      timeframe: TIMEFRAME,
      lookback: 14,
    });

    expect(honest).not.toBeCloseTo(narrower, 6);
    expect(view.key_points).toContain(`RSI(14)=${honest}`);
  });

  it('rejects rather than reporting an RSI(14) it has only 14 bars for (#319)', async () => {
    // The fail-loud posture at the analyst boundary. A cold instrument gets
    // no view at all rather than a plausible-looking number that a debate
    // would then weigh as if it meant something.
    await expect(
      technicalAnalyst.run(buildInput(signal, 'trace-1', ZIGZAG.slice(0, 14))),
    ).rejects.toThrow(InsufficientBarsError);
  });

  /**
   * A halted or auction-flat instrument (#725): every close identical, so
   * every RSI change is zero. Before the fix `rsi`'s `avgLoss === 0` branch
   * did not check `avgGain`, so this `0/0` shape answered 100 — the same
   * value a strictly rising window gets — and `confidenceFrom` reported
   * 0.95, near-maximum strength, for a tape that had not moved at all.
   * `docs/reviews/indicator-characterisation-2026-08-16.md` F3 pinned this
   * and deliberately did not fix it; this is the fix.
   */
  const FLAT: Bar[] = ((): Bar[] => {
    const start = new Date('2026-07-14T00:00:00Z').getTime();
    return Array.from({ length: 60 }, (_, i) => {
      const closeTime = new Date(start + i * BAR_INTERVAL_MS);
      return {
        instrument: INSTRUMENT,
        timeframe: TIMEFRAME,
        open_time: new Date(closeTime.getTime() - BAR_INTERVAL_MS),
        close_time: closeTime,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 10,
        source: 'fixture',
      };
    });
  })();

  it('reports confidence near the floor, not 0.95, on a flat tape (#725)', async () => {
    const view = await technicalAnalyst.run(buildInput(signal, 'trace-1', FLAT));

    expect(view.key_points).toContain(`RSI(14)=50`);
    // Before the fix this was 0.95 (confidenceFrom(100)). 50 is the
    // midpoint `confidenceFrom` treats as "no information": `|50-50|/50`
    // clamps to the 0.05 floor, so the analyst stays present in the debate
    // (technical is `mandatory`) but argues at near-minimum rather than
    // near-maximum strength.
    expect(view.confidence).toBe(confidenceFrom(50));
    expect(view.confidence).toBeCloseTo(0.05, 6);
    expect(view.direction).toBe('neutral');
  });

  it('holds no state across calls: an intervening call with different inputs does not affect a repeat call', async () => {
    const baseline = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    const otherSignal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };
    await technicalAnalyst.run(buildInput(otherSignal, 'trace-2'));

    const repeat = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(repeat).toEqual(baseline);
  });
});

/**
 * #742 — the single-fetch collapse. `SMA_SPEC` and `RSI_SPEC` are both
 * `timeframe: '5m'`; `run()` warms the store with the shared `WARMUP_5M`
 * window BEFORE the `Promise.all` that requests them, so
 * `MarketDataServiceImpl.cachedBars`'s route 1 (same instrument+timeframe,
 * already fetched this bar interval) serves both without a second
 * `DataSource.fetchBars` call.
 *
 * Route 1 only engages in 'live'/'paper' mode — `cachedBars` returns
 * `undefined` unconditionally in 'backtest' (service.ts), which is why every
 * other test in this file (all 'backtest', for PIT determinism) fetches
 * fresh every time and cannot exercise this path. This is the one test in
 * the suite constructed with `mode: 'live'`.
 *
 * Counts through the REAL `MarketDataServiceImpl` seam (a spying
 * `DataSource`, not a mock of `getBars`/`getIndicator` themselves) per the
 * repo's dominant defect class: a mechanism that is unit-tested in isolation
 * but that nothing calls the way production calls it.
 */
describe('technicalAnalyst — single 5m bar fetch per instrument per tick (#742)', () => {
  class CountingDataSource implements DataSource {
    readonly fetchBarsCallsByTimeframe = new Map<string, number>();

    constructor(private readonly inner: DataSource) {}

    async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
      this.fetchBarsCallsByTimeframe.set(
        window.timeframe,
        (this.fetchBarsCallsByTimeframe.get(window.timeframe) ?? 0) + 1,
      );
      return this.inner.fetchBars(instrument, window, asOf);
    }

    fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
      return this.inner.fetchMark(instrument, asOf, mode);
    }

    fetchQuote(instrument: string, asOf: Date): Promise<Quote | null> {
      return this.inner.fetchQuote?.(instrument, asOf) ?? Promise.resolve(null);
    }
  }

  function buildLiveInput(signal: Signal): { input: AnalystInput; counting: CountingDataSource } {
    // See the comment on the same pattern in `buildInput` above: BARS
    // interleaves the '5m' and '1h' series, so asOf must be derived from the
    // '5m' series specifically, not the array's incidental last element.
    const asOf = BARS.filter((bar) => bar.timeframe === TIMEFRAME).at(-1)?.close_time as Date;
    const clock = new ManualClock(asOf);
    const counting = new CountingDataSource(
      new FixtureDataSource(
        BARS,
        { price: 999, observed_at: asOf, source: 'fixture-live' },
        signal.asset_class,
      ),
    );
    const marketData = new MarketDataServiceImpl(
      counting,
      clock,
      'live',
      new SqliteMarketDataStore(openSharedStore(':memory:')),
    );
    const marketIntelligence = new MarketIntelligenceStore(clock);

    return {
      input: {
        trace_id: 'trace-live-1',
        signal,
        clock,
        market_intelligence: marketIntelligence,
        market_data: marketData,
      },
      counting,
    };
  }

  it('issues exactly one 5m DataSource.fetchBars call for the whole tick', async () => {
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };
    const { input, counting } = buildLiveInput(signal);

    await technicalAnalyst.run(input);

    expect(counting.fetchBarsCallsByTimeframe.get('5m')).toBe(1);
  });

  it('WARMUP_5M is wide enough to cover RSI_SPEC.lookback, which is what makes the collapse hold', () => {
    // If this ever regresses (a period bump on RSI_SPEC without a matching
    // WARMUP_5M bump), the store the warm-up fetch fills would fall short of
    // RSI_SPEC's own window, `cachedBars`'s `rows.length < window.lookback`
    // guard would miss, and the collapse above would silently degrade to two
    // fetches rather than fail loud — this pins the invariant that prevents
    // that.
    expect(WARMUP_5M).toBeGreaterThanOrEqual(RSI_SPEC.lookback);
  });
});
