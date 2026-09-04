/**
 * Domain types & contracts for Market Intelligence (Stage 0, news/sentiment half).
 * See docs/specs/market-intelligence-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md (GAP-J: getContext(assetClass, timeWindow,
 * trace_id) takes trace_id as a call param, not a struct field — no asOf param;
 * asOf is resolved internally from the injected Clock, same pattern as
 * MarketDataService). Implementation ticket #68 — structural contracts only.
 */

import type { AssetClass } from '../../shared/index.js';

export type { AssetClass };

/** Milliseconds. Window length ending at the service-resolved `asOf`. */
export type Duration = number;

/**
 * Upstream contract: what each agent (DeepResearch, Grok) produces.
 * Agent orchestration itself is out of scope for #68/#69 (not ticketed under
 * epic #52) — this type exists so `ingest` has a well-formed shape to accept.
 */
export interface AgentIntelligence {
  /**
   * `gdelt-gkg` is the one writer whose items are class-wide
   * (`IntelligenceItem.scope`); every other id files per entity.
   *
   * Widening this union is a TYPE change and nothing more: there is no
   * `market_intelligence` table (`index.ts` — the store is in-memory and
   * restart-clean), so no migration is involved, whatever
   * `nous-sentiment-client.ts`'s header claims.
   */
  agent_id: 'deepresearch' | 'grok' | 'alpaca-news' | 'polymarket' | 'gdelt-gkg';
  timestamp: Date;
  asset_class: AssetClass;
  items: IntelligenceItem[];
}

export interface IntelligenceItem {
  /** Unique: agent_id + source + timestamp + entity. */
  id: string;
  /** e.g. 'bloomberg', 'reuters', 'twitter'. */
  source: string;
  type: 'news' | 'sentiment';
  timestamp: Date;
  /** Ticker, company name, or event. */
  entity: string;
  /**
   * Who this item is evidence FOR (#1086). Absent means `'entity'` — the
   * item speaks about `entity` and nothing else, which is what every item
   * before the GDELT scoring pass was.
   *
   * `'asset_class'` marks a CLASS-WIDE item: a macro aggregate that is
   * evidence for every instrument in its class and for no one instrument in
   * particular. `getContext`'s entity filter admits these past an
   * entity-scoped read (an entity-scoped caller wants the macro backdrop
   * too), while `mi-coverage.ts`'s `hasCoverageFor` still does not count
   * them, because it compares `entity` to the instrument and a macro series
   * name never matches one. That asymmetry is the point: the analysts see the
   * macro tone, and the per-ticker coverage counter stays honest about the
   * hole a class-wide item does not fill.
   */
  scope?: 'entity' | 'asset_class';
  headline: string;
  /** 1 = bullish, 0 = neutral, -1 = bearish. */
  sentiment: 1 | 0 | -1;
  /** 0.0-1.0. */
  confidence: number;
  summary?: string;
  url?: string;
}

/**
 * Downstream contract: what analysts receive from getContext/subscribe.
 * `conflicts` is always `[]` as of #68 — conflict resolution between
 * DeepResearch and Grok signals is not ticketed under epic #52 (only #68
 * core serving and #69 subscribe/staleness exist), so no resolution logic
 * is invented here.
 *
 * `stale`/`last_updated` (#69): staleness of the asset's intelligence as of
 * `timestamp`. `last_updated` is the timestamp of the most recent item ever
 * ingested for this asset class (not scoped to the query's timeWindow);
 * `null` if nothing has been ingested yet, which is always stale.
 */
export interface MarketContext {
  timestamp: Date;
  asset_class: AssetClass;
  news: IntelligenceItem[];
  social: IntelligenceItem[];
  conflicts: ConflictResolution[];
  stale: boolean;
  last_updated: Date | null;
}

/** Push-delivery callback passed to `MarketIntelligenceStore.subscribe`. */
export type MarketContextCallback = (ctx: MarketContext) => void;

export interface ConflictResolution {
  entity: string;
  deepresearch_signal: { sentiment: 1 | 0 | -1; confidence: number };
  grok_signal: { sentiment: 1 | 0 | -1; confidence: number };
  resolved_winner: 'deepresearch' | 'grok';
  reason: string;
}
