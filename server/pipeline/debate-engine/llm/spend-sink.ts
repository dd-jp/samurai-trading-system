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

export interface LlmSpendRecord {
  trace_id: string;
  stage: string;
  debate_id?: string | undefined;
  model: string;
  usage: AnthropicUsage;
  server_tool_calls?: number | undefined;
  latency_ms: number;
  ttfb_ms?: number | undefined;
  timestamp: Date;
  prompt?: string | undefined;
  response?: string | undefined;
  prompt_template_hash?: string | undefined;
}

export const MAX_CAPTURED_PROMPT_CHARS = 16_384;

export const MAX_CAPTURED_RESPONSE_CHARS = 4_096;

export interface LlmSpendSink {
  record(entry: LlmSpendRecord): void;
}

export const NULL_SPEND_SINK: LlmSpendSink = { record: () => {} };

export class SqliteLlmSpendStore implements LlmSpendSink {
  constructor(
    private readonly db: StoreHandle,
    private readonly logger?: Logger,
    private readonly captureText = false,
    private readonly promptTierAlerts?: PromptTierAlertChannel,
    private readonly promptTierThrottle = new PromptTierCrossingThrottle(),
  ) {}

  record(entry: LlmSpendRecord): void {
    try {
      const { cost, toolCalls } = this.priceCall(entry);
      const spendRow = this.insertSpendRow(entry, cost, toolCalls);

      this.tryRecordText(entry, Number(spendRow.lastInsertRowid));

      this.tryAlertPromptTierCrossing(entry);
    } catch (error) {
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

  private priceCall(entry: LlmSpendRecord): { cost: number | null; toolCalls: number } {
    const tokenCost = priceUsage(entry.model, entry.usage);
    const toolCalls = entry.server_tool_calls ?? 0;
    const toolCost = priceServerToolCalls(toolCalls);

    const cost = tokenCost === null ? (toolCost > 0 ? toolCost : null) : tokenCost + toolCost;

    if (tokenCost === null) {
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
