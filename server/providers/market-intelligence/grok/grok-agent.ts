/**
 * The Grok live-X sentiment agent — the first and only Market Intelligence
 * ingestion path (wayfinder map #436).
 *
 * `MarketIntelligenceStore` had no writer in production, so `sentiment` and
 * `fundamental` saw zero items on every tick. This is what gives them
 * something to read; `NO_DATA_MARKER` (#463) is the other half, for when
 * this agent still can't afford or find anything.
 *
 * One source, no Convergence Engine: the spec named Grok, DeepResearch and
 * WorldMonitor news merged by a Convergence Engine, but with one feed there
 * is nothing to converge, so it's deliberately not built.
 *
 * A 2-hour cadence, not per pass: at ADR-0008's 15-minute tick a call on
 * every pass would stack provider spend on debate spend against the
 * $50/14-day cap. The binding constraint is sample size, not staleness —
 * `sentiment-analyst.ts` averages retrieved posts, and too few per bucket
 * is noise. The cadence and the per-call result count are one decision,
 * not two (#969) — widening the universe or the count without revisiting
 * the cadence reintroduces the noise problem.
 *
 * Metered into `llm_spend` so ADR-0008's cap is cross-provider:
 * `stage: 'market_intelligence'` keeps this spend out of the debate's
 * total, and this role's model must have a rate in `MODEL_RATES` —
 * `nousCredentials` refuses to build a client for an unpriced model,
 * because an unpriced row would let spend escape the cap silently.
 *
 * Degradation: a refused or failed call leaves the store untouched, so the
 * analysts fall back to `NO_DATA_MARKER` — never a fabricated neutral
 * item. "We could not afford to look" and "we looked and saw nothing" must
 * stay distinguishable (#463's principle).
 *
 * `refresh` below adds a third case (#485): a call that succeeded and
 * parsed cleanly is still discarded unless `retrievalEvidence` says the
 * client actually looked — otherwise "saw nothing" and "recalled from
 * training data, never looked" would parse to the same shape. The guard
 * fails closed on absence of evidence, not on provider identity, so a
 * future client with real evidence starts passing without this file
 * changing.
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
 * See the module doc — this stopped being a staleness question and became
 * a sample-size one once retrieval became real.
 */
export const GROK_REFRESH_MS = 2 * 60 * 60 * 1000;

/** What one Grok call needs to return, normalised away from the wire shape */
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
     * Server-side tool invocations this call incurred. A provider that runs
     * a tool for you bills it per invocation on top of tokens, so the meter
     * needs the count or the cap under-charges. Optional, and absent from
     * every client we have since ADR-0009: `NousSentimentClient` posts to
     * `chat/completions`, which runs no server-side tool.
     */
    server_tool_calls?: number | undefined;
    /**
     * Whether this call carries evidence it actually retrieved something —
     * citations, or a tool-invocation step — as opposed to the model
     * answering from training-data recall alone. Required, not optional: a
     * client must say one way or the other rather than defaulting to
     * trusted.
     *
     * `NousSentimentClient` always returns `false` here, since Nous proxies
     * `chat/completions` only and neither citations nor a tool step can ride
     * on that endpoint. This is the seam for restoring real retrieval later
     * (#485 option 3): a client with genuine evidence sets this `true` and
     * `refresh` below starts trusting its items, with no change needed here.
     */
    retrievalEvidence: boolean;
    latency_ms: number;
    /**
     * The prompt sent and the text that came back, so this stage's calls
     * are as reconstructable as the debate's.
     *
     * Optional, unlike `retrievalEvidence`: an omission here costs a
     * diagnostic, not a correctness guarantee.
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
    /** The call's text (#1035); the sink decides whether to persist it */
    prompt?: string | undefined;
    response?: string | undefined;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    /** Passed through so the tool half of a provider's bill reaches `cost_usd` (#476) */
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
  /** Overridable for tests; defaults to `GROK_REFRESH_MS` */
  refreshMs?: number;
  /**
   * Where retrieved items are persisted for replay and the post-hoc
   * bot-share question (#969).
   *
   * Optional, and absent is a working configuration: a missing archive
   * costs replayability, not correctness, so it does not fail closed the
   * way a missing spend cap would.
   */
  archive?: MiArchiveStore | undefined;
}

/**
 * Floors an instant to its refresh bucket.
 *
 * Epoch-relative, matching `floorToBar`'s rule rather than inventing a
 * second time coordinate: every pass inside a bucket reuses one call, and a
 * replay stepping the same grid lands on the same coordinate.
 */
export function floorToRefreshBucket(at: Date, refreshMs: number = GROK_REFRESH_MS): Date {
  return new Date(Math.floor(at.getTime() / refreshMs) * refreshMs);
}

