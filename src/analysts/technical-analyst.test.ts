import type { Bar } from '../market-data-service/index.js';
import {
  FixtureDataSource,
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

function buildInput(signal: Signal, trace_id: string): AnalystInput {
  const clock = new ManualClock(ASOF);
  const dataSource = new FixtureDataSource(
    BARS,
    { price: 999, observed_at: ASOF, source: 'fixture-live' },
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
    timestamp: ASOF,
    asset_class: signal.asset_class,
    items: [
      {
        id: 'item-1',
        source: 'bloomberg',
        type: 'news',
        timestamp: ASOF,
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

  it('holds no state across calls: an intervening call with different inputs does not affect a repeat call', async () => {
    const baseline = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    const otherSignal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };
    await technicalAnalyst.run(buildInput(otherSignal, 'trace-2'));

    const repeat = await technicalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(repeat).toEqual(baseline);
  });
});
