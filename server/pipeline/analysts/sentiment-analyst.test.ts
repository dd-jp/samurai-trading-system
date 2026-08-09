import type { Bar } from '../../providers/market-data-service/index.js';
import {
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
} from '../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../providers/market-intelligence/index.js';
import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { sentimentAnalyst } from './sentiment-analyst.js';
import type { AnalystInput, Signal } from './types.js';
import { NO_DATA_MARKER } from './types.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }
}

const INSTRUMENT = 'BTC-USD';
const ASOF = new Date('2026-07-14T12:00:00Z');

function buildInput(
  signal: Signal,
  trace_id: string,
  socialSentiment: 1 | 0 | -1 = 1,
): AnalystInput {
  const clock = new ManualClock(ASOF);
  const bars: Bar[] = [
    {
      instrument: signal.asset,
      timeframe: '1h',
      open_time: new Date(ASOF.getTime() - 60 * 60 * 1000),
      close_time: ASOF,
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volume: 500,
      source: 'fixture',
    },
  ];
  const dataSource = new FixtureDataSource(
    bars,
    { price: 100, observed_at: ASOF, source: 'fixture-live' },
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
    agent_id: 'grok',
    timestamp: ASOF,
    asset_class: signal.asset_class,
    items: [
      {
        id: 'item-1',
        source: 'twitter',
        type: 'sentiment',
        timestamp: ASOF,
        entity: signal.asset,
        headline: 'Crowd chatter',
        sentiment: socialSentiment,
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

describe('sentimentAnalyst', () => {
  const signal: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };

  it('applies to both crypto and stocks', () => {
    expect(sentimentAnalyst.applies_to('crypto')).toBe(true);
    expect(sentimentAnalyst.applies_to('stocks')).toBe(true);
  });

  it('is optional', () => {
    expect(sentimentAnalyst.role).toBe('optional');
  });

  it('produces a deterministic AnalystView from (Signal, asOf) given fixed MDS/MI responses', async () => {
    const first = await sentimentAnalyst.run(buildInput(signal, 'trace-1'));
    const second = await sentimentAnalyst.run(buildInput(signal, 'trace-1'));

    expect(second).toEqual(first);
  });

  it('produces the fixed AnalystView shape', async () => {
    const view = await sentimentAnalyst.run(buildInput(signal, 'trace-1'));

    expect(view.analyst_type).toBe('sentiment');
    expect(['bullish', 'bearish', 'neutral']).toContain(view.direction);
    expect(view.confidence).toBeGreaterThanOrEqual(0);
    expect(view.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(view.key_points)).toBe(true);
    expect(view.timestamp).toEqual(ASOF);
  });

  it('reads bullish social chatter as bullish, bearish as bearish', async () => {
    const bullish = await sentimentAnalyst.run(buildInput(signal, 'trace-1', 1));
    const bearish = await sentimentAnalyst.run(buildInput(signal, 'trace-2', -1));

    expect(bullish.direction).toBe('bullish');
    expect(bearish.direction).toBe('bearish');
  });

  it('holds no state across calls: an intervening call with different inputs does not affect a repeat call', async () => {
    const baseline = await sentimentAnalyst.run(buildInput(signal, 'trace-1', 1));

    await sentimentAnalyst.run(buildInput(signal, 'trace-2', -1));

    const repeat = await sentimentAnalyst.run(buildInput(signal, 'trace-1', 1));

    expect(repeat).toEqual(baseline);
  });

  it('marks an EMPTY intelligence window as absent input, not a neutral read (#436)', async () => {
    // `MarketIntelligenceStore` has no writer in production, so this is what
    // every real tick looks like today. The old text ("0 social items in
    // window, net sentiment driving neutral") is indistinguishable in a debate
    // transcript from "the analyst looked and saw nothing bullish" — and a
    // 14-day soak's own output would read that way for two weeks.
    const clock = new ManualClock(ASOF);
    const empty = new MarketIntelligenceStore(clock);
    const input = { ...buildInput(signal, 'trace-empty'), market_intelligence: empty };

    const view = await sentimentAnalyst.run(input);

    expect(view.key_points[0]).toContain(NO_DATA_MARKER);
    expect(view.key_points[0]).toContain('ABSENCE OF INPUT');
    // Still neutral and still low-confidence — the marker changes what the
    // debate is TOLD, not the arithmetic. Pinned so a later change to one is
    // not mistaken for a change to the other.
    expect(view.direction).toBe('neutral');
    expect(view.confidence).toBe(0.05);
  });

  it('does NOT mark a populated window', async () => {
    const view = await sentimentAnalyst.run(buildInput(signal, 'trace-1'));

    expect(view.key_points.join(' ')).not.toContain(NO_DATA_MARKER);
  });
});
