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
    bar: ASOF,
    market_intelligence: marketIntelligence,
    market_data: marketData,
    calendar: new AlwaysOpenCalendar(),
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

  describe('entity-scoped MI read (#914)', () => {
    it('direction and confidence differ between two instruments of the same class given different per-entity items in ONE shared store', async () => {
      const clock = new ManualClock(ASOF);
      const sharedStore = new MarketIntelligenceStore(clock);
      sharedStore.ingest({
        agent_id: 'deepresearch',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'aapl-1',
            source: 'sec-filing',
            type: 'news',
            timestamp: ASOF,
            entity: 'AAPL',
            headline: 'Apple beats estimates',
            sentiment: 1,
            confidence: 0.9,
          },
          {
            id: 'tsla-1',
            source: 'sec-filing',
            type: 'news',
            timestamp: ASOF,
            entity: 'TSLA',
            headline: 'Tesla misses estimates',
            sentiment: -1,
            confidence: 0.3,
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

      const aaplView = await fundamentalAnalyst.run(aaplInput);
      const tslaView = await fundamentalAnalyst.run(tslaInput);

      expect(aaplView.direction).toBe('bullish');
      expect(tslaView.direction).toBe('bearish');
      expect(aaplView.confidence).not.toBe(tslaView.confidence);
    });

    it('an instrument with no items of its own reports NO_DATA_MARKER even though the class-wide store holds other instruments items', async () => {
      const clock = new ManualClock(ASOF);
      const store = new MarketIntelligenceStore(clock);
      store.ingest({
        agent_id: 'deepresearch',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'aapl-1',
            source: 'sec-filing',
            type: 'news',
            timestamp: ASOF,
            entity: 'AAPL',
            headline: 'Apple beats estimates',
            sentiment: 1,
            confidence: 0.9,
          },
        ],
      });

      const qqqInput = {
        ...buildInput({ asset: 'QQQ', asset_class: 'stocks' }, 'trace-qqq'),
        market_intelligence: store,
      };

      const view = await fundamentalAnalyst.run(qqqInput);

      expect(view.key_points[0]).toContain(NO_DATA_MARKER);
      expect(view.direction).toBe('neutral');
      expect(view.confidence).toBe(0.05);
    });

    it('resolves an LSE ETP instrument through screeningInstrumentFor to its US underlying before querying MI', async () => {
      const clock = new ManualClock(ASOF);
      const store = new MarketIntelligenceStore(clock);
      store.ingest({
        agent_id: 'deepresearch',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'spy-1',
            source: 'sec-filing',
            type: 'news',
            timestamp: ASOF,
            entity: 'SPY',
            headline: 'S&P 500 rallies on rate-cut bets',
            sentiment: 1,
            confidence: 0.8,
          },
        ],
      });

      const etpInput = {
        ...buildInput({ asset: '3USL', asset_class: 'stocks' }, 'trace-3usl'),
        market_intelligence: store,
      };

      const view = await fundamentalAnalyst.run(etpInput);

      expect(view.direction).toBe('bullish');
      expect(view.key_points.join(' ')).not.toContain(NO_DATA_MARKER);
    });
  });

  describe('class-wide intel items (#1164)', () => {
    function ingestIntelOnly(
      clock: ManualClock,
      entity: string,
      sentiment: 1 | 0 | -1,
    ): MarketIntelligenceStore {
      const store = new MarketIntelligenceStore(clock);
      store.ingest({
        agent_id: 'polymarket',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'macro-1',
            source: 'polymarket',
            type: 'news',
            timestamp: ASOF,
            entity,
            scope: 'asset_class',
            headline: 'FOMC odds shift',
            sentiment,
            confidence: 0.8,
          },
        ],
      });
      return store;
    }

    it('an intel-only window (no news) still yields a non-neutral direction, not NO_DATA_MARKER', async () => {
      const clock = new ManualClock(ASOF);
      const store = ingestIntelOnly(clock, 'FOMC-2026-09', 1);
      const input = { ...buildInput(signal, 'trace-intel-only'), market_intelligence: store };

      const view = await fundamentalAnalyst.run(input);

      expect(view.direction).toBe('bullish');
      expect(view.confidence).toBe(0.8);
      expect(view.key_points.join(' ')).not.toContain(NO_DATA_MARKER);
    });

    it('reports news and intel counts distinctly in key_points rather than merging them silently', async () => {
      const clock = new ManualClock(ASOF);
      const store = ingestIntelOnly(clock, 'FOMC-2026-09', 1);
      store.ingest({
        agent_id: 'deepresearch',
        timestamp: ASOF,
        asset_class: 'stocks',
        items: [
          {
            id: 'news-1',
            source: 'sec-filing',
            type: 'news',
            timestamp: ASOF,
            entity: signal.asset,
            headline: 'Earnings beat estimates',
            sentiment: 1,
            confidence: 0.7,
          },
        ],
      });
      const input = { ...buildInput(signal, 'trace-both'), market_intelligence: store };

      const view = await fundamentalAnalyst.run(input);

      expect(view.key_points[0]).toContain('1 news');
      expect(view.key_points[0]).toContain('1 intel');
    });

    it('a NO_DATA window still reports absence when both news and intel are empty', async () => {
      const clock = new ManualClock(ASOF);
      const empty = new MarketIntelligenceStore(clock);
      const input = { ...buildInput(signal, 'trace-empty-both'), market_intelligence: empty };

      const view = await fundamentalAnalyst.run(input);

      expect(view.key_points[0]).toContain(NO_DATA_MARKER);
      expect(view.direction).toBe('neutral');
    });
  });
});
