import { describe, expect, it } from 'vitest';
import { FixtureDataSource } from '../market-data-service/fixture-data-source.js';
import { MarketDataServiceImpl } from '../market-data-service/service.js';
import { SqliteMarketDataStore } from '../market-data-service/sqlite-market-data-store.js';
import type { Bar } from '../market-data-service/types.js';
import { MarketIntelligenceStore } from '../market-intelligence/index.js';
import type { Clock } from '../shared/clock.js';
import { openSharedStore } from '../shared/store/open-shared-store.js';
import { sentimentAnalyst } from './sentiment-analyst.js';
import type { AnalystInput, Signal } from './types.js';

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
});
