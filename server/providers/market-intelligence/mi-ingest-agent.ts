/**
 * The deterministic MI ingestion path (map #552).
 *
 * Replaces the retrieval-from-LLM design that fails closed by construction:
 * `NousSentimentClient` hard-codes `retrievalEvidence: false`, `GrokAgent
 * .refresh` discards every item without evidence, so the store ingests `[]` on
 * every refresh and both news-fed analysts report `NO_DATA_MARKER` forever.
 *
 * The shape here is the one #552 charted: **fetch deterministically, archive
 * the bytes, score separately, serve from the archive.** No model is asked to
 * retrieve; it is only asked to classify text already on disk.
 *
 * ## Restart durability, which is the property the soak actually needed
 *
 * `MarketIntelligenceStore` is an in-memory array that empties on restart, so
 * before this a soak restart lost every item ingested up to that point and the
 * run silently measured less than it appeared to. `hydrate()` reloads the store
 * from the archive at startup, so a restart costs nothing.
 *
 * That is true PER SOURCE, not globally (#835). `hydrate()` replays only the
 * sources `MI_SOURCE_HYDRATION` marks `hydrate` — items that are dated
 * observations. A source whose item is a trailing-window statistic (Polymarket's
 * 24h delta) is archived for replay but deliberately NOT pushed back into the
 * live store at boot, because re-serving a stale measurement as current is a
 * different defect from losing it. `archive/mi-sources.ts` states each policy
 * and why.
 *
 * ## Deviation from #554 sub-decision 4, stated plainly
 *
 * That decision says `MarketIntelligenceStore` "becomes a read-through view
 * over the archive". This implementation keeps the store as an in-memory cache
 * and *hydrates* it from the archive instead — same durability property, and it
 * leaves the store's push-subscription path (#69) untouched rather than
 * rewriting a working delivery mechanism inside an ingestion change. Turning
 * the store into a literal view is a follow-up, and it is behaviour-preserving
 * once this lands. Recorded here rather than quietly diverging.
 */

import type { LlmClient } from '../../pipeline/debate-engine/index.js';
import type { AssetClass, Clock, Logger } from '../../shared/index.js';
import type { ArchivedItem, MiArchiveStore, RawArchiveRow } from './archive/mi-archive-store.js';
import { HYDRATING_MI_SOURCES, MI_SOURCES } from './archive/mi-sources.js';
import type { MarketIntelligenceStore } from './index.js';
import { scoreItems } from './scoring/item-scorer.js';
import type { AlpacaNewsArticle, AlpacaNewsClient } from './sources/alpaca-news-client.js';
import type { IntelligenceItem } from './types.js';

const SOURCE_ALPACA = MI_SOURCES.alpacaNews;

/**
 * How far back a refresh looks.
 *
 * Wider than the tick interval on purpose: a publisher can stamp `created_at`
 * slightly behind the moment the wire carries it, and a refresh that asked only
 * for "since my last poll" would drop those permanently. Re-requesting an
 * overlapping window is free — the archive's `INSERT OR IGNORE` absorbs it, and
 * duplicates are dropped before scoring so the overlap costs no LLM tokens.
 */
const LOOKBACK_MS = 60 * 60 * 1000;

export interface MiIngestAgentDeps {
  archive: MiArchiveStore;
  store: MarketIntelligenceStore;
  newsClient: AlpacaNewsClient;
  llmClient: LlmClient;
  clock: Clock;
  logger?: Logger | undefined;
  /**
   * Which asset classes this run trades — the only thing `hydrate` needs, since
   * `refresh` is told its instrument by the analysts step. Derived from the
   * configured universe by `universeAssetClasses`, so it cannot drift from what
   * the scheduler actually ticks.
   */
  assetClasses: AssetClass[];
}

/** Maps an Alpaca article + one of its symbols into the analyst-facing shape. */
function toItem(
  article: AlpacaNewsArticle,
  entity: string,
  score: { sentiment: 1 | 0 | -1; confidence: number },
): IntelligenceItem {
  return {
    // Stable and content-derived, so a re-ingest cannot produce a second item.
    id: `${SOURCE_ALPACA}:${article.id}:${entity}`,
    source: article.source,
    type: 'news',
    timestamp: article.created_at,
    entity,
    headline: article.headline,
    sentiment: score.sentiment,
    confidence: score.confidence,
    ...(article.summary.length > 0 ? { summary: article.summary } : {}),
  };
}

export class MiIngestAgent {
  constructor(private readonly deps: MiIngestAgentDeps) {}

  /**
   * Reloads the store from the archive — call once at startup, before the first
   * tick. Everything knowable now, per asset class.
   */
  hydrate(): void {
    const asOf = this.deps.clock.now();
    for (const asset_class of this.deps.assetClasses) {
      // Only the sources whose archived items are dated OBSERVATIONS (#835).
      // Polymarket's item is a trailing 24h delta and GDELT's, when its scoring
      // half lands, is a 1h-vs-24h window statistic; replaying either at boot
      // would re-serve a stale measurement as current. `mi-sources.ts` states
      // which is which, and typing forces a new source to answer the question.
      const items = this.deps.archive.itemsKnownAt(asset_class, asOf, HYDRATING_MI_SOURCES);
      if (items.length > 0) {
        this.deps.store.ingest({ agent_id: SOURCE_ALPACA, timestamp: asOf, asset_class, items });
      }
    }
  }

