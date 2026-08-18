import type { Bar } from '../../providers/market-data-service/index.js';
import {
  AlwaysOpenCalendar,
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { fundamentalAnalyst } from './fundamental-analyst.js';
import type { AnalystInput, Signal } from './types.js';
import { NO_DATA_MARKER, NOOP_ANALYST_TELEMETRY } from './types.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }
}

const INSTRUMENT = 'AAPL';
const ASOF = new Date('2026-07-14T12:00:00Z');

function buildInput(signal: Signal, trace_id: string, newsSentiment: 1 | 0 | -1 = 1): AnalystInput {
  const clock = new ManualClock(ASOF);
  const bars: Bar[] = [
    {
      instrument: signal.asset,
      timeframe: '1h',
      open_time: new Date(ASOF.getTime() - 60 * 60 * 1000),
      close_time: ASOF,
      open: 149,
      high: 151,
      low: 148,
      close: 150,
      volume: 1000,
      source: 'fixture',
    },
  ];
  const dataSource = new FixtureDataSource(
    bars,
    { price: 150, observed_at: ASOF, source: 'fixture-live' },
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
        source: 'sec-filing',
        type: 'news',
        timestamp: ASOF,
        entity: signal.asset,
        headline: 'Earnings beat estimates',
        sentiment: newsSentiment,
        confidence: 0.7,
      },
    ],
  });

  return {
    trace_id,
    signal,
    clock,
    market_intelligence: marketIntelligence,
    market_data: marketData,
    // #746: fundamental never reads it, but AnalystInput.calendar is
    // required, so every test-built input must inject one explicitly rather
    // than leave it undefined.
    calendar: new AlwaysOpenCalendar(),
    // #790: AnalystInput.telemetry is required too; this analyst has nothing
    // to report through it, so the no-op default is correct here.
    telemetry: NOOP_ANALYST_TELEMETRY,
  };
}

describe('fundamentalAnalyst', () => {
  const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

  it('applies only to stocks, not crypto', () => {
    expect(fundamentalAnalyst.applies_to('stocks')).toBe(true);
    expect(fundamentalAnalyst.applies_to('crypto')).toBe(false);
  });

  it('is mandatory', () => {
    expect(fundamentalAnalyst.role).toBe('mandatory');
  });

  it('produces a deterministic AnalystView from (Signal, asOf) given fixed MDS/MI responses', async () => {
    const first = await fundamentalAnalyst.run(buildInput(signal, 'trace-1'));
    const second = await fundamentalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(second).toEqual(first);
  });

  it('produces the fixed AnalystView shape', async () => {
    const view = await fundamentalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(view.analyst_type).toBe('fundamental');
    expect(['bullish', 'bearish', 'neutral']).toContain(view.direction);
    expect(view.confidence).toBeGreaterThanOrEqual(0);
    expect(view.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(view.key_points)).toBe(true);
    expect(view.timestamp).toEqual(ASOF);
  });

  it('reads bullish news as a bullish direction, bearish news as bearish', async () => {
    const bullish = await fundamentalAnalyst.run(buildInput(signal, 'trace-1', 1));
    const bearish = await fundamentalAnalyst.run(buildInput(signal, 'trace-2', -1));

    expect(bullish.direction).toBe('bullish');
    expect(bearish.direction).toBe('bearish');
  });

  it('holds no state across calls: an intervening call with different inputs does not affect a repeat call', async () => {
    const baseline = await fundamentalAnalyst.run(buildInput(signal, 'trace-1', 1));

    await fundamentalAnalyst.run(buildInput(signal, 'trace-2', -1));

    const repeat = await fundamentalAnalyst.run(buildInput(signal, 'trace-1', 1));

    expect(repeat).toEqual(baseline);
  });

  it('marks an EMPTY intelligence window as absent input, not a neutral read (#436)', async () => {
    // Sharper here than for sentiment: `fundamental` is MANDATORY for stocks,
    // so an equity debate runs one real analyst of three while this returns a
    // constant — and ADR-0007 removed the human gate that might have caught it.
    const clock = new ManualClock(ASOF);
    const empty = new MarketIntelligenceStore(clock);
    const input = { ...buildInput(signal, 'trace-empty'), market_intelligence: empty };

    const view = await fundamentalAnalyst.run(input);

    expect(view.key_points[0]).toContain(NO_DATA_MARKER);
    expect(view.key_points[0]).toContain('ABSENCE OF INPUT');
    expect(view.direction).toBe('neutral');
    expect(view.confidence).toBe(0.05);
  });

  it('does NOT mark a populated window', async () => {
    const view = await fundamentalAnalyst.run(buildInput(signal, 'trace-1'));

    expect(view.key_points.join(' ')).not.toContain(NO_DATA_MARKER);
  });
});
