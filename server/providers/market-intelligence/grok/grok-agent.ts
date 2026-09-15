/**
 * The Grok live-X sentiment agent (#464) — the first and only Market
 * Intelligence ingestion path, per the decisions locked on wayfinder map #436.
 *
 * ## Why this exists
 *
 * `MarketIntelligenceStore` had no writer in production, so `sentiment` and
 * `fundamental` saw zero items on every tick and returned a constant. Since
 * #463 they say so explicitly (`NO_DATA_MARKER`) rather than presenting the
 * absence as a neutral read — this is the other half: giving them something to
 * read.
 *
 * ## The three decisions this implements
 *
 * **One source, no Convergence Engine.** The spec names Grok, DeepResearch and
 * WorldMonitor news merged by a Convergence Engine. With one feed there is
 * nothing to converge, so it is deliberately not built. Stated as a v1
 * narrowing rather than left implicit.
 *
 * **A 2-hour cadence, not per pass.** At ADR-0008's 15-minute tick the universe
 * produces ~296 instrument-passes/day; a call on each would be provider spend
 * stacked on debate spend against a $50/14-day cap.
 *
 * The interval was 4 hours, derived as 1/6th of the analysts' 24h context
 * window (`MI_CONTEXT_WINDOW_MS`) — a staleness argument, made while no client
 * retrieved anything and the ingested item count was structurally zero. Once
 * retrieval is real the binding constraint changes: what matters is not how
 * stale the window is but how many posts land in it, because
 * `sentiment-analyst.ts` averages them and a three-post average is noise.
 * 2 hours doubles the sample, and the cost of that is bounded by two
 * multipliers worth re-deriving rather than quoting. Buckets are
 * SESSION-derived: `UniverseScheduler.nextTick` returns an empty instrument
 * list whenever the calendar says closed, so this refresh never fires outside
 * the session and a 6.5h US session touches 4 two-hour buckets, not 12. And
 * the universe is 20 names (#1051), not the 3 an earlier pass assumed. A soak
 * is therefore ~800 calls: ~$16 at the default result count against ADR-0008's
 * $50 cap, which the cap clears — but ~$71 at the ceiling, which it does not.
 * What 4 buckets binds is the SAMPLE: 4 x 3 = 12 posts/instrument/session is
 * thin, and does not improve as the universe widens. That is why the cadence
 * and the result count are one decision, not two (#969).
 *
 * **Metered into `llm_spend`, so ADR-0008's cap is cross-provider.** The cap
 * sums `cost_usd` and does not care which provider produced the row. Two
 * things make that real rather than decorative: `stage: 'market_intelligence'`
 * (the column exists precisely so a non-debate caller's spend cannot land in
 * the debate's total), and this role's model having a rate in `MODEL_RATES` —
 * without one, `priceUsage` returns `null`, the row lands unpriced, and the
 * cap would sum past it. `nousCredentials` refuses to build a client for an
 * unpriced model for exactly that reason: a stage spending outside the ceiling
 * would make the ceiling a fiction.
 *
 * ## Degradation
 *
 * A refused or failed call leaves the store untouched, so the analysts fall
 * back to `NO_DATA_MARKER`. Never a fabricated neutral item: "we could not
 * afford to look" and "we looked and saw nothing" must stay distinguishable,
 * which is the same principle #463 is built on.
 *
 * `refresh` below adds a third case (#485): a call that SUCCEEDED and parsed
 * cleanly is still discarded, not ingested, unless `retrievalEvidence` says
 * the client actually looked. "We looked and saw nothing" and "we recalled
 * from training data and never looked" would otherwise be the same shape —
 * both parse to items — so the guard is what keeps them apart. It fails
 * closed on the *absence of evidence*, not on provider identity, so a future
 * client that supplies real evidence (issue #485's option 3) starts passing
 * without this file changing.
 */
