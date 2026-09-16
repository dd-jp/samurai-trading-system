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

import type { Logger } from '../../../shared/index.js';
import { maskAndCap } from '../../../shared/index.js';
import {
  type AnthropicUsage,
  crossesPromptTier,
  priceServerToolCalls,
  priceUsage,
  promptTokensOf,
  rateFor,
} from '../../../shared/llm/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { toStoredTimestamp } from '../../../shared/store/index.js';
import { type PromptTierAlertChannel, PromptTierCrossingThrottle } from './prompt-tier-alert.js';

/** One metered API call, as handed to the sink */
export interface LlmSpendRecord {
  trace_id: string;
  /**
   * Which pipeline stage issued the call, for attributing an unexpected bill.
   * `'debate'` and `'risk_critic'` (#957) bill through the SAME `LlmClient`,
   * so without this column the critic's cost would land inside the
   * debate's. Rows still carry `debate_id`, so the dashboard's per-decision
   * totals attribute it to the decision it was spent on.
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
   * Zero or absent on every call this system currently makes — ADR-0009
   * routes calls through Nous's `chat/completions`, which runs no
   * server-side tool — but the field stays because the charge it prices is
   * real wherever a provider does run one, and a meter with no slot for it
   * would under-count silently. Priced independently of `MODEL_RATES`, so it
   * lands in `cost_usd` even when the model itself is unrecognised.
   */
  server_tool_calls?: number | undefined;
  /** Wall-clock time for this one API call, as measured by the client */
  latency_ms: number;
  /**
   * Time-to-first-byte (#1012): the `latency_ms` prefix spent waiting for
   * response headers, before the body is read — see `nous-chat.ts`'s
   * `NousChatResult.ttfb_ms` doc comment. Undefined for any wire client that
   * doesn't report it (`AnthropicMessageResponse.ttfb_ms` is optional), and
   * persisted as NULL in that case — see `migrations/0038_llm_spend_ttfb.sql`.
   */
  ttfb_ms?: number | undefined;
  timestamp: Date;
  /**
   * The exact string sent to the provider (#1035) — `renderMessageContent`'s
   * output, not a reconstruction from `request.prompt` and the context.
   *
   * Optional because the sink's other callers do not all have it, and because
   * a `LlmSpendRecord` built by a test double should not have to invent one.
   * Masked and capped by `SqliteLlmSpendStore`, not by the caller: the bound
   * belongs at the boundary that persists it, so every writer gets the same
   * one.
   */
  prompt?: string | undefined;
  /** The model's raw response text, same provenance and same treatment as `prompt` */
  response?: string | undefined;
  /**
   * `hashPromptTemplate("<stageTemplateHash>:<wireEnvelopeHash>")` (#1514) —
   * the call's stage's static template combined with the shared wire
   * envelope every call passes through (`WIRE_ENVELOPE_TEMPLATE_HASH`,
   * `anthropic-client.ts`), not the rendered prompt (varies per call) and
   * not the bare stage hash alone (misses an envelope edit). Computed by
   * `AnthropicLlmClient.recordSpend` via `withWireEnvelope`; a record built
   * directly (e.g. in a test) must supply the same composite. Undefined when
   * a call site hasn't been wired for it; persisted as NULL rather than
   * fabricated (migrations/0058).
   */
  prompt_template_hash?: string | undefined;
}

/**
 * How much of a prompt is persisted.
 *
 * Not a round number: `prompt-caching.test.ts` establishes that every debate
 * request sits under Anthropic's 4,096-token caching minimum (~16 KB), and the
 * measured average over a week of paper trading is ~6.8 KB. So this cap is
 * non-binding on the shape the system actually produces and fires only on a
 * pathological prompt — which is the case where a bound is worth having.
 */
const MAX_CAPTURED_PROMPT_CHARS = 16_384;

/**
 * How much of a response is persisted.
 *
 * Sized off `max_tokens: 1024` (`orchestrator/production/defaults.ts`) at ~4
 * chars per token, so it is non-binding on any response the model is permitted
 * to produce. If `max_tokens` is ever raised, raise this with it.
 */
const MAX_CAPTURED_RESPONSE_CHARS = 4_096;

export interface LlmSpendSink {
  record(entry: LlmSpendRecord): void;
}

/**
 * The default. Not a no-op for convenience — it is what makes metering opt-in,
 * so `AnthropicLlmClient` keeps working unchanged in the many tests and the
 * backtest path that have no shared store.
 */
export const NULL_SPEND_SINK: LlmSpendSink = { record: () => {} };

