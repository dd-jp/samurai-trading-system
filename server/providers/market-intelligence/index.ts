/**
 * Market Intelligence — see docs/specs/market-intelligence-spec.md, epic #52.
 * Ticket #68: core news/sentiment context serving (getContext, pull mode).
 * Ticket #69: push (subscribe) + staleness. Agent orchestration and conflict
 * resolution are not ticketed under epic #52 and are not implemented here.
 */
// The bar grid, imported from its one defining module rather than restated
// here (`decide.ts`: "the grid now has exactly one statement in the system")
// `debate-log-store.ts` is imported directly instead of the debate-engine
// barrel so this provider does not pull the engine's module graph; the file
// itself has only type imports
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

/** Spec: "Throttle: max 1 update per minute per subscriber" */
const SUBSCRIBER_THROTTLE_MS = 60_000;
/** Spec: "If analyst is slow to process (callback takes > 5s), log warning" */
const SLOW_CALLBACK_MS = 5_000;
/** Spec: "If analyst callback fails repeatedly (3 times), remove subscription and alert" */
const MAX_SLOW_CALLBACKS = 3;

/**
 * Collapses class-wide items to the LATEST one per (source, entity, type).
 *
 * A `scope: 'asset_class'` item is a trailing statistic over a window, not a
 * dated observation: `gdelt-scoring-pass.ts` derives one every debate bar, and
 * consecutive ones share 23 of the 24 hours of their baseline. So an analyst's
 * 24h read holds ~24 restatements of one measurement, and
 * `fundamental-analyst.ts` takes an UNWEIGHTED mean over `news` + `intel`
 * (#1164) — leaving them all in lets one macro source outvote every genuinely
 * distinct item an instrument has (an LSE ETP gets 0-1 from the Benzinga
 * wire). That is the time-axis inflation `polymarket-agent.ts` records as its
 * limitation 3, arriving through a second source.
 *
 * Entity-scoped items are untouched, because two articles about one ticker
 * ARE two observations. The key carries `entity` and `type` as well as
 * `source`: one source may file several macro series under different names
 * (Polymarket does), and a class-wide `news` item and a class-wide
 * `sentiment` item are different evidence within the same `intel` bucket
 * (#1164) — `type` still keeps them from being collapsed into one
 * restatement of each other.
 *
 * `ingest` cannot do this job, which is why it is done here. Its
 * `(asset_class, entity, id)` dedupe DROPS a repeat rather than replacing it,
 * so a per-bar id accumulates and a stable id would pin the FIRST bar's
 * aggregate forever. The latest restatement is the one that describes now.
 */
function latestClassWideRestatementOnly(
  items: readonly IntelligenceItem[],
): readonly IntelligenceItem[] {
  const latest = new Map<string, IntelligenceItem>();
  for (const item of items) {
    if (item.scope !== 'asset_class') continue;
    const key = `${item.source}\u0000${item.entity}\u0000${item.type}`;
    const held = latest.get(key);
    // `>=`, so a tie goes to the later-ingested item: two derivations of one
    // window differ only by a re-derivation, and the newer one is the current
    // description of it. Stated because the tie-break has to be TOTAL for the
    // replay determinism #1086 AC2 asserts — `stored` is in ingest order, so
    // this makes the survivor a function of the ingest sequence alone
    if (held === undefined || item.timestamp.getTime() >= held.timestamp.getTime()) {
      latest.set(key, item);
    }
  }
  if (latest.size === 0) return items;
  const kept = new Set(latest.values());
  return items.filter((item) => item.scope !== 'asset_class' || kept.has(item));
}

/**
 * #1164: the sole predicate routing an item to `MarketContext.intel` instead
 * of `news`/`social` — macro, GDELT-GKG and Polymarket items all set `scope:
 * 'asset_class'` (gdelt-scorer.ts, polymarket-agent.ts) and are evidence for
 * the whole asset class, not for one instrument, so they must not be counted
 * as per-ticker news/sentiment observations
 */
