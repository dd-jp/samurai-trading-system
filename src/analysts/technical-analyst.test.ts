import type { Bar } from '../market-data-service/index.js';
import {
  computeIndicator,
  FixtureDataSource,
  InsufficientBarsError,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../market-data-service/index.js';
import { MarketIntelligenceStore } from '../market-intelligence/index.js';
import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { technicalAnalyst } from './technical-analyst.js';
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
const TIMEFRAME = '1h';
const BAR_COUNT = 30;

/** A steady uptrend so SMA/RSI produce a non-neutral, deterministic reading. */
function buildBars(): Bar[] {
  const bars: Bar[] = [];
  const start = new Date('2026-07-14T00:00:00Z').getTime();
  for (let i = 0; i < BAR_COUNT; i++) {
    const closeTime = new Date(start + i * 60 * 60 * 1000);
    const close = 100 + i;
    bars.push({
      instrument: INSTRUMENT,
      timeframe: TIMEFRAME,
      open_time: new Date(closeTime.getTime() - 60 * 60 * 1000),
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

const BARS = buildBars();
const ASOF = BARS[BARS.length - 1].close_time;

function buildInput(signal: Signal, trace_id: string, bars: Bar[] = BARS): AnalystInput {
  const asOf = bars[bars.length - 1]?.close_time as Date;
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
   * spec was widened to `lookback: 15` with `period: 14` — the same shape
   * `atrIndicatorSpec` carries.
   *
   * Zig-zag closes, not the module's steady uptrend: a monotonic series has
   * `avgLoss === 0`, so `rsi` short-circuits to 100 and a 13-change window is
   * indistinguishable from a 14-change one. This fixture is what makes the
   * width observable.
   */
  const ZIGZAG = ((): Bar[] => {
    const start = new Date('2026-07-14T00:00:00Z').getTime();
    return Array.from({ length: 20 }, (_, i) => {
      const closeTime = new Date(start + i * 60 * 60 * 1000);
      const close = 100 + Math.sin(i / 2) * 5 + i * 0.3;
      return {
        instrument: INSTRUMENT,
        timeframe: TIMEFRAME,
        open_time: new Date(closeTime.getTime() - 60 * 60 * 1000),
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

    // Recomputed from the same bars with the honest spec: 15 bars, period 14.
    const honest = computeIndicator(ZIGZAG.slice(-15), {
      indicator: 'rsi',
      params: { period: 14 },
      lookback: 15,
    });
    // The nearest computable stand-in for what it used to report. The exact
    // old value — 13 changes divided by 14 — is no longer expressible: the
    // guard is what stops `computeIndicator` producing it. An honest RSI(13)
    // over the same 14-bar window is the same WIDTH of history, and it
    // differs, which is what makes the assertion above evidence rather than a
    // coincidence: the analyst could not have printed `honest` off 14 bars.
    const narrower = computeIndicator(ZIGZAG.slice(-14), {
      indicator: 'rsi',
      params: { period: 13 },
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

  it('holds no state across calls: an intervening call with different inputs does not affect a repeat call', async () => {
    const baseline = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    const otherSignal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };
    await technicalAnalyst.run(buildInput(otherSignal, 'trace-2'));

    const repeat = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(repeat).toEqual(baseline);
  });
});