/** Appends to `llm_spend`, pricing the usage on the way in */
export class SqliteLlmSpendStore implements LlmSpendSink {
  constructor(
    private readonly db: StoreHandle,
    private readonly logger?: Logger,
    /**
     * Whether the prompt and response text are persisted to `llm_call_log`
     * and put on the log line (#1035).
     *
     * A constructor argument defaulting to `false`, with the environment read
     * at the composition root — the same split `buildEntrypointLogger` makes
     * for the file sink, and for the same reason: the deployment decision
     * belongs on the shipped entrypoint's path, and the many test and backtest
     * constructions of this class must not start writing text because an
     * ambient variable happened to be set.
     */
    private readonly captureText = false,
    /**
     * Where a prompt-tier crossing is escalated (#1155). Absent = no
     * alerting: `crossesPromptTier` is still consulted (see
     * `maybeAlertPromptTierCrossing`) so the throttle's state stays correct
     * across a run that later injects a channel, but nothing is posted.
     */
    private readonly promptTierAlerts?: PromptTierAlertChannel,
    /**
     * Defaults to a fresh instance so existing constructions (tests,
     * backtest) keep working unchanged.
     *
     * MUST be the SAME instance across every store that can meter the same
     * model, or the throttle's one-then-every-8 contract silently splits
     * into two independent counters — `production.ts` constructs this class
     * twice (debate stage, sentiment `GrokAgent`) and both can end up
     * metering a tiered model, so it hoists one instance and passes it to
     * both.
     */
    private readonly promptTierThrottle = new PromptTierCrossingThrottle(),
  ) {}