import type { SpendCap } from '../../../pipeline/debate-engine/index.js';
import { classifyFailureCause } from '../../../pipeline/debate-engine/index.js';
import type { AssetClass, Clock, Logger } from '../../../shared/index.js';
import type { ArchivedItem, MiArchiveStore, RawArchiveRow } from '../archive/mi-archive-store.js';
import { MI_SOURCES } from '../archive/mi-sources.js';
import type { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';

/**
 * The refresh interval, and the bucket the cache keys on.
 *
 * Two hours. See the module doc for why this stopped being a staleness
 * question and became a sample-size one when retrieval became real.
 */
export const GROK_REFRESH_MS = 2 * 60 * 60 * 1000;

/** What one Grok call needs to return, normalised away from the wire shape. */
export interface GrokSentimentClient {
  /**
   * Live X/Twitter sentiment for one instrument. Returns the items and the
   * usage, so the caller can meter without the client knowing about
   * `llm_spend`.
   */
  fetchSentiment(
    instrument: string,
    asOf: Date,
  ): Promise<{
    items: IntelligenceItem[];
    model: string;
    usage: { input_tokens: number; output_tokens: number };
    /**
     * Server-side tool invocations this call incurred (#476). A provider that
     * runs a tool for you bills it per invocation on top of tokens, so the
     * meter needs the count or the cap under-charges. Optional, and ABSENT
     * from every client we have since ADR-0009: `NousSentimentClient` posts to
     * `chat/completions`, which runs no server-side tool.
     */
    server_tool_calls?: number | undefined;
    /**
     * Whether THIS call carries evidence it actually retrieved something —
     * citations, or a tool-invocation step — as opposed to the model
     * answering from training-data recall alone (#485). REQUIRED, not
     * optional: a client must say one way or the other rather than letting an
     * omission default to trusted.
     *
     * `NousSentimentClient` always returns `false` here, because Nous proxies
     * `chat/completions` only and neither citations nor a tool step can ride
     * on that endpoint — see its header. This is the seam for restoring real
     * retrieval later (issue #485's option 3, a direct xAI `/v1/responses`
     * client): a client that produces genuine evidence sets this `true` and
     * `refresh` below starts trusting its items, with no change needed here.
     */
    retrievalEvidence: boolean;
    latency_ms: number;
    /**
     * The prompt sent and the text that came back (#1035), so this stage's
     * calls are as reconstructable as the debate's.
     *
     * Optional, unlike `retrievalEvidence`: an omission here costs a
     * diagnostic, not a correctness guarantee, so a client that cannot supply
     * it should not be forced to invent one. The one shipped client supplies
     * both.
     */
    prompt?: string | undefined;
    raw_text?: string | undefined;
  }>;
}

/** What the agent needs to meter a call. Structurally satisfied by `LlmSpendSink`. */
export interface GrokSpendSink {
  record(entry: {
    trace_id: string;
    stage: string;
    model: string;
    /** The call's text (#1035); the sink decides whether to persist it. */
    prompt?: string | undefined;
    response?: string | undefined;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    /** Passed through so the tool half of a provider's bill reaches `cost_usd` (#476). */
    server_tool_calls?: number | undefined;
    latency_ms: number;
    timestamp: Date;
  }): void;
}

export interface GrokAgentDeps {
  client: GrokSentimentClient;
  store: MarketIntelligenceStore;
  spendCap: SpendCap;
  spendSink: GrokSpendSink;
  clock: Clock;
  logger?: Logger;
  /** Overridable for tests; defaults to `GROK_REFRESH_MS`. */
  refreshMs?: number;
  /**
   * Where retrieved items are persisted for replay (#558) and for the
   * post-hoc bot-share question (#969).
   *
   * OPTIONAL, and absent is a working configuration: the live store is the
   * in-memory one, and this agent fed only that for its whole existence. A
   * missing archive costs replayability, not correctness — which is why it
   * does not fail closed the way a missing spend cap would.
   */
  archive?: MiArchiveStore | undefined;
}

/**
 * Floors an instant to its refresh bucket.
 *
 * Epoch-relative, matching `floorToBar`'s rule (#393) rather than inventing a
 * second time coordinate: every pass inside a bucket reuses one call, and a
 * replay stepping the same grid lands on the same coordinate.
 */
export function floorToRefreshBucket(at: Date, refreshMs: number = GROK_REFRESH_MS): Date {
  return new Date(Math.floor(at.getTime() / refreshMs) * refreshMs);
}

/**
 * What gets archived for one retrieved item.
 *
 * A NARROWED PROJECTION, not the vendor's bytes — a deliberate deviation from
 * `market-intelligence-spec.md`'s "immutable vendor bytes" rule (#554), taking
 * the same exemption GDELT already takes with its six-column projection.
 *
 * The reason is that nobody has cleared storing X post text against X's terms,
 * and an archive is the wrong place to discover the answer: it is the durable,
 * hard-to-unwind artifact. So the verbatim body is NOT stored. What is stored
 * is the permalink plus what this system derived — which is the same
 * score-plus-permalink posture already committed to for Reddit (#975), and is
 * enough for the two jobs the archive has here:
 *
 *   1. REPLAY (#558) — scores are stored, never recomputed, so a replayed
 *      backtest reads the same numbers a live run saw (ADR-0003 §2).
 *   2. BOT SHARE — `handle` is what makes "how much of this was bots?"
 *      answerable from soak data instead of needing a second study. That
 *      question is what killed Bluesky (#1041); going into a soak unable to
 *      ask it would repeat the mistake.
 *
 * If X's terms turn out to bar even this, the fallback is citation-only
 * evidence with no archive row, and the deviation gets recorded rather than
 * quietly widened.
 */
interface XArchiveProjection {
  status_id: string;
  permalink: string;
  handle: string;
  posted_at: string;
  entity: string;
  sentiment: number;
  confidence: number;
  retrieved_at: string;
}

/**
 * Builds the projection from an item, or `null` for an item that carries no
 * usable permalink.
 *
 * Reads the handle back out of the URL rather than taking it as a field:
 * `IntelligenceItem` has nowhere to put one, and the permalink is the only
 * thing here that a citation actually proved. Deriving it means the archived
 * handle cannot disagree with the archived link.
 */
function toArchiveProjection(item: IntelligenceItem, retrievedAt: Date): XArchiveProjection | null {
  if (item.url === undefined) return null;
  const match = /^https?:\/\/(?:www\.)?x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})$/.exec(
    item.url,
  );
  const handle = match?.[1];
  const statusId = match?.[2];
  if (handle === undefined || statusId === undefined) return null;

  return {
    status_id: statusId,
    permalink: item.url,
    handle,
    posted_at: item.timestamp.toISOString(),
    entity: item.entity,
    sentiment: item.sentiment,
    confidence: item.confidence,
    retrieved_at: retrievedAt.toISOString(),
  };
}

