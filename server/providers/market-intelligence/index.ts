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

const STALENESS_THRESHOLD_MS: Record<AssetClass, number> = {
  crypto: 5_000,
  stocks: 30_000,
};

const SUBSCRIBER_THROTTLE_MS = 60_000;
const SLOW_CALLBACK_MS = 5_000;
const MAX_SLOW_CALLBACKS = 3;

function latestClassWideRestatementOnly(
  items: readonly IntelligenceItem[],
): readonly IntelligenceItem[] {
  const latest = new Map<string, IntelligenceItem>();
  for (const item of items) {
    if (item.scope !== 'asset_class') continue;
    const key = `${item.source}\u0000${item.entity}\u0000${item.type}`;
    const held = latest.get(key);
    if (held === undefined || item.timestamp.getTime() >= held.timestamp.getTime()) {
      latest.set(key, item);
    }
  }
  if (latest.size === 0) return items;
  const kept = new Set(latest.values());
  return items.filter((item) => item.scope !== 'asset_class' || kept.has(item));
}

function isClassWide(item: IntelligenceItem): boolean {
  return item.scope === 'asset_class';
}

export class MarketIntelligenceStore {
  private readonly stored: StoredItem[] = [];
  private readonly subscriptions: Subscription[] = [];
  private readonly ingestedIds = new Set<string>();

  constructor(private readonly clock: Clock) {}

  ingest(intelligence: AgentIntelligence): void {
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

  subscribe(assetClass: AssetClass, callback: MarketContextCallback): void {
    this.subscriptions.push({
      asset_class: assetClass,
      callback,
      lastDelivered: null,
      slowCount: 0,
    });
  }

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
export { CURATED_MACRO_MARKETS } from './polymarket/curated-markets.js';
export {
  POLYMARKET_ASSET_CLASS,
  PolymarketAgent,
  type PolymarketWireClient,
  SOURCE_POLYMARKET,
} from './polymarket/polymarket-agent.js';
export { PolymarketClient } from './polymarket/polymarket-client.js';
export type { AlpacaNewsArticle } from './sources/alpaca-news-client.js';
export { AlpacaNewsClient } from './sources/alpaca-news-client.js';
export {
  GdeltGkgClient,
  PROJECTED_COLUMNS,
} from './sources/gdelt-gkg-client.js';
export { GDELT_MACRO_ENTITY } from './sources/gdelt-scorer.js';
