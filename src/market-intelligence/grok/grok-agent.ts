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
 * **A 4-hour cadence, not per pass.** At ADR-0008's 15-minute tick the universe
 * produces ~296 instrument-passes/day; a call on each would be xAI spend
 * stacked on Anthropic debate spend against a $50/14-day cap. The interval is
 * DERIVED, not picked: both analysts read a 24h context window
 * (`MI_CONTEXT_WINDOW_MS`), and refreshing at 1/6th of the window bounds
 * staleness under 17% of what the window covers while costing ~36 calls/day
 * for six instruments instead of ~296.
 *
 * **Metered into `llm_spend`, so ADR-0008's cap is cross-provider.** The cap
 * sums `cost_usd` and does not care which provider produced the row. Two
 * things make that real rather than decorative: `stage: 'market_intelligence'`
 * (the column exists precisely so a non-debate caller's spend cannot land in
 * the debate's total), and an xAI entry in `MODEL_RATES` — without a rate,
 * `priceUsage` returns `null`, the row lands unpriced, and the cap would sum
 * past it. A second provider spending outside the ceiling would make the
 * ceiling a fiction.
 *
 * ## Degradation
 *
 * A refused or failed call leaves the store untouched, so the analysts fall
 * back to `NO_DATA_MARKER`. Never a fabricated neutral item: "we could not
 * afford to look" and "we looked and saw nothing" must stay distinguishable,
 * which is the same principle #463 is built on.
 */
import type { SpendCap } from '../../debate-engine/index.js';
import type { AssetClass, Clock, Logger } from '../../shared/index.js';
import type { MarketIntelligenceStore } from '../index.js';
import type { IntelligenceItem } from '../types.js';

/**
 * The refresh interval, and the bucket the cache keys on.
 *
 * Four hours = 1/6th of the analysts' 24h context window. See the module doc
 * for why that fraction rather than a round number.
 */
export const GROK_REFRESH_MS = 4 * 60 * 60 * 1000;

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
    latency_ms: number;
  }>;
}

/** What the agent needs to meter a call. Structurally satisfied by `LlmSpendSink`. */
export interface GrokSpendSink {
  record(entry: {
    trace_id: string;
    stage: string;
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
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
  /** Overridable for tests; defaults to the derived 4h. */
  refreshMs?: number;
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
   * agent called xAI" are different claims, and only the second one costs
   * money or produces data.
   *
   * NOT covered by `yarn smoke`, despite what an earlier version of this
   * comment claimed. The smoke run is offline and keyless, so the composition
   * root never builds a `GrokAgent` at all (`production.ts` gates it on
   * `XAI_API_KEY`) and there is nothing for the gate to observe. That is a real
   * hole in the #430 convention, not a decision: this mechanism's first live
   * exercise will be the soak itself. See the note in
   * `docs/specs/market-intelligence-spec.md`.
   *
   * NEVER THROWS. This is called from the tick path, and market intelligence
   * is an optional input: an xAI outage must degrade the debate to
   * `NO_DATA_MARKER`, not fail the tick that would otherwise have traded.
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
        latency_ms: result.latency_ms,
        timestamp: asOf,
      });

      this.#deps.store.ingest({
        agent_id: 'grok',
        timestamp: asOf,
        asset_class: assetClass,
        items: result.items,
      });

      // Marked only after a SUCCESSFUL call. Marking before would turn one
      // transient failure into four hours of silence.
      this.#buckets.set(instrument, bucket);
      return true;
    } catch (error) {
      this.#deps.logger?.log({
        trace_id,
        stage: 'market_intelligence',
        level: 'error',
        message:
          `grok: sentiment refresh failed for ${instrument} — ` +
          `${error instanceof Error ? error.message : String(error)}. The analysts will report ` +
          'NO DATA for this window; the bucket is NOT marked, so the next pass retries.',
        payload: { instrument },
      });
      return false;
    }
  }
}
