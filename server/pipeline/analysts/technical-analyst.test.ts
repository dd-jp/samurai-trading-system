import type {
  Bar,
  BarWindow,
  DataSource,
  Mark,
  Quote,
} from '../../providers/market-data-service/index.js';
import {
  AlwaysOpenCalendar,
  computeIndicator,
  FixtureDataSource,
  InsufficientBarsError,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import {
  ADX_SPEC,
  ATR_PCT_SPEC,
  DONCHIAN_SPEC,
  MACD_SPEC,
  RSI_SPEC,
  SMA_SPEC,
  SQUEEZE_SPEC,
  technicalAnalyst,
  WARMUP_5M,
} from './technical-analyst.js';
import { type AnalystInput, NOOP_ANALYST_TELEMETRY, type Signal } from './types.js';

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
const TIMEFRAME = '5m';
const BAR_INTERVAL_MS = 5 * 60 * 1000;
const CONTEXT_TF = '1h';
const CONTEXT_INTERVAL_MS = 60 * 60 * 1000;
const BAR_COUNT = 70;
const CONTEXT_BAR_COUNT = 20;

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

function buildInput(
  signal: Signal,
  trace_id: string,
  bars: Bar[] = BARS,
  calendar: TradingCalendar = new AlwaysOpenCalendar(),
): AnalystInput {
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
    bar: asOf,
    market_intelligence: marketIntelligence,
    market_data: marketData,
    calendar,
    telemetry: NOOP_ANALYST_TELEMETRY,
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

  it('reports "no session to anchor to" under AlwaysOpenCalendar — null is the real answer, not a midnight anchor', async () => {
    const view = await technicalAnalyst.run(
      buildInput(signal, 'trace-1', BARS, new AlwaysOpenCalendar()),
    );

    expect(view.key_points).toContain('Session VWAP (5m): no session to anchor to');
    expect(view.key_points.filter((line) => line.startsWith('Session VWAP (5m):'))).toHaveLength(1);
  });

  it('reports a real session-anchored VWAP and distance under a calendar with a session (#746)', async () => {
    const stocksSignal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };
    const view = await technicalAnalyst.run(
      buildInput(stocksSignal, 'trace-1', BARS, new UsEquityRegularHoursCalendar()),
    );

    const sessionLine = view.key_points.find((line) => line.startsWith('Session VWAP (5m):'));
    expect(sessionLine).toBeDefined();
    expect(sessionLine).toMatch(
      /^Session VWAP \(5m\): \d+(\.\d+)? — price \d+(\.\d+)? is [+-]?\d+(\.\d+)? from it$/,
    );
  });

  it('reports real avg volume for the 1h context read by default (#742)', async () => {
    const view = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    const contextLine = view.key_points.find((line) => line.startsWith('Context (1h):'));
    expect(contextLine).toBe(`Context (1h): ${CONTEXT_BAR_COUNT} candles, avg volume 1009.5`);
  });

  it('reports "unavailable", never a fabricated 0/NaN, for the 1h context read when no 1h bars exist (#742)', async () => {
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

    const honest = computeIndicator(ZIGZAG, RSI_SPEC);
    const narrower = computeIndicator(ZIGZAG.slice(-14), {
      indicator: 'rsi',
      params: { period: 13 },
      timeframe: TIMEFRAME,
      lookback: 14,
    });

    expect(honest).not.toBeCloseTo(narrower, 6);
    const momentum = view.key_points.find((line) => line.startsWith('Momentum (5m):'));
    expect(momentum).toContain(`RSI(14) ${honest}`);
  });

  it('rejects rather than reporting an RSI(14) it has only 14 bars for (#319)', async () => {
    await expect(
      technicalAnalyst.run(buildInput(signal, 'trace-1', ZIGZAG.slice(0, 14))),
    ).rejects.toThrow(InsufficientBarsError);
  });

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

    const momentum = view.key_points.find((line) => line.startsWith('Momentum (5m):'));
    expect(momentum).toContain('RSI(14) 50');
    expect(view.confidence).toBe(0);
    expect(view.direction).toBe('neutral');
    expect(view.key_points.some((line) => line.includes('confidence capped at 0.4'))).toBe(true);
  });

  it('holds no state across calls: an intervening call with different inputs does not affect a repeat call', async () => {
    const baseline = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    const otherSignal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };
    await technicalAnalyst.run(buildInput(otherSignal, 'trace-2'));

    const repeat = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(repeat).toEqual(baseline);
  });
});

describe('technicalAnalyst — bounded 5m bar fetches per instrument per tick (#742, #797)', () => {
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

  const LIVE_BARS: Bar[] = ((): Bar[] => {
    const start = new Date('2026-07-01T00:00:00Z').getTime();
    const bars = Array.from({ length: WARMUP_5M }, (_, i) => {
      const closeTime = new Date(start + i * BAR_INTERVAL_MS);
      const close = 100 + i;
      return {
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
      } satisfies Bar;
    });
    return [...bars, ...buildContextBars()];
  })();

  function buildLiveInput(signal: Signal): { input: AnalystInput; counting: CountingDataSource } {
    const asOf = LIVE_BARS.filter((bar) => bar.timeframe === TIMEFRAME).at(-1)?.close_time as Date;
    const clock = new ManualClock(asOf);
    const counting = new CountingDataSource(
      new FixtureDataSource(
        LIVE_BARS,
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
        bar: asOf,
        market_intelligence: marketIntelligence,
        market_data: marketData,
        calendar: new AlwaysOpenCalendar(),
        telemetry: NOOP_ANALYST_TELEMETRY,
      },
      counting,
    };
  }

  it('issues exactly two 5m DataSource.fetchBars calls — the shared warm-up and RVOL, never one per spec', async () => {
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };
    const { input, counting } = buildLiveInput(signal);

    await technicalAnalyst.run(input);

    expect(counting.fetchBarsCallsByTimeframe.get('5m')).toBe(2);
  });

  it('WARMUP_5M is wide enough to cover EVERY 5m spec, which is what makes the collapse hold', () => {
    for (const spec of [
      SMA_SPEC,
      RSI_SPEC,
      ATR_PCT_SPEC,
      MACD_SPEC,
      ADX_SPEC,
      SQUEEZE_SPEC,
      DONCHIAN_SPEC,
    ]) {
      expect(WARMUP_5M).toBeGreaterThanOrEqual(spec.lookback);
    }
  });
});
