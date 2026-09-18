
import type { LlmClient, SpendCap } from '../../pipeline/debate-engine/index.js';
import type { AssetClass, Clock, Logger } from '../../shared/index.js';
import { resolveMiSubject } from '../universe-pool/index.js';
import type { ArchivedItem, MiArchiveStore, RawArchiveRow } from './archive/mi-archive-store.js';
import { HYDRATING_MI_SOURCES, MI_SOURCES } from './archive/mi-sources.js';
import type { MarketIntelligenceStore } from './index.js';
import type { ItemScore } from './scoring/item-scorer.js';
import { scoreItems } from './scoring/item-scorer.js';
import type { AlpacaNewsArticle, AlpacaNewsClient } from './sources/alpaca-news-client.js';
import type { IntelligenceItem } from './types.js';

const SOURCE_ALPACA = MI_SOURCES.alpacaNews;

const MAX_DEGRADED_SKIP = 8;

interface DegradedState {
  readonly streak: number;
  readonly skipRemaining: number;
  readonly lastFailureAt: number;
}

const ZERO_DEGRADED: DegradedState = { streak: 0, skipRemaining: 0, lastFailureAt: 0 };

function degradedSkip(streak: number): number {
  return streak < 2 ? 0 : Math.min(2 ** (streak - 2), MAX_DEGRADED_SKIP);
}

function readDegraded(
  degraded: ReadonlyMap<string, DegradedState>,
  instrument: string,
  now: Date,
): DegradedState {
  const state = degraded.get(instrument);
  if (!state) return ZERO_DEGRADED;
  if (state.streak > 0 && now.getTime() - state.lastFailureAt >= LOOKBACK_MS) {
    return ZERO_DEGRADED;
  }
  return state;
}

const LOOKBACK_MS = 60 * 60 * 1000;

export interface MiIngestAgentDeps {
  archive: MiArchiveStore;
  store: MarketIntelligenceStore;
  newsClient: AlpacaNewsClient;
  llmClient: LlmClient;
  spendCap: SpendCap;
  clock: Clock;
  logger?: Logger | undefined;
  assetClasses: AssetClass[];
}

