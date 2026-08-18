/**
 * `LlmSpendSink` — the seam `AnthropicLlmClient` writes token usage through,
 * plus its SQLite implementation over the `llm_spend` table
 * (migrations/0010_llm_spend.sql).
 *
 * An interface rather than a direct store dependency for the reason the rest
 * of the debate engine takes ports: this layer owns provider mechanics, not
 * persistence, and the vast majority of its tests have no database. The
 * default is `NULL_SPEND_SINK`, so a client constructed without one meters
 * nothing and behaves exactly as it did before this existed.
 *
 * RECORDING MUST NEVER FAIL A CALL. A metering write is bookkeeping attached
 * to a request whose result the trading loop is waiting on; letting a locked
 * database or a schema drift turn a completed, already-billed LLM response
 * into a thrown error would trade a real answer for an accounting detail.
 * `SqliteLlmSpendStore.record` therefore swallows its own failures to a `warn`
 * and returns. That is a deliberate, narrow exception to this codebase's
 * usual "throw rather than continue on bad state" posture, justified by the
 * write being append-only, non-authoritative, and read by nothing that makes a
 * trading decision.
 */

import {
  type AnthropicUsage,
  priceServerToolCalls,
  priceUsage,
} from '../../../shared/llm/pricing.js';
import type { SharedStore } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/sqlite-utils.js';
import type { Logger } from '../../../shared/types.js';

/** One metered API call, as handed to the sink. */
export interface LlmSpendRecord {
  trace_id: string;
  /**
   * Which pipeline stage issued the call, for attributing an unexpected bill.
   *
   * Today this is always `'debate'`, and that is a fact about the system
   * rather than a gap in the plumbing: the debate personas
   * (`debate-engine/personas.ts`) and `detectDisagreements` are the ONLY
   * `LlmClient.complete()` call sites in the codebase. The three analysts
   * (technical, fundamental, sentiment) are deterministic numeric scorers —
   * `sentiment-analyst.ts` says so in its own header: "over the
   * primary/context inputs, not an LLM call" — so there is no Analyst-stage
   * spend to record. The column stays because the day an analyst becomes
   * LLM-backed, its calls must not silently land in the debate's cost.
   */
  stage: string;
  /**
   * The debate this call belongs to — the join key to `debate_log.debate_id`
   * (#326, migrations/0012). Absent for a call issued outside a debate, and
   * for any caller that does not thread it; such calls are counted as
   * `unattributed_calls` on the dashboard rather than silently folded into
   * some other debate's total.
   */
  debate_id?: string | undefined;
  model: string;
  usage: AnthropicUsage;
  /**
   * How many SERVER-SIDE tool invocations this call incurred (#476).
   *
   * Zero or absent on every call this system currently makes: ADR-0009 routes
   * all of them through Nous's `chat/completions`, which runs no server-side
   * tool. The field survives the cutover because the charge it prices is real
   * wherever a provider does run one — "Tool requests are priced based on two
   * components: token usage and tool invocations" — and a meter that has no
   * slot for it under-counts silently rather than loudly.
   *
   * Priced independently of `MODEL_RATES`, so it lands in `cost_usd` even when
   * the model itself is unrecognised.
   */
  server_tool_calls?: number | undefined;
  /** Wall-clock time for this one API call, as measured by the client. */
  latency_ms: number;
  timestamp: Date;
}

export interface LlmSpendSink {
  record(entry: LlmSpendRecord): void;
}

/**
 * The default. Not a no-op for convenience — it is what makes metering opt-in,
 * so `AnthropicLlmClient` keeps working unchanged in the many tests and the
 * backtest path that have no shared store.
 */
export const NULL_SPEND_SINK: LlmSpendSink = { record: () => {} };

/** Appends to `llm_spend`, pricing the usage on the way in. */
export class SqliteLlmSpendStore implements LlmSpendSink {
  constructor(
    private readonly db: SharedStore,
    private readonly logger?: Logger,
  ) {}

  record(entry: LlmSpendRecord): void {
    try {
      // Priced at WRITE time, not read time, so the row keeps the rate that
      // was in force when the call happened. Pricing at read time would make
      // every historical row silently reprice the next time the table in
      // pricing.ts is edited, quietly rewriting spend history that an
      // operator may have already looked at.
      const tokenCost = priceUsage(entry.model, entry.usage);
      const toolCalls = entry.server_tool_calls ?? 0;
      const toolCost = priceServerToolCalls(toolCalls);

      // The two halves are priced independently, and the tool half is recorded
      // EVEN WHEN THE TOKEN HALF IS NOT (#476). Discarding a charge we know
      // exactly, because a different charge is missing from a rate table,
      // would under-count the cap for the same reason the phantom `grok-4`
      // rate over-counted it — a number we hold and throw away is the worst of
      // the three options. Such a row stays recognisable: `server_tool_calls`
      // is non-zero while `cost_usd` is too small to cover the tokens.
      const cost = tokenCost === null ? (toolCost > 0 ? toolCost : null) : tokenCost + toolCost;

      if (tokenCost === null) {
        // The gap #476 named: nothing used to say when a call that cost money
        // went unpriced. A silent null is how a cap stops being a cap.
        this.logger?.log({
          trace_id: entry.trace_id,
          stage: 'orchestrator',
          level: 'warn',
          message:
            `llm spend: model '${entry.model}' is not in MODEL_RATES, so its TOKEN cost is ` +
            'unpriced and does not count against the budget cap. Add a rate for it in ' +
            'pricing.ts. ' +
            (toolCost > 0
              ? `The ${toolCalls} server-side tool invocation(s) on this call ARE priced and ` +
                'recorded, so the row is not empty — but it understates the true cost.'
              : 'This call contributes nothing to the cap total.'),
          payload: { model: entry.model, server_tool_calls: toolCalls },
        });
      }

      this.db
        .prepare(
          `INSERT INTO llm_spend (
             trace_id, stage, debate_id, model,
             input_tokens, output_tokens,
             cache_creation_input_tokens, cache_read_input_tokens,
             cost_usd, server_tool_calls, latency_ms, timestamp
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.trace_id,
          entry.stage,
          // `?? null`, not the raw `undefined`: better-sqlite3 refuses to bind
          // `undefined` ("Invalid value"), so an unattributed call would throw
          // into the swallowing catch below and lose the row entirely — a
          // metering bug that would look exactly like a quiet dashboard.
          entry.debate_id ?? null,
          entry.model,
          entry.usage.input_tokens,
          entry.usage.output_tokens,
          entry.usage.cache_creation_input_tokens ?? 0,
          entry.usage.cache_read_input_tokens ?? 0,
          cost,
          toolCalls,
          entry.latency_ms,
          toStoredTimestamp(entry.timestamp),
        );
    } catch (error) {
      // See the module doc comment: a metering failure must not surface as a
      // failed LLM call. Logged rather than silent so a persistently broken
      // meter is visible instead of just producing a flat spend line.
      this.logger?.log({
        trace_id: entry.trace_id,
        stage: 'orchestrator',
        level: 'warn',
        message:
          'llm spend metering write failed — the API call itself succeeded and is unaffected, ' +
          'but this call is missing from the dashboard spend total',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
