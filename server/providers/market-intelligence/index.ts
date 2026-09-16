/**
 * Market Intelligence — see docs/specs/market-intelligence-spec.md.
 * Agent orchestration and conflict resolution are not implemented here.
 */
// Imported directly from debate-log-store rather than the debate-engine
// barrel so this provider does not pull in the engine's module graph
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
 * The spec has no dedicated context-staleness threshold, so this reuses the
 * agent latency budgets (crypto 5s, stocks 30s) as the "on time" cadence
 */
const STALENESS_THRESHOLD_MS: Record<AssetClass, number> = {
  crypto: 5_000,
  stocks: 30_000,
};

/** Spec: "Throttle: max 1 update per minute per subscriber" */
const SUBSCRIBER_THROTTLE_MS = 60_000;
/** Spec: "If analyst is slow to process (callback takes > 5s), log warning" */
const SLOW_CALLBACK_MS = 5_000;
/** Spec: "If analyst callback fails repeatedly (3 times), remove subscription and alert" */
const MAX_SLOW_CALLBACKS = 3;

/**
 * Collapses class-wide items to the LATEST one per (source, entity, type).
 * A `scope: 'asset_class'` item is a trailing statistic re-derived every
 * debate bar, not a dated observation — keeping every restatement would let
 * one macro source outvote an instrument's genuinely distinct items under
 * `fundamental-analyst.ts`'s unweighted mean. `ingest`'s id-based dedupe
 * can't do this: a per-bar id accumulates rather than replacing.
 */
function latestClassWideRestatementOnly(
  items: readonly IntelligenceItem[],
): readonly IntelligenceItem[] {
  const latest = new Map<string, IntelligenceItem>();
  for (const item of items) {
    if (item.scope !== 'asset_class') continue;
    const key = `${item.source}\u0000${item.entity}\u0000${item.type}`;
    const held = latest.get(key);
    // `>=` so a tie goes to the later-ingested item, keeping the survivor a
    // deterministic function of ingest order (needed for replay determinism)
    if (held === undefined || item.timestamp.getTime() >= held.timestamp.getTime()) {
      latest.set(key, item);
    }
  }
  if (latest.size === 0) return items;
  const kept = new Set(latest.values());
  return items.filter((item) => item.scope !== 'asset_class' || kept.has(item));
}

/**
 * The sole predicate routing an item to `MarketContext.intel` instead of
 * `news`/`social`: class-wide items are evidence for the whole asset class,
 * not one instrument, so they must not count as per-ticker observations
 */
function isClassWide(item: IntelligenceItem): boolean {
  return item.scope === 'asset_class';
}

/**
 * In-memory store + pull-mode serving for news/sentiment intelligence.
 * Holds the injected Clock so getContext resolves `asOf` internally; swapping
 * the Clock implementation is the only difference between live and replay.
 */
export class MarketIntelligenceStore {
  private readonly stored: StoredItem[] = [];
  private readonly subscriptions: Subscription[] = [];
  /**
   * Item ids already ingested, so the same observation isn't counted twice.
   * Grows unpruned deliberately — the store is restart-clean and in-memory,
   * and pruning risks reopening the dedupe window it protects.
   */
  private readonly ingestedIds = new Set<string>();

  constructor(private readonly clock: Clock) {}

  /**
   * Records one agent-produced batch. No persistence (spec: restart-clean).
   * Also drives push delivery: subscribers for this asset class are notified
   * with the newly ingested items, subject to throttling.
   */
  ingest(intelligence: AgentIntelligence): void {
    // Deduped by (asset_class, entity, id), not id alone: an X status id
    // carries no entity, and a post mentioning two names in the universe is
    // retrieved once as evidence for each — different observations that
    // happen to share a source post. This still catches the case it's for:
    // the same post for the same instrument re-arriving because x_search's
    // date filter is day-granular while the refresh bucket is two hours
    const admitted: IntelligenceItem[] = [];
    for (const item of intelligence.items) {
      const key = `${intelligence.asset_class}\u0000${item.entity}\u0000${item.id}`;
      if (this.ingestedIds.has(key)) continue;
      this.ingestedIds.add(key);
      this.stored.push({ asset_class: intelligence.asset_class, item });
      admitted.push(item);
    }
    if (admitted.length > 0) {
      this.notifySubscribers(intelligence.asset_class, admitted);
    }
  }