function toItem(
  article: AlpacaNewsArticle,
  entity: string,
  score: { sentiment: 1 | 0 | -1; confidence: number },
): IntelligenceItem {
  return {
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
  readonly #degraded = new Map<string, DegradedState>();

  constructor(private readonly deps: MiIngestAgentDeps) {}

  hydrate(): void {
    const asOf = this.deps.clock.now();
    for (const asset_class of this.deps.assetClasses) {
      const items = this.deps.archive.itemsKnownAt(asset_class, asOf, HYDRATING_MI_SOURCES);
      if (items.length > 0) {
        this.deps.store.ingest({ agent_id: SOURCE_ALPACA, timestamp: asOf, asset_class, items });
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear resolve/fetch/archive-raw/filter-unscored/backoff-guard/spend-cap/score/archive-scored/ingest sequence per the doc comment above; splitting the steps apart would scatter one refresh's ordering guarantees (raws archived independent of scoring outcome, streak only cleared on an actual successful score) across several functions.
  async refresh(trace_id: string, instrument: string, asset_class: AssetClass): Promise<boolean> {
    const miSubject = resolveMiSubject(instrument);
    const symbols = [wireSymbol(miSubject)];

    const now = this.deps.clock.now();
    const start = new Date(now.getTime() - LOOKBACK_MS);

    let articles: AlpacaNewsArticle[];
    try {
      articles = await this.deps.newsClient.fetchNews(symbols, start, now);
    } catch (error) {
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'mi_news_fetch_failed',
        level: 'warn',
        message:
          'market intelligence: news fetch failed; this refresh adds nothing and the ' +
          'news-fed analysts will report NO DATA for it. Not fatal — the tick continues ' +
          'on whatever the archive already holds.',
        payload: { asset_class, error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }

    const newRaws: RawArchiveRow[] = articles
      .filter(
        (article) => !this.deps.archive.hasItem(SOURCE_ALPACA, article.id, article.updated_at),
      )
      .map((article) => ({
        source: SOURCE_ALPACA,
        native_id: article.id,
        updated_at: article.updated_at,
        payload: article.payload,
        ingested_at: now,
        fidelity: 'live',
      }));
    if (newRaws.length > 0) {
      this.deps.archive.write(newRaws, []);
    }

    const unscored = articles
      .filter((article) => article.symbols.some((symbol) => symbols.includes(symbol)))
      .filter(
        (article) =>
          !this.deps.archive.hasScoredItem(
            SOURCE_ALPACA,
            article.id,
            article.updated_at,
            miSubject,
          ),
      );
    if (unscored.length === 0) {
      const existing = this.#degraded.get(instrument);
      if (existing && existing.skipRemaining > 0) {
        this.#degraded.set(instrument, {
          streak: existing.streak,
          skipRemaining: 0,
          lastFailureAt: existing.lastFailureAt,
        });
      }
      return false;
    }

    const state = readDegraded(this.#degraded, instrument, now);
    if (state.skipRemaining > 0) {
      const next: DegradedState = {
        streak: state.streak,
        skipRemaining: state.skipRemaining - 1,
        lastFailureAt: state.lastFailureAt,
      };
      this.#degraded.set(instrument, next);
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'mi_ingest_scoring_skipped',
        level: 'warn',
        message:
          `market intelligence: skipping the scoring attempt for ${instrument} — streak ` +
          `${state.streak}, ${next.skipRemaining} refresh(es) until the next attempt; raw ` +
          'bytes stay archived.',
        payload: {
          asset_class,
          instrument,
          items: unscored.length,
          streak: state.streak,
          next_attempt_in: next.skipRemaining,
        },
      });
      return false;
    }

    const pairs = unscored.map((article) => ({ article, entity: miSubject }));

    const verdict = this.deps.spendCap.check();
    if (!verdict.admitted) {
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'mi_ingest_refused_spend_cap',
        level: 'warn',
        message:
          `market intelligence: refusing to score ${pairs.length} item(s) for ${instrument} — ` +
          `${verdict.reason ?? 'spend cap reached'}. The analysts will report NO DATA for this ` +
          'window rather than an unscored or fabricated item, so the debate can tell "could not ' +
          'afford to look" from "saw nothing".',
        payload: {
          asset_class,
          instrument,
          spent_usd: verdict.spent_usd,
          budget_usd: verdict.budget_usd,
        },
      });
      return false;
    }

    const { scores, degraded } = await scoreItems(
      pairs.map(({ article, entity }) => ({
        entity,
        headline: article.headline,
        summary: article.summary,
      })),
      {
        llmClient: this.deps.llmClient,
        logger: this.deps.logger ?? { log: () => {} },
        trace_id,
      },
    );

    if (degraded) {
      const nextStreak = state.streak + 1;
      this.#degraded.set(instrument, {
        streak: nextStreak,
        skipRemaining: degradedSkip(nextStreak),
        lastFailureAt: now.getTime(),
      });
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'mi_ingest_scoring_degraded',
        level: 'warn',
        message:
          `market intelligence: item scoring failed for ${pairs.length} item(s) for ` +
          `${instrument}; their raw bytes are archived, but nothing is scored, so the ` +
          'analysts will report NO DATA for this window rather than a fabricated neutral read.',
        payload: { asset_class, instrument, items: pairs.length, streak: nextStreak },
      });
      return false;
    }
    this.#degraded.set(instrument, ZERO_DEGRADED);

    const scoredPairs = pairs
      .map(({ article, entity }, index) => ({ article, entity, score: scores[index] }))
      .filter(
        (
          candidate,
        ): candidate is { article: AlpacaNewsArticle; entity: string; score: ItemScore } =>
          candidate.score !== undefined && candidate.score.omitted !== true,
      );

    const archivedItems: ArchivedItem[] = scoredPairs.map(({ article, entity, score }) => ({
      source: SOURCE_ALPACA,
      native_id: article.id,
      updated_at: article.updated_at,
      entity,
      asset_class,
      item: toItem(article, entity, score),
      ingested_at: now,
    }));

    this.deps.archive.write([], archivedItems);
    this.deps.store.ingest({
      agent_id: SOURCE_ALPACA,
      timestamp: now,
      asset_class,
      items: archivedItems.map((row) => row.item),
    });

    this.deps.logger?.log({
      trace_id,
      stage: 'market_intelligence',
      level: 'info',
      message: 'market intelligence: ingested scored news items',
      payload: {
        asset_class,
        instrument,
        mi_subject: miSubject,
        articles: newRaws.length,
        items: archivedItems.length,
      },
    });

    return true;
  }
}

function wireSymbol(instrument: string): string {
  return instrument.replace(/-/g, '');
}
