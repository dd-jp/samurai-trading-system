import { describe, expect, it } from 'vitest';
import { FixtureDataSource } from '../market-data-service/fixture-data-source.js';
import { MarketDataServiceImpl } from '../market-data-service/service.js';
import { SqliteMarketDataStore } from '../market-data-service/sqlite-market-data-store.js';
import type { Bar } from '../market-data-service/types.js';
import { MarketIntelligenceStore } from '../market-intelligence/index.js';
import type { Clock } from '../shared/clock.js';
import { openSharedStore } from '../shared/store/open-shared-store.js';
import { AnalystOrchestrator } from './orchestrator.js';
import type { Analyst, AnalystInput, AnalystView, AssetClass, Signal } from './types.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }
}

const INSTRUMENT = 'BTC-USD';
const TIMEFRAME = '1h';
const BAR_COUNT = 30;
const START = new Date('2026-07-14T00:00:00Z').getTime();

function buildBars(): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const closeTime = new Date(START + i * 60 * 60 * 1000);
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

function buildDeps(assetClass: AssetClass) {
  const clock = new ManualClock(ASOF);
  const dataSource = new FixtureDataSource(
    BARS,
    { price: 999, observed_at: ASOF, source: 'fixture-live' },
    assetClass,
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
    asset_class: assetClass,
    items: [
      {
        id: 'item-news',
        source: 'bloomberg',
        type: 'news',
        timestamp: ASOF,
        entity: INSTRUMENT,
        headline: 'Steady uptrend continues',
        sentiment: 1,
        confidence: 0.6,
      },
      {
        id: 'item-social',
        source: 'twitter',
        type: 'sentiment',
        timestamp: ASOF,
        entity: INSTRUMENT,
        headline: 'Crowd is bullish',
        sentiment: 1,
        confidence: 0.5,
      },
    ],
  });

  return { clock, marketData, marketIntelligence };
}

function stubAnalyst(
  analyst_type: string,
  role: 'mandatory' | 'optional',
  behavior: 'succeed' | 'fail',
): Analyst {
  return {
    analyst_type,
    role,
    applies_to: () => true,
    async run(input: AnalystInput): Promise<AnalystView> {
      if (behavior === 'fail') {
        throw new Error(`${analyst_type} unavailable`);
      }
      return {
        trace_id: input.trace_id,
        analyst_id: analyst_type,
        analyst_type,
        direction: 'bullish',
        confidence: 0.5,
        key_points: [],
        timestamp: input.clock.now(),
      };
    },
  };
}

describe('AnalystOrchestrator', () => {
  it('runs Technical + Sentiment for crypto (Fundamental excluded)', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('crypto');
    const orchestrator = new AnalystOrchestrator({
      market_data: marketData,
      market_intelligence: marketIntelligence,
    });
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'crypto' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock);

    expect(result.analyst_count).toBe(2);
    expect(result.skipped).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.views.map((v) => v.analyst_type).sort()).toEqual(['sentiment', 'technical']);
  });

  it('runs Technical + Fundamental + Sentiment for stocks', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('stocks');
    const orchestrator = new AnalystOrchestrator({
      market_data: marketData,
      market_intelligence: marketIntelligence,
    });
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock);

    expect(result.analyst_count).toBe(3);
    expect(result.skipped).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.views.map((v) => v.analyst_type).sort()).toEqual([
      'fundamental',
      'sentiment',
      'technical',
    ]);
  });

  it('blocks the handoff (quorum-miss) when a mandatory persona fails', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('stocks');
    const personas = [
      stubAnalyst('technical', 'mandatory', 'fail'),
      stubAnalyst('fundamental', 'mandatory', 'succeed'),
      stubAnalyst('sentiment', 'optional', 'succeed'),
    ];
    const orchestrator = new AnalystOrchestrator(
      { market_data: marketData, market_intelligence: marketIntelligence },
      personas,
    );
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock);

    expect(result.skipped).toBe(true);
    expect(result.views).toEqual([]);
    expect(result.failures).toContainEqual({
      analyst_type: 'technical',
      role: 'mandatory',
      reason: 'technical unavailable',
    });

    // The exact TickSteps.analysts shape must also report the skip as an empty array.
    const stepResult = await orchestrator.analysts({ trace_id: 'trace-1', signal, clock });
    expect(stepResult).toEqual([]);
  });

  it('proceeds with the reduced set when only the optional persona fails', async () => {
    const { clock, marketData, marketIntelligence } = buildDeps('stocks');
    const personas = [
      stubAnalyst('technical', 'mandatory', 'succeed'),
      stubAnalyst('fundamental', 'mandatory', 'succeed'),
      stubAnalyst('sentiment', 'optional', 'fail'),
    ];
    const orchestrator = new AnalystOrchestrator(
      { market_data: marketData, market_intelligence: marketIntelligence },
      personas,
    );
    const signal: Signal = { asset: INSTRUMENT, asset_class: 'stocks' };

    const result = await orchestrator.runAnalysts('trace-1', signal, clock);

    expect(result.skipped).toBe(false);
    expect(result.views.map((v) => v.analyst_type).sort()).toEqual(['fundamental', 'technical']);
    expect(result.failures).toEqual([
      { analyst_type: 'sentiment', role: 'optional', reason: 'sentiment unavailable' },
    ]);
  });
});
