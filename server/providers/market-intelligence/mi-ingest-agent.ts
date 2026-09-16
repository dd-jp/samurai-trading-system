/**
 * The deterministic MI ingestion path (map #552).
 *
 * Replaces the retrieval-from-LLM design that fails closed by construction:
 * `NousSentimentClient` hard-codes `retrievalEvidence: false`, `GrokAgent
 * .refresh` discards every item without evidence, so the store ingests `[]`
 * on every refresh and both news-fed analysts report `NO_DATA_MARKER`
 * forever.
 *
 * The shape here: fetch deterministically, archive the bytes, score
 * separately, serve from the archive. No model is asked to retrieve; it is
 * only asked to classify text already on disk.
 *
 * `hydrate()` reloads the store from the archive at startup, so a soak
 * restart — which used to empty the in-memory store and silently measure
 * less than it appeared to — costs nothing.
 *
 * That durability is per source, not global (#835): `hydrate()` replays
 * only the sources `MI_SOURCE_HYDRATION` marks `hydrate` — dated
 * observations. A source whose item is a trailing-window statistic
 * (Polymarket's 24h delta) is archived for replay but deliberately not
 * pushed back into the live store at boot, since re-serving a stale
 * measurement as current is a different defect from losing it.
 *
 * Deviation from #554 sub-decision 4: that decision says
 * `MarketIntelligenceStore` "becomes a read-through view over the
 * archive". This keeps the store as an in-memory cache and hydrates it
 * from the archive instead — same durability property, and it leaves the
 * store's push-subscription path untouched rather than rewriting a working
 * delivery mechanism inside an ingestion change.
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
 * Caps the exponential backoff's skip count. Without a cap a sustained
 * outage would push the gap between attempts out unboundedly, and an
 * outage that resolves mid-gap would go undetected for longer each time it
 * recurred. 8 keeps the worst case at 9 refreshes between attempts —
 * under paper-profile.ts's 2-minute cadence, under `LOOKBACK_MS` either way.
 */
const MAX_DEGRADED_SKIP = 8;

interface DegradedState {
  readonly streak: number;
  readonly skipRemaining: number;
  /** `clock.now()` (ms) of the failure that produced this `streak`. Unused while `streak` is 0. */
  readonly lastFailureAt: number;
}

const ZERO_DEGRADED: DegradedState = { streak: 0, skipRemaining: 0, lastFailureAt: 0 };

/**
 * Refreshes to skip before the next scoring attempt, given the streak a
 * failure has just extended it to. Streak 1 always retries immediately (a
 * lone blip must not trip backoff); streak 2 skips exactly 1. Only a third
 * straight failure diverges and starts doubling.
 */
function degradedSkip(streak: number): number {
  return streak < 2 ? 0 : Math.min(2 ** (streak - 2), MAX_DEGRADED_SKIP);
}

/**
 * `#degraded`'s read path: a `streak` left over from an outage that ended
 * more than `LOOKBACK_MS` ago decays back to 0 rather than persisting
 * forever. Nothing else clears a nonzero streak except a successful
 * scoring attempt — a quiet refresh (nothing new to score) only clears
 * `skipRemaining`, so a quiet tick mid-outage can't be mistaken for
 * recovery. Without this decay, a stale streak would hand its full skip
 * to the first unrelated failure hours or days later, turning one
 * transient error into an up-to-`MAX_DEGRADED_SKIP`-refresh blackout.
 * Keyed on `LOOKBACK_MS`, the same window that keeps a failed article a
 * scoring candidate.
 */
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
   * Read before `scoreItems`, the way `GrokAgent` reads its own.
   * `llmClient` meters into `llm_spend` but enforces nothing by itself, so
   * without this the only ceiling on the news-scoring path was
   * `MiRefreshQueue`'s single pre-pass check — which covered the pair only
   * while this agent happened to run first in the composition root's array.
   *
   * Relies on `SqliteSpendCap.check()` re-querying `SUM(cost_usd)` fresh on
   * every call against `spendSink.record`'s synchronous `better-sqlite3`
   * insert: whichever of this agent and `GrokAgent` runs first sees its own
   * write reflected in the other's next `check()`.
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