function isClassWide(item: IntelligenceItem): boolean {
  return item.scope === 'asset_class';
}

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
  /**
   * Item ids already ingested, so the same underlying observation cannot be
   * counted twice (#969).
   *
   * Grows with the run and is never pruned, deliberately. The store is
   * in-memory and restart-clean, `getContext` already filters to a time
   * window, and the set holds only short id strings — at the observed rates
   * (tens of items per instrument per day) a 14-day soak is thousands of
   * entries, which is not worth the risk of a prune that reopens the window
   * it was protecting.
   */
  private readonly ingestedIds = new Set<string>();

  constructor(private readonly clock: Clock) {}

  /**
   * Records one agent-produced batch. No persistence (spec: restart-clean) —
   * this is purely an in-memory seam for future DeepResearch/Grok agent
   * tickets to feed into; asset_class is carried on the envelope, not per item.
   * Also drives push delivery (#69): subscribers for this asset class are
   * notified with the newly ingested items, subject to throttling.
   */
  ingest(intelligence: AgentIntelligence): void {
    // DEDUPED BY ITEM ID (#969). This used to append unconditionally, which
    // was safe only because every producer emitted call-unique ids: the old
    // sentiment client's `grok:<instrument>:<asOf>:<index>` could not collide
    // with itself by construction
    //
    // Real retrieval breaks that. `x_search`'s date filter is DAY-granular
    // while the refresh bucket is two hours, so consecutive buckets return
    // overlapping posts as a matter of course — and `sentiment-analyst.ts`
    // averages `social` wholesale, so an un-deduped post votes once per bucket
    // it survives in. A post that stayed relevant for six hours would count
    // three times, which reads as three people agreeing
    //
    // Keyed on the item id rather than on content because the id is now
    // derived from the observation itself (`x:<statusId>`), which is what
    // makes cross-call identity meaningful. `mi-sources.ts` names this same
    // missing dedupe as the mechanism that would compound a boot replay, so
    // this is also what makes `hydrate` safe for an item-writing source
    //
    // The key is (asset_class, entity, id), NOT the id alone (review round 2,
    // #1055). This store is shared across the whole universe, and an X status
    // id carries no entity — so a post that mentions two names in the universe
    // is retrieved once as evidence for each, and an id-only key would admit
    // it for whichever instrument was ingested first and silently drop it for
    // the second. That is a real loss, not a duplicate avoided: the two are
    // different observations about different instruments that happen to share
    // a source post, and the analyst reads them per entity
    //
    // What the key still catches is the case it was added for — the SAME post
    // for the SAME instrument arriving again in the next bucket, because
    // `x_search`'s date filter is day-granular while the bucket is two hours
    // Widening the key does not weaken that, because both components are
    // constant across those repeats
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
   * ingested mid-bar — changed `news.length`/`social.length`/`intel.length`
   * between two ticks of ONE debate bar. Three things read those counts, and
   * none of them should move within a bar:
   *
   *   1. `technical-analyst.ts` puts them verbatim in `key_points`
   *      ("MI context: N news, M social, K intel items in window"), and
   *      `key_points` is hashed into `debate_id` (`debate-id.ts`). A changed
   *      count is a changed id, which misses the #617 same-bar short-circuit
   *      and pays for a second debate on a bar that already has one.
   *   2. `sentiment-analyst.ts` derives `direction` AND `confidence` from
   *      `social`, and `fundamental-analyst.ts` does the same from `news` +
   *      `intel` (#1164). This is the part that is not merely a spend leak: a
   *      second, different confidence sample on the same bar is what
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
   * ## `bar` (#811) — the residual the paragraph above used to describe
   *
   * This used to floor a SECOND, independent clock read rather than inheriting
   * the gate's `decision_bar.open_time` — the same two-derivations shape
   * `decide.ts` describes as #687. A pass that straddled the hour boundary
   * (claimed under bar N, reaching the analysts after the clock had ticked
   * into bar N+1) floored here to bar N+1 while the debate stayed keyed to
   * bar N, so the analyst input and the debate record disagreed about which
   * bar they belonged to.
   *
   * `bar`, when supplied, IS `windowEnd` directly — no `floorToBar` call on
   * it, because it already came out of one (`DecisionGate.claim`) and a
   * second flooring would just be a second derivation with extra steps. The
   * three analysts (`technical-analyst.ts`, `fundamental-analyst.ts`,
   * `sentiment-analyst.ts`) always pass `input.bar` (`AnalystInput.bar` is
   * required, #811), so the analyst path now has exactly one derivation of
   * the bar per pass. `bar` stays optional on this method itself — callers
   * with no decision-bar concept at all (the coverage checker's own window,
   * `smoke-run.ts`'s post-hoc summary read) fall back to flooring the live
   * clock, which is no worse than #782 left them and is not this ticket's
   * scope to change.
   *
   * ## `entity` (#914) — scoping the read past the asset class
   *
   * Before this, every instrument in a class read the identical class-wide
   * bag: `fundamental-analyst.ts` and `sentiment-analyst.ts` both called this
   * method with `signal.asset_class`, never `signal.asset`, so a class-wide
   * macro item and a genuinely per-instrument item were indistinguishable —
   * measured directly in #914 as 8 debates across SPY/QQQ/AAPL/TSLA sharing
   * one fundamental key point at one confidence.
   *
   * `entity`, when supplied, additionally filters `inWindow` to items whose
   * `IntelligenceItem.entity` matches — the resolved MI subject a caller
   * computes via `resolveMiSubject` (`lse-etp-pool.ts`) so an LSE-listed
   * wrapper's read targets the US underlying MI is actually keyed on, per
   * #960's MI-wide rule. It stays optional on this method itself for the same
   * reason `bar` does: a caller with no single-instrument concept at all — the
   * coverage checker's own class-wide presence scan, the push-subscription
   * path below — has a real class-wide answer to give, not a forgotten
   * argument. Omitting it is unchanged behaviour. Ingestion already tagged
   * every item's `entity` with its instrument before #914; what #914 adds is
   * the LSE resolution step (`resolveMiSubject`) so an ETP wrapper's read
   * targets the same US-underlying key its items are actually filed under,
   * rather than a `lse_ticker` no item has ever been entitied with.
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
      // A CLASS-WIDE item (#1086) is admitted past the entity filter: it is
      // evidence for every instrument in the class, so an entity-scoped read
      // that dropped it would hide the macro backdrop from exactly the
      // callers #914 narrowed. This does not re-open #914's defect — an item
      // filed against a ticker is still returned only for that ticker, and
      // `mi-coverage.ts` keys on `entity`, so a class-wide item still counts
      // as coverage for nothing
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
   * getContext's windowed query semantics
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

// The deterministic ingestion path (map #552) — the writer that actually fills
// `MarketIntelligenceStore`, replacing a retrieval design that ingests `[]` by
// construction
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
// The Polymarket macro/event path (#504) — an `intel` writer (#1164: routed
// there by `scope`, not filed as `news`), added for the measured LSE-ETP
// coverage hole rather than for an empty bucket
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
