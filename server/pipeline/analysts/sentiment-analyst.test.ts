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
import { sentimentAnalyst } from './sentiment-analyst.js';
import { type AnalystInput, NO_DATA_MARKER, NOOP_ANALYST_TELEMETRY, type Signal } from './types.js';

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
    bar: ASOF,
    market_intelligence: marketIntelligence,
    market_data: marketData,
    calendar: new AlwaysOpenCalendar(),
    telemetry: NOOP_ANALYST_TELEMETRY,
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
    const clock = new ManualClock(ASOF);
    const empty = new MarketIntelligenceStore(clock);
    const input = { ...buildInput(signal, 'trace-empty'), market_intelligence: empty };

    const view = await sentimentAnalyst.run(input);

    expect(view.key_points[0]).toContain(NO_DATA_MARKER);
    expect(view.key_points[0]).toContain('ABSENCE OF INPUT');
    expect(view.direction).toBe('neutral');
    expect(view.confidence).toBe(0.05);
  });

  it('does NOT mark a populated window', async () => {
    const view = await sentimentAnalyst.run(buildInput(signal, 'trace-1'));

    expect(view.key_points.join(' ')).not.toContain(NO_DATA_MARKER);
  });

  describe('entity-scoped MI read (#914)', () => {
    it('direction and confidence differ between two instruments of the same class given different per-entity items in ONE shared store', async () => {
      const clock = new ManualClock(ASOF);
      const sharedStore = new MarketIntelligenceStore(clock);
      sharedStore.ingest({
        agent_id: 'grok',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'aapl-1',
            source: 'twitter',
            type: 'sentiment',
            timestamp: ASOF,
            entity: 'AAPL',
            headline: 'Bullish chatter on AAPL',
            sentiment: 1,
            confidence: 0.8,
          },
          {
            id: 'tsla-1',
            source: 'twitter',
            type: 'sentiment',
            timestamp: ASOF,
            entity: 'TSLA',
            headline: 'Bearish chatter on TSLA',
            sentiment: -1,
            confidence: 0.4,
          },
        ],
      });

      const aaplInput = {
        ...buildInput({ asset: 'AAPL', asset_class: 'stocks' }, 'trace-aapl'),
        market_intelligence: sharedStore,
      };
      const tslaInput = {
        ...buildInput({ asset: 'TSLA', asset_class: 'stocks' }, 'trace-tsla'),
        market_intelligence: sharedStore,
      };

      const aaplView = await sentimentAnalyst.run(aaplInput);
      const tslaView = await sentimentAnalyst.run(tslaInput);

      expect(aaplView.direction).toBe('bullish');
      expect(tslaView.direction).toBe('bearish');
      expect(aaplView.confidence).not.toBe(tslaView.confidence);
    });

    it('an instrument with no items of its own reports NO_DATA_MARKER even though the class-wide store holds other instruments items', async () => {
      const clock = new ManualClock(ASOF);
      const store = new MarketIntelligenceStore(clock);
      store.ingest({
        agent_id: 'grok',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'aapl-1',
            source: 'twitter',
            type: 'sentiment',
            timestamp: ASOF,
            entity: 'AAPL',
            headline: 'Bullish chatter on AAPL',
            sentiment: 1,
            confidence: 0.8,
          },
        ],
      });

      const qqqInput = {
        ...buildInput({ asset: 'QQQ', asset_class: 'stocks' }, 'trace-qqq'),
        market_intelligence: store,
      };

      const view = await sentimentAnalyst.run(qqqInput);

      expect(view.key_points[0]).toContain(NO_DATA_MARKER);
      expect(view.direction).toBe('neutral');
      expect(view.confidence).toBe(0.05);
    });

    it('resolves an LSE ETP instrument through screeningInstrumentFor to its US underlying before querying MI', async () => {
      const clock = new ManualClock(ASOF);
      const store = new MarketIntelligenceStore(clock);
      store.ingest({
        agent_id: 'grok',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'spy-1',
            source: 'twitter',
            type: 'sentiment',
            timestamp: ASOF,
            entity: 'SPY',
            headline: 'Bullish chatter on SPY',
            sentiment: 1,
            confidence: 0.7,
          },
        ],
      });

      const etpInput = {
        ...buildInput({ asset: '3USL', asset_class: 'stocks' }, 'trace-3usl'),
        market_intelligence: store,
      };

      const view = await sentimentAnalyst.run(etpInput);

      expect(view.direction).toBe('bullish');
      expect(view.key_points.join(' ')).not.toContain(NO_DATA_MARKER);
    });
  });
});
