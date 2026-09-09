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
  /**
   * Read before `scoreItems`, the way `GrokAgent` reads its own (#1106).
   * `llmClient` meters into `llm_spend` but enforces nothing by itself, so
   * without this the only ceiling on the news-scoring path was
   * `MiRefreshQueue`'s single pre-pass check — which covered the pair only
   * while this agent happened to run first in the composition root's array.
   *
   * Relies on `SqliteSpendCap.check()` re-querying `SUM(cost_usd)` fresh on
   * every call (no memo) against `spendSink.record`'s synchronous
   * `better-sqlite3` insert: whichever of this agent and `GrokAgent` runs
   * first sees its own write reflected in the OTHER's next `check()`, with no
   * async gap either could race through.
   */
  spendCap: SpendCap;
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
  /**
   * Consecutive DEGRADED scoring attempts per instrument, in memory (#1392
   * review round 1, F1).
   *
   * `hasScoredItem` (below) makes a degraded batch retry on every refresh for
   * as long as the article stays inside `LOOKBACK_MS` — which by itself turns
   * a SUSTAINED outage into one scoring attempt per tick, each up to
   * `DEFAULT_LLM_RETRY.maxAttempts` billed calls, for the whole window. This
   * is the cheap bound: after two STRAIGHT failures, the third refresh skips
   * the scoring call (raw bytes are archived regardless, see `refresh`) and
   * the streak resets, so a sustained outage attempts scoring on 2 of every 3
   * refreshes rather than every one. A single blip is unaffected — streak 1
   * always retries on the very next refresh, which is what the "retries...
   * once scoring recovers" test below depends on. The MI spend cap remains
   * the real backstop; this only slows how fast one instrument's outage burns
   * toward it.
   *
   * Also reset on a refresh with nothing new to score (#1392 review round 2,
   * finding 5) — that refresh proves nothing about whether scoring itself is
   * still failing, so a streak left over from a since-resolved outage must
   * not survive to wrongly skip the next refresh that finally has work.
   */
  readonly #degradedStreak = new Map<string, number>();

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
    // #914/#960: the ingestion-side half of the MI-wide rule. An LSE-listed
    // leveraged ETP generates no headlines of its own — resolve to the US
    // underlying (`screening_instrument`) BEFORE fetching, so the wire is
    // asked about the instrument that actually gets covered, and file the
    // resulting items under that same resolved subject (see `entity` below)
    // so the entity-scoped read `fundamental-analyst.ts`/`sentiment-analyst.ts`
    // now perform actually finds them. `resolveMiSubject` is the identity for
    // every non-pool instrument, so today's universe is unaffected.
    const miSubject = resolveMiSubject(instrument);
    const symbols = [wireSymbol(miSubject)];

    const now = this.deps.clock.now();
    const start = new Date(now.getTime() - LOOKBACK_MS);

    let articles: AlpacaNewsArticle[];
    try {
      articles = await this.deps.newsClient.fetchNews(symbols, start, now);
    } catch (error) {
      // `trace_id` is a required `string` param, never null/undefined — the
      // `?? fallback` this line and `mi_ingest_refused_spend_cap` below used
      // to carry was dead code (#1392 review round 1, F6).
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

    // NEW raw bytes only — `write`'s `INSERT OR IGNORE` would absorb a
    // repeat regardless, but recomputing every fetched article's row on every
    // tick is wasted work. Archived unconditionally, below, independent of
    // whatever happens to scoring: a fetch that succeeded must not lose its
    // bytes to a scoring failure, a spend-cap refusal, or the streak bound
    // below (#1392 review round 1, F2) — map #552's "archive the bytes" step
    // never depended on scoring succeeding.
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
        // 'live' because we fetched it now. A backfill run stamps 'backfill',
        // because Alpaca's `created_at` is publisher time and a backfilled row
        // would otherwise assert we saw it the instant it published (#558).
        fidelity: 'live',
      }));
    if (newRaws.length > 0) {
      this.deps.archive.write(newRaws, []);
    }

    // One article carries a symbols[] array, so an article about three tickers
    // is three items — each scored against ITS OWN entity, because a headline
    // can be bullish for one ticker and bearish for another.
    // The wire symbol decides WHETHER this article is about the resolved MI
    // subject; the pipeline's own id (`miSubject`, #914/#960) is what the
    // item is filed under, so downstream joins see `BTC-USD` rather than the
    // vendor's `BTCUSD`, and an LSE ETP's items see the US underlying rather
    // than the traded wrapper ticker.
    //
    // Keyed on `hasScoredItem` (`mi_items`), NOT `hasItem` (`mi_archive_raw`,
    // used for `newRaws` above): a raw row with no scored item means an
    // earlier refresh's batch degraded and never scored it, and that article
    // must stay a scoring candidate for as long as it is inside the lookback
    // window — independent of whether its bytes are already on disk (#1392
    // review round 1, F2).
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
      // #1392 review round 2, finding 5: nothing here says scoring is still
      // failing — only that this refresh had no new work — so a streak left
      // over from a since-resolved outage must not survive to wrongly skip
      // the next refresh that finally has something to score.
      this.#degradedStreak.set(instrument, 0);
      return false;
    }

    // #1392 review round 1, F1: bounds a SUSTAINED outage's billed-call rate
    // — see `#degradedStreak`'s doc. A lone blip (streak 1) is unaffected.
    const streak = this.#degradedStreak.get(instrument) ?? 0;
    if (streak >= 2) {
      this.#degradedStreak.set(instrument, 0);
      // #1392 review round 2, finding 4: this used to be the only `return
      // false` in `refresh` with no log line — an operator watching
      // `mi_ingest_scoring_degraded` would see an outage start, then silence,
      // with no record of the further refreshes this bound kept suppressing.
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'mi_ingest_scoring_skipped',
        level: 'warn',
        message:
          `market intelligence: skipping the scoring attempt for ${instrument} after two ` +
          'consecutive failures; raw bytes stay archived and the next refresh tries again.',
        payload: { asset_class, instrument, items: unscored.length },
      });
      return false;
    }

    const pairs = unscored.map((article) => ({ article, entity: miSubject }));

    // Checked BEFORE the call — see `spendCap`'s doc on `MiIngestAgentDeps` for why.
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
        // #1392 review round 1, F5: `ScoreItemsDeps.logger` is required —
        // the defect this ticket fixes was precisely that nobody logged a
        // scoring failure, so a missing logger here falls back to a no-op
        // rather than silently reopening that gap. Matches the same
        // `logger ?? { log: () => {} }` idiom `debate-adapter.ts` already
        // uses for the same reason.
        logger: this.deps.logger ?? { log: () => {} },
        trace_id,
      },
    );

    if (degraded) {
      // Streak, not a reset: this attempt failed, so it counts toward the
      // bound above. Raw bytes for these articles are already archived
      // (`newRaws`, above) — only the score is missing.
      this.#degradedStreak.set(instrument, streak + 1);
      this.deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'mi_ingest_scoring_degraded',
        level: 'warn',
        message:
          `market intelligence: item scoring failed for ${pairs.length} item(s) for ` +
          `${instrument}; their raw bytes are archived, but nothing is scored, so the ` +
          'analysts will report NO DATA for this window rather than a fabricated neutral read.',
        payload: { asset_class, instrument, items: pairs.length },
      });
      return false;
    }
    this.#degradedStreak.set(instrument, 0);

    // `scoreItems` always returns exactly one score per supplied item, so
    // `scores[index]` should never be undefined here; treated the same as an
    // explicit `omitted: true` if it ever is — withheld below, not archived
    // with a fabricated score.
    //
    // An item the model's response omitted an index for is NOT archived
    // (#1420 review round 1): its raw bytes are already on disk (`newRaws`,
    // above), but writing a fabricated UNSCORED item to `mi_items` would make
    // `hasScoredItem` return true for that (source, native_id, updated_at,
    // entity) key forever — `write`'s `INSERT OR IGNORE` on that primary key
    // means the row could never later be upgraded to a real score, directly
    // contradicting `unscored`'s own contract above that an article "must
    // stay a scoring candidate for as long as it is inside the lookback
    // window". Leaving no `mi_items` row keeps it a candidate for a later
    // refresh, exactly like #1392's batch-wide degrade — retried until the
    // article ages out of the window, never served as a live item this tick.
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

    // Raws for these articles were already written above (or in an earlier
    // refresh, if this attempt is a retry after a prior batch degraded) —
    // only the items are new here.
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
        // Distinct from `instrument` exactly when this refresh was for an LSE
        // ETP row — the operator-visible evidence that the resolution step
        // ran (#914/#960).
        mi_subject: miSubject,
        // NEW raw rows written THIS refresh, pre-symbol-filter — matches this
        // field's pre-#1392 semantics (was `fresh.length`, filtered the same
        // way). `unscored.length` would always equal `items.length` here
        // (both are 1:1 maps of `pairs`), collapsing this into a degenerate
        // duplicate of `items` below. Can read 0 with `items` > 0: a batch
        // that degraded on an earlier refresh already wrote its raws then, so
        // a later refresh that finally scores it writes no NEW raw rows here.
        articles: newRaws.length,
        items: archivedItems.length,
      },
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