  /**
   * Returns point-in-time news/sentiment context for one asset class.
   * `asOf` comes from the injected clock, never item timestamps or wall-clock
   * `Date.now()` — required for the no-lookahead guarantee to hold in replay.
   *
   * `windowEnd` is floored to the debate bar rather than the raw clock read,
   * so item counts stay stable across ticks within one bar: technical/
   * sentiment/fundamental analysts hash or derive confidence from these
   * counts, and a mid-bar change would mint spurious debates or extra lots.
   * `last_updated`/`stale` deliberately stay on the unfloored read (they're
   * an ingestion-liveness signal, not hashed) — so the two halves of a
   * `MarketContext` can disagree: don't infer "no news" from `stale: false`.
   *
   * `bar`, when supplied, IS `windowEnd` directly (no re-flooring) because it
   * already came out of `DecisionGate.claim` — a second derivation here could
   * disagree with the debate's own bar across an hour-boundary race. Optional
   * because callers with no decision-bar concept (coverage checker, smoke-run
   * summaries) fall back to flooring the live clock.
   *
   * `entity`, when supplied, additionally filters to items whose `entity`
   * matches the caller's resolved MI subject (`resolveMiSubject`), so an
   * LSE-listed wrapper's read targets the US-underlying key its items are
   * actually filed under. Class-wide items are admitted regardless of
   * `entity` — they're evidence for every instrument in the class.
   */
  getContext(
    assetClass: AssetClass,
    timeWindow: Duration,
    _trace_id: string,
    bar?: Date,
    entity?: string,
  ): MarketContext {
    const asOf = this.clock.now();
    const windowEnd = (bar ?? floorToBar(asOf, DEBATE_BAR_TIMEFRAME_MS)).getTime();
    const windowStart = windowEnd - timeWindow;

    const inWindow = this.stored
      .filter((entry) => entry.asset_class === assetClass)
      .map((entry) => entry.item)
      .filter(
        (item) => item.timestamp.getTime() <= windowEnd && item.timestamp.getTime() >= windowStart,
      )
      // Class-wide items pass the entity filter regardless of `entity`: they're
      // evidence for every instrument, not a coverage hit for any one ticker
      .filter(
        (item) => entity === undefined || item.scope === 'asset_class' || item.entity === entity,
      );
    const visible = latestClassWideRestatementOnly(inWindow);

    const lastUpdated = this.lastUpdated(assetClass, asOf);

    return {
      timestamp: asOf,
      asset_class: assetClass,
      news: visible.filter((item) => !isClassWide(item) && item.type === 'news'),
      social: visible.filter((item) => !isClassWide(item) && item.type === 'sentiment'),
      intel: visible.filter(isClassWide),
      last_updated: lastUpdated,
      stale: this.isStale(assetClass, asOf, lastUpdated),
    };
  }

  /**
   * Registers a push subscriber for one asset class. No `trace_id` param:
   * push updates fire asynchronously outside any single tick.
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
   * a MarketContext scoped to those items only (not the full history)
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
      news: inWindow.filter((item) => !isClassWide(item) && item.type === 'news'),
      social: inWindow.filter((item) => !isClassWide(item) && item.type === 'sentiment'),
      intel: inWindow.filter(isClassWide),
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

// The deterministic ingestion path — the writer that actually fills
// `MarketIntelligenceStore`
export {
  DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
  MiArchiveStore,
  miArchivePath,
  type RawArchiveRow,
} from './archive/mi-archive-store.js';
export { MI_SOURCES } from './archive/mi-sources.js';
export {
  GdeltIngestAgent,
  SOURCE_GDELT,
} from './gdelt-ingest-agent.js';
export { GdeltScoringPass } from './gdelt-scoring-pass.js';
export {
  GROK_REFRESH_MS,
  GrokAgent,
} from './grok/grok-agent.js';
export { NousSentimentClient } from './grok/nous-sentiment-client.js';
export {
  DEFAULT_MAX_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS_CEILING,
  X_SEARCH_MODEL,
  XSearchClient,
} from './grok/x-search-client.js';
export { MiIngestAgent } from './mi-ingest-agent.js';
// The Polymarket macro/event path — an `intel` writer (routed there by
// `scope`, not filed as `news`)
export { CURATED_MACRO_MARKETS } from './polymarket/curated-markets.js';
export {
  POLYMARKET_ASSET_CLASS,
  PolymarketAgent,
  type PolymarketWireClient,
  SOURCE_POLYMARKET,
} from './polymarket/polymarket-agent.js';
export { PolymarketClient } from './polymarket/polymarket-client.js';
export { AlpacaNewsClient } from './sources/alpaca-news-client.js';
export {
  GdeltGkgClient,
  // Exported here, not just from the module: a stored `payload` is a projection,
  // and anything re-parsing one has to read its shape from this constant rather
  // than assume GKG column order
  PROJECTED_COLUMNS,
} from './sources/gdelt-gkg-client.js';
export { GDELT_MACRO_ENTITY } from './sources/gdelt-scorer.js';
