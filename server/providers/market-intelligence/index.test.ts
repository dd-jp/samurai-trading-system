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
    // Re-anchor both items relative to the live clock's DEBATE BAR, not to raw
    // now — since #782 the window ends at `floorToBar(asOf)`, so "after asOf"
    // means after the bar's opening boundary. Anchoring to raw now would put
    // BOTH items past the window end at any wall-clock moment inside a bar,
    // and the test would assert the arithmetic of a rolling window this store
    // deliberately no longer has.
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

  /**
   * #782. The item counts are hashed into `debate_id` (via the technical
   * analyst's `key_points`) and drive `fundamental`/`sentiment` confidence, so
   * a count that moves between two ticks of ONE debate bar defeats the #617
   * same-bar short-circuit and hands the Trader a second confidence sample.
   *
   * The fixture is the leak exactly: with a rolling window the item is 23h31m
   * old at 14:01 (inside a 24h window) and 24h10m old at 14:40 (outside it).
   * Floored to the 14:00 bar, both reads measure the same 24h.
   */
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

  /**
   * #782, the other half: an item ingested MID-bar must not appear until the
   * next bar opens either. Same reason — the counts have to be a function of
   * the bar, and an arrival is as much a change as an expiry.
   */
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

  /**
   * #811. The claim lands at 13:59:5x (the gate floors it to the 13:00 bar);
   * the analyst read that consumes it does not execute until 14:00:05, after
   * the wall clock has already ticked into the 14:00 bar. Before #811,
   * `getContext` floored a SECOND, independent read of `clock.now()` — so this
   * pass's MI window would land on the 14:00 bar while the debate it feeds
   * stays keyed to 13:00, and the two disagree about which bar they belong to.
   *
   * The item sits just inside the 13:00-bar window and just outside the
   * 14:00-bar window, so the two derivations are falsifiable by inclusion: if
   * `getContext` ever re-floors `asOf` instead of using the passed `bar`, the
   * item drops out and this test goes red.
   */
  it('inherits the claimed decision bar instead of re-deriving one on a straddle (#811)', () => {
    const clock = new MutableClock(new Date('2026-07-14T13:59:55Z'));
    const store = new MarketIntelligenceStore(clock);
    const window = 5 * 60_000; // 5 minutes

    // Claimed while the wall clock was still inside the 13:00 bar — the same
    // derivation `DebateBarDecisionGate.claim` performs (floorToBar(asOf)).
    const claimedBar = floorToBar(clock.now(), DEBATE_BAR_TIMEFRAME_MS);
    expect(claimedBar).toEqual(new Date('2026-07-14T13:00:00Z'));

    // In the [12:55, 13:00] window the CLAIMED bar implies; NOT in the
    // [13:55, 14:00] window a fresh floor of 14:00:05 would imply.
    store.ingest(
      envelope([newsItem({ id: 'claimed-bar-item', timestamp: new Date('2026-07-14T12:59:00Z') })]),
    );

    // The clock ticks past the hour boundary before the analyst read runs —
    // the straddle #811 is filed against.
    clock.advanceTo(new Date('2026-07-14T14:00:05Z'));

    const context = store.getContext('stocks', window, 'trace-1', claimedBar);

    expect(context.news.map((item) => item.id)).toEqual(['claimed-bar-item']);
  });

  /**
   * #914. Before this, `getContext` filtered on `asset_class` only, so every
   * instrument in a class read the same class-wide bag — an item genuinely
   * about AAPL diluted (or, worse, silently stood in for) a read that should
   * have been about TSLA. The optional `entity` param scopes the read to one
   * instrument's own items, matching `IntelligenceItem.entity`.
   */
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
