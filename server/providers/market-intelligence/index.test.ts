import {
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
} from '../../pipeline/debate-engine/debate-log-store.js';
import type { Clock } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import { MarketIntelligenceStore } from './index.js';
import type { AgentIntelligence, IntelligenceItem, MarketContext } from './types.js';

class FixedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return this.at;
  }
}

class MutableClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  advanceTo(at: Date): void {
    this.at = at;
  }
}

function newsItem(overrides: Partial<IntelligenceItem> = {}): IntelligenceItem {
  return {
    id: 'deepresearch-bloomberg-AAPL-1',
    source: 'bloomberg',
    type: 'news',
    timestamp: new Date('2026-07-14T09:00:00Z'),
    entity: 'AAPL',
    headline: 'Apple beats earnings estimates',
    sentiment: 1,
    confidence: 0.9,
    ...overrides,
  };
}

function envelope(
  items: IntelligenceItem[],
  assetClass: 'crypto' | 'stocks' = 'stocks',
): AgentIntelligence {
  return {
    agent_id: 'deepresearch',
    timestamp: new Date('2026-07-14T09:00:00Z'),
    asset_class: assetClass,
    items,
  };
}

describe('MarketIntelligenceStore.getContext', () => {
  it('never returns context published after asOf', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(
      envelope([
        newsItem({ id: 'before', timestamp: new Date('2026-07-14T08:59:00Z') }),
        newsItem({ id: 'after', timestamp: new Date('2026-07-14T09:00:01Z') }),
      ]),
    );

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.news.map((item) => item.id)).toEqual(['before']);
  });

  it('includes an item exactly at asOf', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(envelope([newsItem({ id: 'at-asof', timestamp: asOf })]));

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.news.map((item) => item.id)).toEqual(['at-asof']);
  });

  it('excludes items older than the requested time window', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(
      envelope([
        newsItem({ id: 'too-old', timestamp: new Date('2026-07-14T08:00:00Z') }),
        newsItem({ id: 'in-window', timestamp: new Date('2026-07-14T08:59:00Z') }),
      ]),
    );

    const context = store.getContext('stocks', 5 * 60_000, 'trace-1');

    expect(context.news.map((item) => item.id)).toEqual(['in-window']);
  });

  it('filters by asset class', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(envelope([newsItem({ id: 'stock-item' })], 'stocks'));
    store.ingest(envelope([newsItem({ id: 'crypto-item', entity: 'BTC' })], 'crypto'));

    const stocksContext = store.getContext('stocks', 60_000, 'trace-1');
    const cryptoContext = store.getContext('crypto', 60_000, 'trace-1');

    expect(stocksContext.news.map((item) => item.id)).toEqual(['stock-item']);
    expect(cryptoContext.news.map((item) => item.id)).toEqual(['crypto-item']);
  });

  it('splits items into news vs social by type', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(
      envelope([
        newsItem({ id: 'news-item', type: 'news' }),
        newsItem({ id: 'social-item', type: 'sentiment', source: 'twitter' }),
      ]),
    );

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.news.map((item) => item.id)).toEqual(['news-item']);
    expect(context.social.map((item) => item.id)).toEqual(['social-item']);
  });

  it('runs the same code path live and in replay — only the injected clock differs', () => {
    const items = [
      newsItem({ id: 'in-range', timestamp: new Date('2026-07-14T08:59:00Z') }),
      newsItem({ id: 'future', timestamp: new Date('2026-07-14T09:01:00Z') }),
    ];

    const replayClock = new FixedClock(new Date('2026-07-14T09:00:00Z'));
    const replayStore = new MarketIntelligenceStore(replayClock);
    replayStore.ingest(envelope(items));
    const replayContext = replayStore.getContext('stocks', 60_000, 'trace-1');

    const liveClock = new SystemClock();
    const liveStore = new MarketIntelligenceStore(liveClock);
    const bar = floorToBar(liveClock.now(), DEBATE_BAR_TIMEFRAME_MS);
    liveStore.ingest(
      envelope([
        newsItem({ id: 'in-range', timestamp: new Date(bar.getTime() - 60_000) }),
        newsItem({ id: 'future', timestamp: new Date(bar.getTime() + 60_000) }),
      ]),
    );
    const liveContext = liveStore.getContext('stocks', 5 * 60_000, 'trace-1');

    expect(replayContext.news.map((item) => item.id)).toEqual(['in-range']);
    expect(liveContext.news.map((item) => item.id)).toEqual(['in-range']);
  });

  it('holds the item counts steady across two ticks inside one debate bar', () => {
    const clock = new MutableClock(new Date('2026-07-14T14:01:00Z'));
    const store = new MarketIntelligenceStore(clock);
    const window = 24 * 60 * 60 * 1000;
    store.ingest(envelope([newsItem({ timestamp: new Date('2026-07-13T14:30:00Z') })]));

    const firstTick = store.getContext('stocks', window, 'trace-1');

    clock.advanceTo(new Date('2026-07-14T14:40:00Z'));
    const secondTick = store.getContext('stocks', window, 'trace-2');

    expect(firstTick.news).toHaveLength(1);
    expect(secondTick.news.map((item) => item.id)).toEqual(firstTick.news.map((item) => item.id));
  });

  it('does not surface an item ingested mid-bar until the next bar opens', () => {
    const clock = new MutableClock(new Date('2026-07-14T14:01:00Z'));
    const store = new MarketIntelligenceStore(clock);

    clock.advanceTo(new Date('2026-07-14T14:30:00Z'));
    store.ingest(
      envelope([newsItem({ id: 'mid-bar', timestamp: new Date('2026-07-14T14:30:00Z') })]),
    );

    expect(store.getContext('stocks', 60 * 60_000, 'trace-1').news).toEqual([]);

    clock.advanceTo(new Date('2026-07-14T15:00:00Z'));
    expect(store.getContext('stocks', 60 * 60_000, 'trace-2').news.map((item) => item.id)).toEqual([
      'mid-bar',
    ]);
  });

  it('inherits the claimed decision bar instead of re-deriving one on a straddle (#811)', () => {
    const clock = new MutableClock(new Date('2026-07-14T13:59:55Z'));
    const store = new MarketIntelligenceStore(clock);
    const window = 5 * 60_000;

    const claimedBar = floorToBar(clock.now(), DEBATE_BAR_TIMEFRAME_MS);
    expect(claimedBar).toEqual(new Date('2026-07-14T13:00:00Z'));

    store.ingest(
      envelope([newsItem({ id: 'claimed-bar-item', timestamp: new Date('2026-07-14T12:59:00Z') })]),
    );

    clock.advanceTo(new Date('2026-07-14T14:00:05Z'));

    const context = store.getContext('stocks', window, 'trace-1', claimedBar);

    expect(context.news.map((item) => item.id)).toEqual(['claimed-bar-item']);
  });

  it('scopes to one entity when an entity filter is passed, leaving the rest of the class-wide bag out', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(
      envelope([
        newsItem({ id: 'aapl-item', entity: 'AAPL' }),
        newsItem({ id: 'tsla-item', entity: 'TSLA' }),
      ]),
    );

    const aaplContext = store.getContext('stocks', 60_000, 'trace-1', undefined, 'AAPL');
    const tslaContext = store.getContext('stocks', 60_000, 'trace-1', undefined, 'TSLA');

    expect(aaplContext.news.map((item) => item.id)).toEqual(['aapl-item']);
    expect(tslaContext.news.map((item) => item.id)).toEqual(['tsla-item']);
  });

  it('admits a class-wide item past an entity-scoped read via intel, and still keeps other entities out of news', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(
      envelope([
        newsItem({ id: 'aapl-item', entity: 'AAPL' }),
        newsItem({ id: 'tsla-item', entity: 'TSLA' }),
        newsItem({ id: 'macro-item', entity: 'FOMC-2026-09', scope: 'asset_class' }),
      ]),
    );

    const aaplContext = store.getContext('stocks', 60_000, 'trace-1', undefined, 'AAPL');

    expect(aaplContext.news.map((item) => item.id)).toEqual(['aapl-item']);
    expect(aaplContext.intel.map((item) => item.id)).toEqual(['macro-item']);
  });

  it('omitting the entity filter still returns the full class-wide bag — additive, not a breaking change', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(
      envelope([
        newsItem({ id: 'aapl-item', entity: 'AAPL' }),
        newsItem({ id: 'tsla-item', entity: 'TSLA' }),
      ]),
    );

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.news.map((item) => item.id).sort()).toEqual(['aapl-item', 'tsla-item']);
  });

  it('an entity with no items of its own returns empty even though the class-wide bag is non-empty', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(envelope([newsItem({ id: 'aapl-item', entity: 'AAPL' })]));

    const context = store.getContext('stocks', 60_000, 'trace-1', undefined, 'QQQ');

    expect(context.news).toEqual([]);
  });

  it('serves only the LATEST class-wide item per source, entity and type', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));
    const macro = (id: string, at: string): IntelligenceItem =>
      newsItem({
        id,
        source: 'gdelt-gkg',
        entity: 'GDELT-MACRO',
        scope: 'asset_class',
        timestamp: new Date(at),
      });

    store.ingest(
      envelope([
        macro('bar-07', '2026-07-14T07:00:00Z'),
        macro('bar-08', '2026-07-14T08:00:00Z'),
        macro('bar-09', '2026-07-14T09:00:00Z'),
      ]),
    );

    const context = store.getContext('stocks', 24 * 60 * 60_000, 'trace-1', undefined, 'SPY');

    expect(context.intel.map((item) => item.id)).toEqual(['bar-09']);
    expect(context.news).toEqual([]);
  });

  it('collapses class-wide items per macro series, not per source', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));
    const series = (entity: string, id: string): IntelligenceItem =>
      newsItem({ id, source: 'polymarket', entity, scope: 'asset_class' });

    store.ingest(envelope([series('FED-RATES', 'rates'), series('CPI', 'cpi')]));

    const context = store.getContext('stocks', 60_000, 'trace-1', undefined, 'SPY');

    expect(context.intel.map((item) => item.id).sort()).toEqual(['cpi', 'rates']);
    expect(context.news).toEqual([]);
  });

  it('leaves entity-scoped items alone — two articles about one ticker are two observations', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    store.ingest(
      envelope([
        newsItem({ id: 'first', entity: 'AAPL', timestamp: new Date('2026-07-14T08:59:00Z') }),
        newsItem({ id: 'second', entity: 'AAPL' }),
      ]),
    );

    const context = store.getContext('stocks', 60 * 60_000, 'trace-1', undefined, 'AAPL');

    expect(context.news.map((item) => item.id).sort()).toEqual(['first', 'second']);
  });

  it('routes a class-wide item to intel and excludes it from news, leaving an entity-scoped item in news', () => {
    const store = new MarketIntelligenceStore(new FixedClock(new Date('2026-07-14T09:00:00Z')));
    store.ingest(
      envelope([
        newsItem({ id: 'entity-item', entity: 'AAPL' }),
        newsItem({ id: 'class-wide-item', entity: 'GDELT-MACRO', scope: 'asset_class' }),
      ]),
    );

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.news.map((item) => item.id)).toEqual(['entity-item']);
    expect(context.intel.map((item) => item.id)).toEqual(['class-wide-item']);
  });

  it('routes a class-wide sentiment item to intel and excludes it from social', () => {
    const store = new MarketIntelligenceStore(new FixedClock(new Date('2026-07-14T09:00:00Z')));
    store.ingest(
      envelope([
        newsItem({
          id: 'class-wide-sentiment',
          type: 'sentiment',
          entity: 'GDELT-MACRO',
          scope: 'asset_class',
        }),
      ]),
    );

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.social).toEqual([]);
    expect(context.intel.map((item) => item.id)).toEqual(['class-wide-sentiment']);
  });
});

