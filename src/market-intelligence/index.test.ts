import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../shared/clock.js';
import { SystemClock } from '../shared/clock.js';
import { MarketIntelligenceStore } from './index.js';
import type { AgentIntelligence, IntelligenceItem, MarketContext } from './types.js';

class FixedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return this.at;
  }
}

/** Like FixedClock, but the current time can be advanced mid-test. */
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
    // Re-anchor "future" relative to real now so the live run exercises the
    // same before/after-asOf split as the replay run, via the same getContext code.
    const now = liveClock.now();
    liveStore.ingest(
      envelope([
        newsItem({ id: 'in-range', timestamp: new Date(now.getTime() - 60_000) }),
        newsItem({ id: 'future', timestamp: new Date(now.getTime() + 60_000) }),
      ]),
    );
    const liveContext = liveStore.getContext('stocks', 5 * 60_000, 'trace-1');

    expect(replayContext.news.map((item) => item.id)).toEqual(['in-range']);
    expect(liveContext.news.map((item) => item.id)).toEqual(['in-range']);
  });

  it('conflicts is always empty — conflict resolution is not ticketed under epic #52', () => {
    const store = new MarketIntelligenceStore(new FixedClock(new Date('2026-07-14T09:00:00Z')));
    store.ingest(envelope([newsItem()]));

    const context = store.getContext('stocks', 60_000, 'trace-1');

    expect(context.conflicts).toEqual([]);
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
    // stocks threshold is 30s; last item is 31s before asOf.
    const asOf = new Date('2026-07-14T09:00:31Z');
    const store = new MarketIntelligenceStore(new FixedClock(asOf));
    store.ingest(envelope([newsItem({ timestamp: new Date('2026-07-14T09:00:00Z') })], 'stocks'));

    const context = store.getContext('stocks', 5 * 60_000, 'trace-1');

    expect(context.stale).toBe(true);
    expect(context.last_updated).toEqual(new Date('2026-07-14T09:00:00Z'));
  });

  it('does not flag an asset as stale within the asset class threshold', () => {
    // crypto threshold is 5s; last item is 4s before asOf.
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

    // Small window (last 1s) that excludes both items from `news`, but last_updated
    // still reflects 'newer' since it looks at all ingested history, not just the window.
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
    clock.advanceTo(new Date('2026-07-14T09:00:30Z')); // 30s later, within throttle window
    store.ingest(envelope([newsItem({ id: 'second', timestamp: clock.now() })], 'stocks'));

    expect(received).toHaveLength(1);
    expect(received[0]?.news.map((item) => item.id)).toEqual(['first']);

    clock.advanceTo(new Date('2026-07-14T09:01:01Z')); // >1 minute after first delivery
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

    // Throwing subscriber was removed — a second ingest only reaches the surviving subscriber.
    clock.advanceTo(new Date('2026-07-14T09:02:00Z'));
    store.ingest(envelope([newsItem({ id: 'second', timestamp: clock.now() })], 'stocks'));

    expect(received).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('removes a subscription after 3 slow (>5s) callback invocations and alerts', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Each callback invocation reads performance.now() twice (start, end);
    // stub a 6-second (>5s) elapsed duration for every call.
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
      clock.advanceTo(new Date(clock.now().getTime() + 61_000)); // clear the 1/minute throttle
      store.ingest(envelope([newsItem({ id: `slow-${i}`, timestamp: clock.now() })], 'stocks'));
    }

    expect(received).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1); // alert on the 3rd slow delivery

    // Subscription was removed — a 4th ingest delivers nothing further.
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