export class GrokAgent {
  /** instrument -> the bucket already fetched. In-memory: a restart refetches, which is correct. */
  readonly #buckets = new Map<string, number>();
  readonly #deps: GrokAgentDeps;
  readonly #refreshMs: number;

  constructor(deps: GrokAgentDeps) {
    this.#deps = deps;
    this.#refreshMs = deps.refreshMs ?? GROK_REFRESH_MS;
  }

  /**
   * Refreshes this instrument's sentiment if its bucket has rolled over.
   *
   * Returns whether a call was actually issued — "the agent ran" and "the
   * agent called the provider" are different claims, and only the second one
   * costs money or produces data.
   *
   * NOT covered by `npm run smoke`, despite what an earlier version of this
   * comment claimed. The smoke run is offline and keyless, so the composition
   * root never builds a `GrokAgent` at all (`production.ts` needs Nous
   * credentials before it constructs one, and `SAMURAI_SENTIMENT=off` skips it
   * outright) and there is nothing for the gate to observe. That is a real
   * hole in the #430 convention, not a decision: this mechanism's first live
   * exercise will be the soak itself. See the note in
   * `docs/specs/market-intelligence-spec.md`.
   *
   * NEVER THROWS from the fetch/spend/archive/ingest sequence below, which is
   * ONE try/catch. The pre-call cap check and the refusal-branch log above it
   * sit outside that guard — a throwing `SpendCap` or `Logger` there would
   * reject, which is what `MiRefreshQueue#dispatch`'s own catch exists to
   * cover; see its doc comment.
   *
   * Run inside `#dispatch`, invoked by `MiRefreshQueue`'s microtask worker
   * (`#pump`), off the tick's critical path (#1085) — directly when
   * `GrokAgent` is the only MI agent, or through `composeMarketIntelligence`'s
   * per-agent try/catch when `MiIngestAgent` also runs (the current
   * production wiring). Nothing upstream needs the guarded sequence's resolve
   * to keep a tick alive — both wrappers catch — but in the single-agent
   * wiring `refresher` IS this agent, so a rejection from it would ALSO trip
   * `#dispatch`'s own `mi_refresh_threw` line: a second report of a failure
   * this method already logged, whose message is a fixed template naming the
   * instrument and whose payload carries the rendered error text, but not
   * this method's own interpretation of it (the unrouted-model call-out
   * below). Market intelligence is an optional input either way: a provider
   * outage degrades the debate to `NO_DATA_MARKER`.
   */
  async refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean> {
    const asOf = this.#deps.clock.now();
    const bucket = floorToRefreshBucket(asOf, this.#refreshMs).getTime();

    if (this.#buckets.get(instrument) === bucket) return false;

    // Checked BEFORE the call, through the same seam the debate admits against.
    // A provider that spends first and asks later is outside the ceiling.
    const verdict = this.#deps.spendCap.check();
    if (!verdict.admitted) {
      this.#deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'grok_refresh_refused_spend_cap',
        level: 'warn',
        message:
          `grok: refusing to refresh ${instrument} — ${verdict.reason ?? 'spend cap reached'}. ` +
          'The analysts will report NO DATA for this window rather than a fabricated neutral ' +
          'item, so the debate can tell "could not afford to look" from "saw nothing".',
        payload: { instrument, spent_usd: verdict.spent_usd, budget_usd: verdict.budget_usd },
      });
      return false;
    }

    try {
      const result = await this.#deps.client.fetchSentiment(instrument, asOf);

      // Metered whether or not any items came back: a call that returned
      // nothing still cost money, and a cap that only counts productive calls
      // is not a cap.
      this.#deps.spendSink.record({
        trace_id,
        stage: 'market_intelligence',
        model: result.model,
        usage: result.usage,
        // Undefined for every client we have (see the interface above), but
        // passed through rather than dropped: a provider that bills tool
        // invocations separately from tokens would otherwise be under-counted
        // by the meter, silently, on every call.
        server_tool_calls: result.server_tool_calls,
        latency_ms: result.latency_ms,
        timestamp: asOf,
        // #1035. Whether these are persisted is the sink's decision
        // (`SqliteLlmSpendStore`'s `captureText`), not this agent's — the
        // agent's job is to stop discarding them.
        prompt: result.prompt,
        response: result.raw_text,
      });

