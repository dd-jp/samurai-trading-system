/**
 * Market Intelligence — see docs/specs/market-intelligence-spec.md, epic #52.
 * Ticket #68: core news/sentiment context serving (getContext, pull mode).
 * Ticket #69: push (subscribe) + staleness. Agent orchestration and conflict
 * resolution are not ticketed under epic #52 and are not implemented here.
 */
import type { Clock } from '../shared/index.js';
import type {
  AgentIntelligence,
  AssetClass,
  Duration,
  IntelligenceItem,
  MarketContext,
  MarketContextCallback,
} from './types.js';

export type {
  AgentIntelligence,
  AssetClass,
  ConflictResolution,
  Duration,
  IntelligenceItem,
  MarketContext,
  MarketContextCallback,
} from './types.js';
export type { CiiConsumerConfig, CiiScoreProvider } from './worldmonitor-adapter/cii-consumer.js';
export { CiiConsumer } from './worldmonitor-adapter/cii-consumer.js';

interface StoredItem {
  asset_class: AssetClass;
  item: IntelligenceItem;
}

interface Subscription {
  asset_class: AssetClass;
  callback: MarketContextCallback;
  lastDelivered: Date | null;
  slowCount: number;
}

/**
 * Staleness thresholds per asset class (#69). The spec ("Module: Data
 * Delivery") does not define a dedicated context-staleness threshold, so
 * this reuses the agent latency budgets from the spec's "Latency Budget
 * Trade-offs" section (crypto 5s, stocks 30s) — the same cadence the system
 * already treats as "on time" for ingestion.
 */
const STALENESS_THRESHOLD_MS: Record<AssetClass, number> = {
  crypto: 5_000,
  stocks: 30_000,
};

/** Spec: "Throttle: max 1 update per minute per subscriber". */
const SUBSCRIBER_THROTTLE_MS = 60_000;
/** Spec: "If analyst is slow to process (callback takes > 5s), log warning". */
const SLOW_CALLBACK_MS = 5_000;
/** Spec: "If analyst callback fails repeatedly (3 times), remove subscription and alert". */
const MAX_SLOW_CALLBACKS = 3;

/**
 * In-memory store + pull-mode serving for news/sentiment intelligence.
 * The store holds the injected Clock (consumers stay clock-blind) so getContext
 * resolves `asOf = clock.now()` internally — the same pattern as MarketDataService
 * (docs/specs/market-data-service-spec.md). Swapping the Clock implementation
 * (SystemClock live vs. a simulated clock in replay) is the only thing that
 * changes between live and replay; getContext itself has no live/replay branch.
 */
export class MarketIntelligenceStore {
  private readonly stored: StoredItem[] = [];
  private readonly subscriptions: Subscription[] = [];

  constructor(private readonly clock: Clock) {}

  /**
   * Records one agent-produced batch. No persistence (spec: restart-clean) —
   * this is purely an in-memory seam for future DeepResearch/Grok agent
   * tickets to feed into; asset_class is carried on the envelope, not per item.
   * Also drives push delivery (#69): subscribers for this asset class are
   * notified with the newly ingested items, subject to throttling.
   */
  ingest(intelligence: AgentIntelligence): void {
    for (const item of intelligence.items) {
      this.stored.push({ asset_class: intelligence.asset_class, item });
    }
    if (intelligence.items.length > 0) {
      this.notifySubscribers(intelligence.asset_class, intelligence.items);
    }
  }

  /**
   * Returns point-in-time news/sentiment context for one asset class.
   * `asOf` is resolved from the injected clock, never from item timestamps or
   * wall-clock `Date.now()` directly — this is what makes the no-lookahead
   * guarantee hold under replay. Only items with
   * `asOf - timeWindow <= item.timestamp <= asOf` are returned; an item
   * published after `asOf` is never returned.
   */
  getContext(assetClass: AssetClass, timeWindow: Duration, _trace_id: string): MarketContext {
    const asOf = this.clock.now();
    const windowStart = asOf.getTime() - timeWindow;

    const inWindow = this.stored
      .filter((entry) => entry.asset_class === assetClass)
      .map((entry) => entry.item)
      .filter(
        (item) =>
          item.timestamp.getTime() <= asOf.getTime() && item.timestamp.getTime() >= windowStart,
      );

    const lastUpdated = this.lastUpdated(assetClass, asOf);

    return {
      timestamp: asOf,
      asset_class: assetClass,
      news: inWindow.filter((item) => item.type === 'news'),
      social: inWindow.filter((item) => item.type === 'sentiment'),
      conflicts: [],
      last_updated: lastUpdated,
      stale: this.isStale(assetClass, asOf, lastUpdated),
    };
  }

