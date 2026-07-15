import { describe, expect, it } from 'vitest';
import type { Clock } from '../shared/clock.js';
import { SystemClock } from '../shared/clock.js';
import { MarketIntelligenceStore } from './index.js';
import type { AgentIntelligence, IntelligenceItem } from './types.js';

class FixedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return this.at;
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
