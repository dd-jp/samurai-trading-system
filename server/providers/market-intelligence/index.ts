/**
 * Market Intelligence — see docs/specs/market-intelligence-spec.md, epic #52.
 * Ticket #68: core news/sentiment context serving (getContext, pull mode).
 * Ticket #69: push (subscribe) + staleness. Agent orchestration and conflict
 * resolution are not ticketed under epic #52 and are not implemented here.
 */
// The bar grid, imported from its one defining module rather than restated
// here (`decide.ts`: "the grid now has exactly one statement in the system").
// `debate-log-store.ts` is imported directly instead of the debate-engine
// barrel so this provider does not pull the engine's module graph; the file
// itself has only type imports.
import {
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
} from '../../pipeline/debate-engine/debate-log-store.js';
import type { Clock } from '../../shared/index.js';
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
   * `windowEnd - timeWindow <= item.timestamp <= windowEnd` are returned; an
   * item published after `windowEnd` is never returned.
   *
   * ## Why the window is FLOORED to the debate bar (#782)
   *
   * `windowEnd` is not the raw clock read: it is `floorToBar(asOf)`, the same
   * grid and the same function the decision gate keys a debate to. The raw
   * clock read gave a ROLLING window, so an item ageing out of it — or one
   * ingested mid-bar — changed `news.length`/`social.length` between two ticks
   * of ONE debate bar. Three things read those counts, and none of them should
   * move within a bar:
   *
   *   1. `technical-analyst.ts` puts them verbatim in `key_points`
   *      ("MI context: N news, M social items in window"), and `key_points` is
   *      hashed into `debate_id` (`debate-id.ts`). A changed count is a changed
   *      id, which misses the #617 same-bar short-circuit and pays for a second
   *      debate on a bar that already has one.
   *   2. `sentiment-analyst.ts` derives `direction` AND `confidence` from
   *      `social`, and `fundamental-analyst.ts` does the same from `news`. This
   *      is the part that is not merely a spend leak: a second, different
   *      confidence sample on the same bar is what
   *      `scale_in_conviction_delta` can turn into an extra lot.
   *   3. `mi-coverage.ts` counts coverage over the SAME 24h window on purpose
   *      ("the same window the debate itself sees"), so it must floor with the
   *      analysts or start disagreeing with them mid-bar.
   *
   * Every other analyst input is already sampled on a bar grid (`getBars` /
   * `getIndicator` pin to `barIndex(timeframe, asOf)`); MI was the one
   * wall-clock sample left. Flooring makes it a function of closed bars too.
   * It does NOT make the views byte-identical within a 1h debate bar — the
   * technical read is 5m since #742, so its readings still move on the 5m grid
   * (see `debate-log-store.ts`'s AMENDED 2026-08-17 note). This closes the
   * wall-clock input, not that one.
   *
   * ## What it deliberately does not do
   *
   * No throw, no gate, no new branch: an empty store still returns an empty
   * context, which market-intelligence-spec.md is explicit about ("emit empty
   * intelligence, never block the pipeline"). Flooring can only move
   * `windowEnd` BACKWARDS, so the no-lookahead guarantee is strengthened, never
   * weakened, and the cost is that an item ingested mid-bar is not visible
   * until the next bar opens — at most one hour of latency against a 24h
   * window, on a path whose consumer (the debate) runs once per bar anyway.
   *
   * `last_updated`/`stale` stay on the UNFLOORED read. They are the operational
   * "how fresh is ingestion" signal (`STALENESS_THRESHOLD_MS` is 5s/30s — a
   * wall-clock question), no production consumer reads either field, and
   * neither is hashed. Quantising them to the hour would only make `stale`
   * vacuously true. The consequence, stated because it was impossible before:
   * the two halves of a `MarketContext` can now disagree. An item ingested at
   * 14:30 sets `last_updated: 14:30, stale: false` while `news`/`social` are
   * still empty until 15:00, so a caller reading both must NOT conclude
   * "ingestion is fresh and there is genuinely no news". Read the item lists
   * for what the debate saw; read `last_updated`/`stale` only for whether the
   * ingest agents are alive.
   *
   * KNOWN LIMIT, stated rather than claimed away: this floors a SECOND clock
   * read rather than inheriting the gate's `decision_bar.open_time` — the
   * two-derivations shape `decide.ts` describes as #687. A pass that straddles
   * the hour boundary floors here to bar N+1 while the debate is keyed to bar
   * N. That is no worse than the pre-existing cross-restart case #785 accepted;
   * threading the decision bar down to the analysts is the clean fix and is not
   * this change.
   */
  getContext(assetClass: AssetClass, timeWindow: Duration, _trace_id: string): MarketContext {
    const asOf = this.clock.now();
    const windowEnd = floorToBar(asOf, DEBATE_BAR_TIMEFRAME_MS).getTime();
    const windowStart = windowEnd - timeWindow;

    const inWindow = this.stored
      .filter((entry) => entry.asset_class === assetClass)
      .map((entry) => entry.item)
      .filter(
        (item) => item.timestamp.getTime() <= windowEnd && item.timestamp.getTime() >= windowStart,
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

// The deterministic ingestion path (map #552) — the writer that actually fills
// `MarketIntelligenceStore`, replacing a retrieval design that ingests `[]` by
// construction.
export {
  type ArchivedItem,
  type ArchiveFidelity,
  MiArchiveStore,
  miArchivePath,
  type RawArchiveRow,
} from './archive/mi-archive-store.js';
export {
  GdeltIngestAgent,
  type GdeltIngestAgentDeps,
  SOURCE_GDELT,
} from './gdelt-ingest-agent.js';
export {
  floorToRefreshBucket,
  GROK_REFRESH_MS,
  GrokAgent,
  type GrokAgentDeps,
  type GrokSentimentClient,
  type GrokSpendSink,
} from './grok/grok-agent.js';
export {
  NousSentimentClient,
  type NousSentimentClientOptions,
} from './grok/nous-sentiment-client.js';
export { MiIngestAgent, type MiIngestAgentDeps, wireSymbol } from './mi-ingest-agent.js';
export { type ScorableItem, scoreItems, UNSCORED } from './scoring/item-scorer.js';
export { type AlpacaNewsArticle, AlpacaNewsClient } from './sources/alpaca-news-client.js';
export {
  batchTimeFromUrl,
  type GdeltGkgBatch,
  GdeltGkgClient,
  type GdeltGkgClientOptions,
  type GdeltGkgRecord,
  // Exported here, not just from the module: a stored `payload` is a projection,
  // and anything re-parsing one has to read its shape from this constant rather
  // than assume GKG column order.
  PROJECTED_COLUMNS,
} from './sources/gdelt-gkg-client.js';
export { allWatchedThemes, themesFor } from './sources/gdelt-themes.js';
