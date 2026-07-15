/**
 * Market Intelligence — see docs/specs/market-intelligence-spec.md, epic #52.
 * Ticket #68: core news/sentiment context serving (getContext, pull mode).
 * Push/subscribe + staleness is #69; agent orchestration and conflict
 * resolution are not ticketed under epic #52 and are not implemented here.
 */
import type { Clock } from '../shared/clock.js';
import type {
  AgentIntelligence,
  AssetClass,
  Duration,
  IntelligenceItem,
  MarketContext,
} from './types.js';

export type {
  AgentIntelligence,
  AssetClass,
  ConflictResolution,
  Duration,
  IntelligenceItem,
  MarketContext,
} from './types.js';

interface StoredItem {
  asset_class: AssetClass;
  item: IntelligenceItem;
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

  constructor(private readonly clock: Clock) {}

  /**
   * Records one agent-produced batch. No persistence (spec: restart-clean) —
   * this is purely an in-memory seam for future DeepResearch/Grok agent
   * tickets to feed into; asset_class is carried on the envelope, not per item.
   */
  ingest(intelligence: AgentIntelligence): void {
    for (const item of intelligence.items) {
      this.stored.push({ asset_class: intelligence.asset_class, item });
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

    return {
      timestamp: asOf,
      asset_class: assetClass,
      news: inWindow.filter((item) => item.type === 'news'),
      social: inWindow.filter((item) => item.type === 'sentiment'),
      conflicts: [],
    };
  }
}