/**
 * What gets archived for one retrieved item.
 *
 * A narrowed projection, not the vendor's bytes — a deliberate deviation
 * from `market-intelligence-spec.md`'s "immutable vendor bytes" rule, the
 * same exemption GDELT takes with its six-column projection. Nobody has
 * cleared storing X post text against X's terms, so the verbatim body is
 * not stored; the permalink plus what this system derived is enough for
 * replay (scores are stored, never recomputed, per ADR-0003 §2) and for
 * the bot-share question `handle` answers (#1041 is what killed Bluesky
 * for lacking it).
 *
 * If X's terms turn out to bar even this, the fallback is citation-only
 * evidence with no archive row.
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
 * Builds the projection from an item, or `null` for an item with no usable
 * permalink.
 *
 * Reads the handle back out of the URL rather than taking it as a field:
 * `IntelligenceItem` has nowhere to put one, and deriving it means the
 * archived handle can't disagree with the archived link.
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
   * agent called the provider" are different claims, and only the second
   * one costs money or produces data.
   *
   * Not covered by `npm run smoke`: the smoke run is offline and keyless,
   * so the composition root never builds a `GrokAgent` at all, and there
   * is nothing for the gate to observe. This mechanism's first live
   * exercise is the soak itself. See `docs/specs/market-intelligence-spec.md`.
   *
   * Never throws from the fetch/spend/archive/ingest sequence below (one
   * try/catch) — market intelligence is an optional input, and a provider
   * outage degrades the debate to `NO_DATA_MARKER` rather than the run.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear bucket-check/spend-cap/fetch-meter-evidence-archive-ingest sequence per the doc comment above; splitting the try/catch's steps apart would scatter one refresh's ordering guarantees (meter before evidence-gate, archive before ingest, mark bucket only after success) across several functions.
  async refresh(trace_id: string, instrument: string, assetClass: AssetClass): Promise<boolean> {
    const asOf = this.#deps.clock.now();
    const bucket = floorToRefreshBucket(asOf, this.#refreshMs).getTime();

    if (this.#buckets.get(instrument) === bucket) return false;

    // Checked before the call, through the same seam the debate admits
    // against — a provider that spends first and asks later is outside the ceiling
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
      // is not a cap
      this.#deps.spendSink.record({
        trace_id,
        stage: 'market_intelligence',
        model: result.model,
        usage: result.usage,
        // Undefined for every client we have, but passed through rather
        // than dropped: a provider that bills tool invocations separately
        // from tokens would otherwise be silently under-counted
        server_tool_calls: result.server_tool_calls,
        latency_ms: result.latency_ms,
        timestamp: asOf,
        // Whether these are persisted is the sink's decision, not this
        // agent's — the agent's job is to stop discarding them
        prompt: result.prompt,
        response: result.raw_text,
      });

      // Fail-closed retrieval-evidence guard (#485): items that parsed
      // cleanly are still un-retrieved model recall unless the client can
      // point to actual evidence it looked. Discarding here, not upstream
      // in the client, keeps the guard transport-agnostic
      //
      // Logged on every call with no evidence, not only when it discards a
      // non-empty answer: `NousSentimentClient` reports no evidence on
      // every call, so this is the routine case, not the exceptional one,
      // and must stay distinguishable from "looked and saw nothing" in the
      // logs. `info` when there was nothing to discard, `warn` when real
      // items were dropped
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
      // transient failure into a whole bucket of silence
      this.#buckets.set(instrument, bucket);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // The one failure that is a configuration fault rather than an
      // outage (#969): `x_search` runs only on OpenRouter-routed models via
      // a floating alias, so the alias re-resolving to something unrouted
      // is a live risk, surfacing as a 400 on every call, forever, with
      // retries that cannot succeed
      //
      // `MiCoverageMonitor` alerts on the first coverage miss but can't say
      // why — this message turns that alert into a diagnosis
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
          // This transport does not go through `AnthropicLlmClient`, so it
          // is outside `llm_call_failed`'s count and carries the cause on
          // its own code instead
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
   * Never throws outward: an archive failure must not lose items that
   * already reached the live store, nor mark the bucket unfetched and
   * re-bill the call. This degrades to a warning — the opposite of the
   * spend cap's fail-closed posture, since this protects a diagnostic, not
   * money.
   *
   * Both halves of the write go in together, keyed on the status id — #835
   * established that archiving items and controlling boot behaviour
   * through `MI_SOURCE_HYDRATION` is the better trade than giving up
   * replay entirely (Polymarket's `write(raws, [])`).
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
        // instants rather than fetch instants
        updated_at: item.timestamp,
        payload: JSON.stringify(projection),
        ingested_at: asOf,
        // `backfill`, not `live`: the timestamp asserted is the post's
        // publication time, so this claims we would have seen it the
        // instant it published — a guarantee `live` would overstate by up
        // to a full refresh bucket
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