describe('MarketIntelligenceStore.ingest dedupe (#969)', () => {
  const AS_OF = new Date('2026-07-14T09:30:00Z');

  function store(): MarketIntelligenceStore {
    return new MarketIntelligenceStore(new FixedClock(AS_OF));
  }

  function socialItem(overrides: Partial<IntelligenceItem> = {}): IntelligenceItem {
    return newsItem({ id: 'x:1234567890', source: 'x', type: 'sentiment', ...overrides });
  }

  function social(s: MarketIntelligenceStore, entity: string): IntelligenceItem[] {
    return s.getContext('stocks', 60 * 60_000, 'trace-1', undefined, entity).social;
  }

  it('drops the SAME post repeated for the SAME instrument', () => {
    const s = store();

    s.ingest(envelope([socialItem()]));
    s.ingest(envelope([socialItem()]));

    expect(social(s, 'AAPL')).toHaveLength(1);
  });

  it('KEEPS the same post ingested as evidence for a different instrument', () => {
    const s = store();

    s.ingest(envelope([socialItem({ entity: 'AAPL' })]));
    s.ingest(envelope([socialItem({ entity: 'TSLA' })]));

    expect(social(s, 'AAPL')).toHaveLength(1);
    expect(social(s, 'TSLA')).toHaveLength(1);
  });

  it('does not notify subscribers again for an item it just dropped', () => {
    const s = store();
    let notifications = 0;
    s.subscribe('stocks', () => {
      notifications += 1;
    });

    s.ingest(envelope([socialItem()]));
    const afterFirst = notifications;
    s.ingest(envelope([socialItem()]));

    expect(notifications).toBe(afterFirst);
  });
});