  record(entry: LlmSpendRecord): void {
    try {
      const { cost, toolCalls } = this.priceCall(entry);
      const spendRow = this.insertSpendRow(entry, cost, toolCalls);

      // Reached only once the spend row has landed, so `spend_id` is always a
      // real rowid. It gets its OWN catch rather than falling into the outer
      // one: the outer message says the call is missing from the dashboard
      // spend total, which would be false here — the spend row is written and
      // safe, and only the text was lost. A capture failure reported as a
      // metering failure would send an operator to look at the wrong thing
      this.tryRecordText(entry, Number(spendRow.lastInsertRowid));

      // Its OWN catch, for the same reason `recordText`'s is separate: the
      // spend row is already written and safe by this point, so a channel
      // that throws must not turn into an `llm_spend_write_failed` line that
      // falsely claims the row is missing
      this.tryAlertPromptTierCrossing(entry);
    } catch (error) {
      // See the module doc comment: a metering failure must not surface as a
      // failed LLM call. Logged rather than silent so a persistently broken
      // meter is visible instead of just producing a flat spend line
      this.logger?.log({
        trace_id: entry.trace_id,
        stage: 'orchestrator',
        event: 'llm_spend_write_failed',
        level: 'warn',
        message:
          'llm spend metering write failed — the API call itself succeeded and is unaffected, ' +
          'but this call is missing from the dashboard spend total',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Prices one call's token and server-tool-call cost, warning when the
   * token half is unpriced. Split out of `record` purely for cyclomatic
   * complexity — same computation, same order, same logging.
   */
  private priceCall(entry: LlmSpendRecord): { cost: number | null; toolCalls: number } {
    // Priced at WRITE time, not read time, so the row keeps the rate that
    // was in force when the call happened. Pricing at read time would make
    // every historical row silently reprice the next time the table in
    // pricing.ts is edited, quietly rewriting spend history that an
    // operator may have already looked at
    const tokenCost = priceUsage(entry.model, entry.usage);
    const toolCalls = entry.server_tool_calls ?? 0;
    const toolCost = priceServerToolCalls(toolCalls);

    // The two halves are priced independently, and the tool half is recorded
    // EVEN WHEN THE TOKEN HALF IS NOT (#476): discarding a charge we know
    // exactly because a different one is missing would under-count the cap,
    // which is worse than a partial number. Such a row stays recognisable:
    // `server_tool_calls` is non-zero while `cost_usd` is too small to cover
    // the tokens
    const cost = tokenCost === null ? (toolCost > 0 ? toolCost : null) : tokenCost + toolCost;

    if (tokenCost === null) {
      // A silent null here is how a spend cap stops being a cap
      this.logger?.log({
        trace_id: entry.trace_id,
        stage: 'orchestrator',
        event: 'llm_model_unpriced',
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

    return { cost, toolCalls };
  }

  private insertSpendRow(entry: LlmSpendRecord, cost: number | null, toolCalls: number) {
    return this.db
      .prepare(
        `INSERT INTO llm_spend (
           trace_id, stage, debate_id, model,
           input_tokens, output_tokens,
           cache_creation_input_tokens, cache_read_input_tokens,
           cost_usd, server_tool_calls, latency_ms, ttfb_ms, timestamp,
           prompt_template_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.trace_id,
        entry.stage,
        // `?? null`, not the raw `undefined`: better-sqlite3 refuses to bind
        // `undefined` ("Invalid value"), so an unattributed call would throw
        // into the swallowing catch below and lose the row entirely — a
        // metering bug that would look exactly like a quiet dashboard
        entry.debate_id ?? null,
        entry.model,
        entry.usage.input_tokens,
        entry.usage.output_tokens,
        entry.usage.cache_creation_input_tokens ?? 0,
        entry.usage.cache_read_input_tokens ?? 0,
        cost,
        toolCalls,
        entry.latency_ms,
        entry.ttfb_ms ?? null,
        toStoredTimestamp(entry.timestamp),
        entry.prompt_template_hash ?? null,
      );
  }

  private tryRecordText(entry: LlmSpendRecord, spendId: number): void {
    try {
      this.recordText(entry, spendId);
    } catch (error) {
      this.logger?.log({
        trace_id: entry.trace_id,
        stage: 'orchestrator',
        event: 'llm_call_capture_failed',
        level: 'warn',
        message:
          'llm call text capture failed — the API call and its spend row are unaffected, ' +
          'but this call has no prompt/response recorded in llm_call_log',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private tryAlertPromptTierCrossing(entry: LlmSpendRecord): void {
    try {
      this.maybeAlertPromptTierCrossing(entry);
    } catch (error) {
      this.logger?.log({
        trace_id: entry.trace_id,
        stage: 'orchestrator',
        event: 'llm_prompt_tier_alert_failed',
        level: 'error',
        message:
          'prompt-tier crossing alert failed — the API call and its spend row are ' +
          'unaffected, but a large-prompt-tier cost step is unreported',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Called on every metered call (#1155), whether or not it crosses, so
   * `promptTierThrottle` sees every call THIS INSTANCE meters and a call
   * back under the tier correctly clears it. "This instance", not "the run"
   * — the throttle only sees the whole run's crossings for a model when
   * every store that can meter that model shares one throttle instance.
   *
   * `crossesPromptTier` already refuses a model with no tier row, so
   * `rateFor(entry.model)?.tier` is guaranteed defined once `crossed` is
   * true — the `undefined` branch below guards only against the two
   * functions disagreeing in a future edit.
   */
  private maybeAlertPromptTierCrossing(entry: LlmSpendRecord): void {
    const crossed = crossesPromptTier(entry.model, entry.usage);
    const { alert, consecutive } = this.promptTierThrottle.observe(entry.model, crossed);
    if (!alert) return;

    const aboveTokens = rateFor(entry.model)?.tier?.above_prompt_tokens;
    if (aboveTokens === undefined) return;

    this.promptTierAlerts?.postPromptTierAlert({
      model: entry.model,
      trace_id: entry.trace_id,
      stage: entry.stage,
      debate_id: entry.debate_id,
      prompt_tokens: promptTokensOf(entry.usage),
      above_prompt_tokens: aboveTokens,
      consecutive_crossings: consecutive,
      reported_at: entry.timestamp,
    });
  }

  /**
   * Persists the call's text and emits the one log line for this call
   * (#1035).
   *
   * `started_at`/`duration_ms` are set from the call's own timestamp and
   * latency rather than measured here, so the line agrees exactly with the
   * `llm_spend` row beside it and with the `LlmResponse` the caller received —
   * the same "measured once, passed in" rule `anthropic-client.ts` applies to
   * `latency_ms`.
   *
   * Masked and capped HERE rather than at the call site so every writer
   * inherits one bound and one pattern list. The masking is `maskCredentials`,
   * whose narrowness is a deliberate property of that module and not a
   * guarantee about this data: a prompt embeds news bodies and analyst free
   * text, so a credential pasted into ingested content in a shape the patterns
   * do not match WILL be persisted. This is a capture, not a scrub.
   */
  private recordText(entry: LlmSpendRecord, spendId: number): void {
    if (!this.captureText) return;
    if (entry.prompt === undefined && entry.response === undefined) return;

    const prompt =
      entry.prompt === undefined ? null : maskAndCap(entry.prompt, MAX_CAPTURED_PROMPT_CHARS);
    const response =
      entry.response === undefined ? null : maskAndCap(entry.response, MAX_CAPTURED_RESPONSE_CHARS);

    this.db
      .prepare(
        `INSERT INTO llm_call_log (
           spend_id, trace_id, stage, debate_id, model, prompt, response, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        // Never null in practice: the caller only reaches here after the spend
        // INSERT returned a rowid. The column stays nullable so a future
        // writer that captures text without metering has somewhere to go
        spendId,
        entry.trace_id,
        entry.stage,
        entry.debate_id ?? null,
        entry.model,
        prompt,
        response,
        toStoredTimestamp(entry.timestamp),
      );

    this.logger?.log({
      trace_id: entry.trace_id,
      stage: entry.stage,
      level: 'info',
      message: `llm call: ${entry.model}`,
      payload: {
        debate_id: entry.debate_id,
        model: entry.model,
        input_tokens: entry.usage.input_tokens,
        output_tokens: entry.usage.output_tokens,
        cache_creation_input_tokens: entry.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: entry.usage.cache_read_input_tokens ?? 0,
        cost_usd: priceUsage(entry.model, entry.usage),
        latency_ms: entry.latency_ms,
        ttfb_ms: entry.ttfb_ms,
        prompt,
        response,
      },
      started_at: entry.timestamp.toISOString(),
      duration_ms: entry.latency_ms,
    });
  }
}