  /**
   * One refresh: fetch, archive, score, serve.
   *
   * Signature matches `MarketIntelligenceRefresh` exactly, so this is a
   * DROP-IN for `GrokAgent` at the analysts step — which calls it *before* the
   * analysts run, so a refreshed window is visible to the very tick that paid
   * for it.
   *
   * Never throws, and returns `false` rather than propagating. A vendor outage
   * or a scoring failure must degrade the desk to "no new intelligence" — a
   * state the analysts already handle via `NO_DATA_MARKER` — rather than take
   * down a tick that would otherwise have traded on the technical analyst
   * alone.
   */
  async refresh(trace_id: string, instrument: string, asset_class: AssetClass): Promise<boolean> {
    const symbols = [wireSymbol(instrument)];

    const now = this.deps.clock.now();
    const start = new Date(now.getTime() - LOOKBACK_MS);

    let articles: AlpacaNewsArticle[];
    try {
      articles = await this.deps.newsClient.fetchNews(symbols, start, now);
    } catch (error) {
      this.deps.logger?.log({
        trace_id: trace_id ?? 'mi-ingest',
        stage: 'market_intelligence',
        level: 'warn',
        message:
          'market intelligence: news fetch failed; this refresh adds nothing and the ' +
          'news-fed analysts will report NO DATA for it. Not fatal — the tick continues ' +
          'on whatever the archive already holds.',
        payload: { asset_class, error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }

    // Score only what is genuinely new. An overlapping window is expected every
    // refresh (see LOOKBACK_MS), and re-scoring articles already on disk would
    // bill tokens for an answer we hold — and, worse, produce a SECOND
    // non-deterministic score for one article, which is the divergence #558
    // banned at replay.
    const fresh = articles.filter(
      (article) => !this.deps.archive.hasItem(SOURCE_ALPACA, article.id, article.updated_at),
    );
    if (fresh.length === 0) return false;

    // One article carries a symbols[] array, so an article about three tickers
    // is three items — each scored against ITS OWN entity, because a headline
    // can be bullish for one ticker and bearish for another.
    // The wire symbol decides WHETHER this article is about the instrument;
    // the pipeline's own id is what the item is filed under, so downstream
    // joins see `BTC-USD` rather than the vendor's `BTCUSD`.
    const pairs = fresh
      .filter((article) => article.symbols.some((symbol) => symbols.includes(symbol)))
      .map((article) => ({ article, entity: instrument }));
    if (pairs.length === 0) return false;

    const scores = await scoreItems(
      pairs.map(({ article, entity }) => ({
        entity,
        headline: article.headline,
        summary: article.summary,
      })),
      { llmClient: this.deps.llmClient, ...(trace_id === undefined ? {} : { trace_id }) },
    );

    const raws: RawArchiveRow[] = fresh.map((article) => ({
      source: SOURCE_ALPACA,
      native_id: article.id,
      updated_at: article.updated_at,
      payload: article.payload,
      ingested_at: now,
      // 'live' because we fetched it now. A backfill run stamps 'backfill',
      // because Alpaca's `created_at` is publisher time and a backfilled row
      // would otherwise assert we saw it the instant it published (#558).
      fidelity: 'live',
    }));

    const archivedItems: ArchivedItem[] = pairs.map(({ article, entity }, index) => {
      const score = scores[index] ?? { sentiment: 0 as const, confidence: 0.05 };
      return {
        source: SOURCE_ALPACA,
        native_id: article.id,
        updated_at: article.updated_at,
        entity,
        asset_class,
        item: toItem(article, entity, score),
        ingested_at: now,
      };
    });

    this.deps.archive.write(raws, archivedItems);
    this.deps.store.ingest({
      agent_id: SOURCE_ALPACA,
      timestamp: now,
      asset_class,
      items: archivedItems.map((row) => row.item),
    });

    this.deps.logger?.log({
      trace_id: trace_id ?? 'mi-ingest',
      stage: 'market_intelligence',
      level: 'info',
      message: 'market intelligence: ingested scored news items',
      payload: { asset_class, instrument, articles: fresh.length, items: archivedItems.length },
    });

    return true;
  }
}

/**
 * The pipeline's instrument id in the form the news wire uses.
 *
 * The repo carries crypto as `BTC-USD` while Alpaca expects `BTCUSD` — the same
 * dash-form mismatch that made #585's crypto orders all reject with 'asset not
 * found'. Converting here rather than at the call site keeps that knowledge in
 * the one module that talks to this vendor.
 */
export function wireSymbol(instrument: string): string {
  return instrument.replace(/-/g, '');
}