describe('MarketIntelligenceStore staleness', () => {
  it('flags an asset with no recent update as stale', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.stale).toBe(true);
    expect(context.last_updated).toBeNull();
  });

  it('flags an asset stale once its last update exceeds the asset class threshold', () => {
    const asOf = new Date('2026-07-14T09:00:31Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));
    store.ingest(envelope([newsItem({ timestamp: new Date('2026-07-14T09:00:00Z') })], 'stocks'));

    const context = store.getContext('stocks', 5 * 60_000, 'trace-1');

    expect(context.stale).toBe(true);
    expect(context.last_updated).toEqual(new Date('2026-07-14T09:00:00Z'));
  });

  it('does not flag an asset as stale within the asset class threshold', () => {
    const asOf = new Date('2026-07-14T09:00:04Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));
    store.ingest(envelope([newsItem({ timestamp: new Date('2026-07-14T09:00:00Z') })], 'crypto'));

    const context = store.getContext('crypto', 60_000, 'trace-1');

    expect(context.stale).toBe(false);
    expect(context.last_updated).toEqual(new Date('2026-07-14T09:00:00Z'));
  });

  it('bases last_updated on the most recent ingested item, independent of timeWindow', () => {
    const asOf = new Date('2026-07-14T09:00:00Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));
    store.ingest(
      envelope(
        [
          newsItem({ id: 'older', timestamp: new Date('2026-07-14T08:00:00Z') }),
          newsItem({ id: 'newer', timestamp: new Date('2026-07-14T08:59:58Z') }),
        ],
        'stocks',
      ),
    );

    const context = store.getContext('stocks', 1_000, 'trace-1');

    expect(context.news).toEqual([]);
    expect(context.last_updated).toEqual(new Date('2026-07-14T08:59:58Z'));
  });
});

describe('MarketIntelligenceStore.subscribe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers new context events live to subscribers of the matching asset class', () => {
    const clock = new MutableClock(new Date('2026-07-14T09:00:00Z'));
    const store = new MarketIntelligenceStore(clock);
    const received: MarketContext[] = [];

    store.subscribe('stocks', (ctx) => received.push(ctx));
    store.ingest(envelope([newsItem({ id: 'live-1' })], 'stocks'));

    expect(received).toHaveLength(1);
    expect(received[0]?.news.map((item) => item.id)).toEqual(['live-1']);
  });

  it('does not deliver to subscribers of a different asset class', () => {
    const clock = new MutableClock(new Date('2026-07-14T09:00:00Z'));
    const store = new MarketIntelligenceStore(clock);
    const received: MarketContext[] = [];

    store.subscribe('crypto', (ctx) => received.push(ctx));
    store.ingest(envelope([newsItem({ id: 'stock-1' })], 'stocks'));

    expect(received).toHaveLength(0);
  });

  it('throttles a subscriber to at most one delivery per minute', () => {
    const clock = new MutableClock(new Date('2026-07-14T09:00:00Z'));
    const store = new MarketIntelligenceStore(clock);
    const received: MarketContext[] = [];

    store.subscribe('stocks', (ctx) => received.push(ctx));

    store.ingest(envelope([newsItem({ id: 'first' })], 'stocks'));
    clock.advanceTo(new Date('2026-07-14T09:00:30Z'));
    store.ingest(envelope([newsItem({ id: 'second', timestamp: clock.now() })], 'stocks'));

    expect(received).toHaveLength(1);
    expect(received[0]?.news.map((item) => item.id)).toEqual(['first']);

    clock.advanceTo(new Date('2026-07-14T09:01:01Z'));
    store.ingest(envelope([newsItem({ id: 'third', timestamp: clock.now() })], 'stocks'));

    expect(received).toHaveLength(2);
    expect(received[1]?.news.map((item) => item.id)).toEqual(['third']);
  });

  it('removes a subscription and logs an error when the callback throws, without blocking other subscribers', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clock = new MutableClock(new Date('2026-07-14T09:00:00Z'));
    const store = new MarketIntelligenceStore(clock);
    const received: MarketContext[] = [];

    store.subscribe('stocks', () => {
      throw new Error('boom');
    });
    store.subscribe('stocks', (ctx) => received.push(ctx));

    store.ingest(envelope([newsItem({ id: 'first' })], 'stocks'));

    expect(received).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    clock.advanceTo(new Date('2026-07-14T09:02:00Z'));
    store.ingest(envelope([newsItem({ id: 'second', timestamp: clock.now() })], 'stocks'));

    expect(received).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('removes a subscription after 3 slow (>5s) callback invocations and alerts', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let tick = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      tick += 1;
      return tick % 2 === 1 ? 0 : 6_000;
    });

    const clock = new MutableClock(new Date('2026-07-14T09:00:00Z'));
    const store = new MarketIntelligenceStore(clock);
    const received: MarketContext[] = [];
    store.subscribe('stocks', (ctx) => received.push(ctx));

    for (let i = 0; i < 3; i += 1) {
      clock.advanceTo(new Date(clock.now().getTime() + 61_000));
      store.ingest(envelope([newsItem({ id: `slow-${i}`, timestamp: clock.now() })], 'stocks'));
    }

    expect(received).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    clock.advanceTo(new Date(clock.now().getTime() + 61_000));
    store.ingest(envelope([newsItem({ id: 'slow-3', timestamp: clock.now() })], 'stocks'));

    expect(received).toHaveLength(3);
  });

  it('delivers the current staleness flag on push, not just on getContext', () => {
    const clock = new MutableClock(new Date('2026-07-14T09:00:00Z'));
    const store = new MarketIntelligenceStore(clock);
    const received: MarketContext[] = [];

    store.subscribe('stocks', (ctx) => received.push(ctx));
    store.ingest(envelope([newsItem({ id: 'fresh', timestamp: clock.now() })], 'stocks'));

    expect(received[0]?.stale).toBe(false);
  });
});