      // Fail-closed retrieval-evidence guard (#485, restoring the principle
      // #474 had and ADR-0009's cutover dropped). Items that parsed cleanly
      // are still un-retrieved model recall unless the client can point to
      // actual evidence it looked — this is what keeps "we could not look"
      // distinguishable from "we looked and saw nothing" once a third case
      // ("we recalled, but never looked") becomes possible. Discarding here,
      // not upstream in the client, means the guard is transport-agnostic:
      // it fires the same way for any future client, Nous or otherwise.
      //
      // Logged on EVERY call with no evidence, not only when it discards a
      // non-empty answer: `NousSentimentClient` reports no evidence on every
      // call it makes (chat/completions cannot carry any), so that is the
      // routine case, not the exceptional one, and it must still be visible
      // as "could not look" rather than reading identically to "looked and
      // saw nothing" in the logs. `info` when there was nothing to discard,
      // `warn` when real items were dropped — the level itself carries
      // whether anything was actually lost this call.
      const items = result.retrievalEvidence ? result.items : [];
      if (!result.retrievalEvidence) {
        this.#deps.logger?.log({
          trace_id,
          stage: 'market_intelligence',
          event: 'grok_retrieval_evidence_absent',
          level: result.items.length > 0 ? 'warn' : 'info',
          message:
            result.items.length > 0
              ? `grok: discarding ${result.items.length} item(s) for ${instrument} — the ` +
                'response parsed cleanly but carried no evidence of retrieval (no citations, no ' +
                'tool step), so it cannot be told apart from model recall. Reporting NO DATA ' +
                'instead of risking confabulated sentiment as signal. See #485.'
              : `grok: no retrieval evidence for ${instrument} this call (no citations, no tool ` +
                'step) — reporting NO DATA. "Could not look" rather than "looked and saw ' +
                'nothing". See #485.',
          payload: { instrument, discarded_items: result.items.length },
        });
      }

      this.#archive(trace_id, items, asOf, assetClass);

      this.#deps.store.ingest({
        agent_id: 'grok',
        timestamp: asOf,
        asset_class: assetClass,
        items,
      });

      // Marked only after a SUCCESSFUL call. Marking before would turn one
      // transient failure into a whole bucket of silence.
      this.#buckets.set(instrument, bucket);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // The one failure that is a CONFIGURATION fault rather than an outage,
      // called out by name (#969).
      //
      // `x_search` runs only on OpenRouter-routed models, and the model is a
      // floating alias — pinning is not on the menu, because the tool 400s on
      // every pinned id. So the alias re-resolving to something unrouted is a
      // live risk, and its symptom is this 400 on every call, forever, with
      // retries that cannot succeed.
      //
      // The operator is NOT unalerted when this happens: zero items means
      // empty `social`, and `MiCoverageMonitor` alerts on the FIRST coverage
      // miss. What that alert cannot say is WHY — it reports "no coverage for
      // TSLA", which reads identically to a quiet news hour. This message is
      // what turns that alert into a diagnosis, so it names the cause and the
      // fix rather than being one more provider error in the stream.
      const unroutedModel = /search tools are not available|OpenRouter-routed/i.test(detail);
      this.#deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'grok_refresh_failed',
        level: 'error',
        message: unroutedModel
          ? `grok: RETRIEVAL IS DARK for ${instrument} — the provider refused the server-side ` +
            `search tool for this model (${detail}). This is a configuration fault, not an ` +
            'outage: retries cannot fix it, and every subsequent call will fail the same way ' +
            'until the model is changed. The routed alias has probably re-resolved to a model ' +
            'that does not carry the tool. Expect the coverage alert for every instrument; ' +
            'this is its cause. See `X_SEARCH_MODEL` in x-search-client.ts.'
          : `grok: sentiment refresh failed for ${instrument} — ${detail}. The analysts will ` +
            'report NO DATA for this window; the bucket is NOT marked, so the next pass retries.',
        payload: {
          instrument,
          // #1394. This transport does not go through `AnthropicLlmClient`, so
          // it is outside `llm_call_failed`'s count and carries the cause on
          // its own code instead.
          failure_cause: classifyFailureCause(error),
          ...(unroutedModel ? { unrouted_model: true } : {}),
        },
      });
      return false;
    }
  }

  /**
   * Persists the narrowed projection for the items that survived the gate.
   *
   * NEVER THROWS OUTWARD. An archive failure — a locked file, a full disk —
   * must not lose the items that already reached the live store, nor mark the
   * bucket unfetched and re-bill the call. Replayability is worth less than
   * the run continuing, so this degrades to a warning. That is the opposite
   * balance from the spend cap, which fails closed, and the asymmetry is
   * deliberate: one protects money, this protects a diagnostic.
   *
   * Both halves of the write go in together (`RawArchiveRow` +
   * `ArchivedItem`), keyed on the status id. Polymarket's `write(raws, [])`
   * bought its boot property by giving up replay entirely; #835 established
   * that archiving items and controlling boot behaviour through
   * `MI_SOURCE_HYDRATION` is the better trade, and this source takes it.
   */
  #archive(
    trace_id: string,
    items: readonly IntelligenceItem[],
    asOf: Date,
    assetClass: AssetClass,
  ): void {
    const archive = this.#deps.archive;
    if (archive === undefined || items.length === 0) return;

    const raws: RawArchiveRow[] = [];
    const rows: ArchivedItem[] = [];

    for (const item of items) {
      const projection = toArchiveProjection(item, asOf);
      if (projection === null) continue;

      raws.push({
        source: MI_SOURCES.x,
        native_id: projection.status_id,
        // The POST's own time, so a revision ordering compares publication
        // instants rather than fetch instants.
        updated_at: item.timestamp,
        payload: JSON.stringify(projection),
        ingested_at: asOf,
        // `backfill`, not `live`: the timestamp asserted is the post's
        // publication time, so the row claims we would have seen it the
        // instant it published — which is the same guarantee Alpaca's
        // publisher-dated rows carry, and weaker than GDELT's batch stamp.
        // Claiming `live` here would overstate the lookahead guarantee by up
        // to a full refresh bucket.
        fidelity: 'backfill',
      });

      rows.push({
        source: MI_SOURCES.x,
        native_id: projection.status_id,
        updated_at: item.timestamp,
        entity: item.entity,
        asset_class: assetClass,
        item,
        ingested_at: asOf,
      });
    }

    if (raws.length === 0) return;

    try {
      archive.write(raws, rows);
    } catch (error) {
      this.#deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        event: 'grok_archive_write_failed',
        level: 'warn',
        message:
          `grok: archiving ${raws.length} retrieved item(s) failed — ` +
          `${error instanceof Error ? error.message : String(error)}. The items still reached ` +
          'the live store, so this run is unaffected; what is lost is replay and the ' +
          'post-hoc bot-share check for this bucket.',
        payload: { items: raws.length },
      });
    }
  }
}