/** Maps an Alpaca article + one of its symbols into the analyst-facing shape */
function toItem(
  article: AlpacaNewsArticle,
  entity: string,
  score: { sentiment: 1 | 0 | -1; confidence: number },
): IntelligenceItem {
  return {
    // Stable and content-derived, so a re-ingest cannot produce a second item
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
   * Per-instrument scoring-degradation state, in memory.
   *
   * Without `degradedSkip` bounding it, `hasScoredItem` (below) would make
   * a degraded batch retry on every refresh for as long as the article
   * stays inside `LOOKBACK_MS` — a sustained outage billing up to
   * `DEFAULT_LLM_RETRY.maxAttempts` calls per tick for the whole window.
   * `degradedSkip` widens the gap after each straight failure (capped, see
   * `MAX_DEGRADED_SKIP`), and `streak` persists across a skipped refresh —
   * only a refresh that actually attempts scoring and succeeds resets it
   * to 0. A single blip is unaffected: streak 1 always retries on the very
   * next refresh. The MI spend cap remains the real backstop; this only
   * slows how fast one instrument's outage burns toward it.
   *
   * A refresh with nothing new to score clears a pending `skipRemaining`
   * cooldown — that refresh proves nothing about whether scoring itself is
   * still failing — but does not reset `streak`: an outage can have a
   * quiet tick with no matching articles in the middle of it, and
   * resetting `streak` there would undo the escalation this exists for.
   *
   * `streak` decays, but only on a read, and only after `LOOKBACK_MS` has
   * passed since the failure that set it (see `readDegraded`) — without
   * this, an outage that genuinely ended would leave its streak sitting
   * forever, and the first unrelated failure hours or days later would
   * inherit its full skip instead of being treated as the lone blip it is.
   */
  readonly #degraded = new Map<string, DegradedState>();

  constructor(private readonly deps: MiIngestAgentDeps) {}

  /**
   * Reloads the store from the archive — call once at startup, before the first
   * tick. Everything knowable now, per asset class.
   */
  hydrate(): void {
    const asOf = this.deps.clock.now();
    for (const asset_class of this.deps.assetClasses) {
      // Only the sources whose archived items are dated observations
      // Polymarket's item is a trailing 24h delta and GDELT's, when its
      // scoring half lands, is a 1h-vs-24h window statistic; replaying
      // either at boot would re-serve a stale measurement as current
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
   * drop-in for `GrokAgent` at the analysts step — called before the
   * analysts run, so a refreshed window is visible to the very tick that
   * paid for it.
   *
   * Never throws, and returns `false` rather than propagating: a vendor
   * outage or a scoring failure must degrade the desk to "no new
   * intelligence" rather than take down a tick that would otherwise have
   * traded on the technical analyst alone.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear resolve/fetch/archive-raw/filter-unscored/backoff-guard/spend-cap/score/archive-scored/ingest sequence per the doc comment above; splitting the steps apart would scatter one refresh's ordering guarantees (raws archived independent of scoring outcome, streak only cleared on an actual successful score) across several functions.
  async refresh(trace_id: string, instrument: string, asset_class: AssetClass): Promise<boolean> {
    // An LSE-listed leveraged ETP generates no headlines of its own —
    // resolve to the US underlying (`screening_instrument`) before
    // fetching, and file the resulting items under that same resolved
    // subject (see `entity` below) so the entity-scoped analyst reads find
    // them. `resolveMiSubject` is the identity for every non-pool
    // instrument, so today's universe is unaffected
    const miSubject = resolveMiSubject(instrument);
    const symbols = [wireSymbol(miSubject)];

    const now = this.deps.clock.now();
    const start = new Date(now.getTime() - LOOKBACK_MS);

    let articles: AlpacaNewsArticle[];
    try {
      articles = await this.deps.newsClient.fetchNews(symbols, start, now);
    } catch (error) {
      // `trace_id` is a required `string` param, never null/undefined — an
      // `?? fallback` here would be dead code
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

    // New raw bytes only — `write`'s `INSERT OR IGNORE` would absorb a
    // repeat regardless, but recomputing every fetched article's row on
    // every tick is wasted work. Archived unconditionally, below,
    // independent of scoring: a fetch that succeeded must not lose its
    // bytes to a scoring failure, a spend-cap refusal, or the streak bound
    // below — "archive the bytes" never depended on scoring succeeding
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
        // 'live' because we fetched it now. A backfill run stamps
        // 'backfill', because Alpaca's `created_at` is publisher time and
        // a backfilled row would otherwise assert we saw it the instant it
        // published
        fidelity: 'live',
      }));
    if (newRaws.length > 0) {
      this.deps.archive.write(newRaws, []);
    }

    // One article carries a symbols[] array, so an article about three
    // tickers is three items — each scored against its own entity, because
    // a headline can be bullish for one ticker and bearish for another
    // The wire symbol decides whether this article is about the resolved
    // MI subject; the pipeline's own id (`miSubject`) is what the item is
    // filed under, so downstream joins see `BTC-USD` rather than the
    // vendor's `BTCUSD`, and an LSE ETP's items see the US underlying
    // rather than the traded wrapper ticker
    //
    // Keyed on `hasScoredItem` (`mi_items`), not `hasItem`
    // (`mi_archive_raw`, used for `newRaws` above): a raw row with no
    // scored item means an earlier refresh's batch degraded and never
    // scored it, and that article must stay a scoring candidate for as
    // long as it is inside the lookback window, independent of whether its
    // bytes are already on disk
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
      // Nothing here says scoring is still failing — only that this
      // refresh had no new work — so a pending skip cooldown must not
      // survive to wrongly skip the next refresh that finally has
      // something to score. But this is not the "healthy batch" that
      // should reset `streak`: an outage can legitimately have a quiet
      // refresh (no matching articles this cycle) in the middle of it, and
      // resetting `streak` here would restart backoff from scratch on the
      // next failure. Only an actual successful scoring attempt earns that
      // reset (see the `degraded` branch below)
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

    // Bounds a sustained outage's billed-call rate with backoff that widens
    // on each straight failure — see `#degraded`'s doc. A lone blip
    // (streak 1) is unaffected. `readDegraded` decays a streak the last
    // failure left stale for a full `LOOKBACK_MS` — the quiet-refresh
    // branch above needs no equivalent decay: its guard only fires while
    // `skipRemaining > 0`, which always reaches 0 (at most
    // `MAX_DEGRADED_SKIP` refreshes, well under `LOOKBACK_MS`) long before
    // a streak would be old enough to decay
    const state = readDegraded(this.#degraded, instrument, now);
    if (state.skipRemaining > 0) {
      const next: DegradedState = {
        streak: state.streak,
        skipRemaining: state.skipRemaining - 1,
        lastFailureAt: state.lastFailureAt,
      };
      this.#degraded.set(instrument, next);
      // Logged so an operator watching `mi_ingest_scoring_degraded` sees
      // the further refreshes this bound is suppressing, not just an
      // outage that starts and then goes silent
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

    // Checked BEFORE the call — see `spendCap`'s doc on `MiIngestAgentDeps` for why
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
        // `ScoreItemsDeps.logger` is required — a missing logger falls back
        // to a no-op rather than silently dropping scoring-failure logs,
        // matching the same `logger ?? { log: () => {} }` idiom
        // `debate-adapter.ts` uses
        logger: this.deps.logger ?? { log: () => {} },
        trace_id,
      },
    );

    if (degraded) {
      // Extends the streak, not a reset: this attempt failed, so it counts
      // toward the bound above and widens the next gap (`degradedSkip`)
      // Raw bytes for these articles are already archived (`newRaws`,
      // above) — only the score is missing
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

    // `scoreItems` always returns exactly one score per supplied item, so
    // `scores[index]` should never be undefined here; treated the same as
    // an explicit `omitted: true` if it ever is — withheld below, not
    // archived with a fabricated score
    //
    // An item the model's response omitted an index for is not archived:
    // its raw bytes are already on disk, but writing a fabricated
    // unscored item to `mi_items` would make `hasScoredItem` return true
    // for that key forever — `write`'s `INSERT OR IGNORE` means the row
    // could never later be upgraded to a real score. Leaving no `mi_items`
    // row keeps it a candidate for a later refresh, retried until the
    // article ages out of the window
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
    // only the items are new here
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
        // Distinct from `instrument` exactly when this refresh was for an
        // LSE ETP row — operator-visible evidence that the resolution step
        // ran
        mi_subject: miSubject,
        // New raw rows written this refresh, pre-symbol-filter. Can read 0
        // with `items` > 0: a batch that degraded on an earlier refresh
        // already wrote its raws then, so a later refresh that finally
        // scores it writes no new raw rows here
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
 * The repo carries crypto as `BTC-USD` while Alpaca expects `BTCUSD`.
 * Converting here rather than at the call site keeps that knowledge in
 * the one module that talks to this vendor.
 */
function wireSymbol(instrument: string): string {
  return instrument.replace(/-/g, '');
}