  /**
   * Registers a push subscriber for one asset class (#69). No `trace_id`
   * param — per docs/specs/cross-spec-contracts.md (GAP-J), push updates
   * fire asynchronously outside any single tick, so there is no one tick to
   * attribute them to.
   */
  subscribe(assetClass: AssetClass, callback: MarketContextCallback): void {
    this.subscriptions.push({
      asset_class: assetClass,
      callback,
      lastDelivered: null,
      slowCount: 0,
    });
  }

  /** Most recent item timestamp for an asset class, at or before `asOf`. Null if none yet. */
  private lastUpdated(assetClass: AssetClass, asOf: Date): Date | null {
    const timestamps = this.stored
      .filter(
        (entry) =>
          entry.asset_class === assetClass && entry.item.timestamp.getTime() <= asOf.getTime(),
      )
      .map((entry) => entry.item.timestamp.getTime());
    return timestamps.length === 0 ? null : new Date(Math.max(...timestamps));
  }

  private isStale(assetClass: AssetClass, asOf: Date, lastUpdated: Date | null): boolean {
    if (lastUpdated === null) {
      return true;
    }
    return asOf.getTime() - lastUpdated.getTime() > STALENESS_THRESHOLD_MS[assetClass];
  }

  /**
   * Delivers the just-ingested items to subscribers of this asset class, as
   * a MarketContext scoped to those items only (not the full history) — the
   * "new context event" the acceptance criteria describes, distinct from
   * getContext's windowed query semantics.
   */
  private notifySubscribers(assetClass: AssetClass, newItems: IntelligenceItem[]): void {
    const subscribers = this.subscriptions.filter((sub) => sub.asset_class === assetClass);
    if (subscribers.length === 0) {
      return;
    }

    const asOf = this.clock.now();
    const inWindow = newItems.filter((item) => item.timestamp.getTime() <= asOf.getTime());
    if (inWindow.length === 0) {
      return;
    }

    const lastUpdated = this.lastUpdated(assetClass, asOf);
    const context: MarketContext = {
      timestamp: asOf,
      asset_class: assetClass,
      news: inWindow.filter((item) => item.type === 'news'),
      social: inWindow.filter((item) => item.type === 'sentiment'),
      conflicts: [],
      last_updated: lastUpdated,
      stale: this.isStale(assetClass, asOf, lastUpdated),
    };

    for (const sub of subscribers) {
      this.deliverIfDue(sub, context, asOf);
    }
  }

  private deliverIfDue(sub: Subscription, context: MarketContext, asOf: Date): void {
    if (
      sub.lastDelivered !== null &&
      asOf.getTime() - sub.lastDelivered.getTime() < SUBSCRIBER_THROTTLE_MS
    ) {
      return;
    }
    sub.lastDelivered = asOf;

    const start = performance.now();
    try {
      sub.callback(context);
    } catch (error) {
      this.removeSubscription(sub);
      console.error(
        `[market-intelligence] subscriber callback threw for asset_class=${sub.asset_class}, removing subscription:`,
        error,
      );
      return;
    }

    const durationMs = performance.now() - start;
    if (durationMs > SLOW_CALLBACK_MS) {
      sub.slowCount += 1;
      console.warn(
        `[market-intelligence] subscriber callback slow (${durationMs.toFixed(0)}ms) for asset_class=${sub.asset_class}`,
      );
      if (sub.slowCount >= MAX_SLOW_CALLBACKS) {
        this.removeSubscription(sub);
        console.error(
          `[market-intelligence] subscriber callback slow ${MAX_SLOW_CALLBACKS} times for asset_class=${sub.asset_class}, removing subscription and alerting`,
        );
      }
    }
  }

  private removeSubscription(sub: Subscription): void {
    const index = this.subscriptions.indexOf(sub);
    if (index !== -1) {
      this.subscriptions.splice(index, 1);
    }
  }
}
export {
  floorToRefreshBucket,
  GROK_REFRESH_MS,
  GrokAgent,
  type GrokAgentDeps,
  type GrokSentimentClient,
  type GrokSpendSink,
} from './grok/grok-agent.js';
export { XaiGrokClient, type XaiGrokClientOptions } from './grok/xai-client.js';
