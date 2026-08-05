/**
 * `LlmClient` — the abstraction layer between debate logic (mediator
 * synthesis, semantic disagreement detection) and a specific LLM provider
 * (ticket #31, debate-engine-spec.md "LLM Selection & Prompt Engineering":
 * "This spec assumes LLMs... implementation details out of scope for this
 * spec" — this file is that implementation detail).
 *
 * The response shape is caller-defined (`parseResponse`) rather than fixed,
 * because #26 (personas) and #32 (disagreement detection) each need their
 * own structured output — this layer owns provider mechanics (calling out,
 * retrying, classifying failures), not prompt-specific schemas.
 */
import type { RetryConfig } from '../../shared/index.js';
import type { AnalystView } from '../types.js';

/**
 * Context threaded alongside the prompt (issue #31: "prompt + context
 * (analyst views, debate state)"). `debate_state` is intentionally loose —
 * the Debate Engine's round/persona state shape isn't defined yet (#26/#34
 * are unimplemented) and this layer doesn't need to interpret it, only pass
 * it through to whatever renders the prompt.
 */
export interface LlmRequestContext {
  analyst_views: AnalystView[];
  debate_state?: Record<string, unknown>;
  /**
   * Attribution for the local spend meter (llm/spend-sink.ts) — which tick and
   * which stage this call should be billed against on the dashboard.
   *
   * Declared by #367 for exactly this moment ("so that wiring attribution is a
   * one-line change at each call site instead of a second migration"); #326
   * supplies them. Still optional: `LlmRequest` is constructed by inline test
   * doubles all over this suite, and the meter records `'unattributed'` when
   * they are absent rather than refusing the call.
   *
   * NOT SENT TO THE MODEL. `AnthropicLlmClient.renderMessageContent`
   * serializes `context` into the prompt, so these three fields are stripped
   * there — a trace id and a content hash are meter bookkeeping, not prompt
   * content, and putting them on the wire would be a cost ticket that costs
   * tokens.
   */
  trace_id?: string | undefined;
  stage?: string | undefined;
  /**
   * The debate this call belongs to (#326) — the join key to
   * `debate_log.debate_id`. See migrations/0012 for why this, rather than
   * `trace_id` + `stage`, is what attributes a call to a decision.
   */
  debate_id?: string | undefined;
}

/**
 * `parseResponse` validates and narrows the provider's raw text into the
 * caller's expected shape `T`, mirroring the `{valid, ...} | {valid: false,
 * reason}` discriminated-union pattern used by
 * `analyst-response-collector.ts`'s `validateAnalystView`. A `valid: false`
 * result becomes an `LlmMalformedResponseError` — the caller decides what
 * "malformed" means for its own schema, this layer just enforces it.
 */
export interface LlmRequest<T> {
  prompt: string;
  context: LlmRequestContext;
  parseResponse: (rawText: string) => { valid: true; data: T } | { valid: false; reason: string };
  /**
   * Cancels this call (#347). When it aborts, an implementation that supports
   * cancellation must stop the in-flight request and reject with
   * `LlmCancelledError` — not merely stop waiting, which is what
   * `Promise.race` alone does and which keeps paying for the answer.
   *
   * OPTIONAL, and on the request rather than as a second `complete` parameter,
   * deliberately. `LlmClient` has three implementations in-repo
   * (`AnthropicLlmClient`, `MockLlmClient`, `ConstantResponseLlmClient`) plus
   * inline test doubles; a required field would break every construction site
   * of `LlmRequest` in the suite for a capability only the HTTP client can
   * actually honour. An implementation that ignores the signal is degraded
   * (it finishes a call nobody reads) but not incorrect — the caller's
   * `AbortSignal` still terminates the caller, and the round loop still
   * refuses to issue the NEXT call (round-orchestrator.ts), so an unaware
   * client costs at most the one request already in flight.
   *
   * Not part of `context`: `AnthropicLlmClient` serializes `context` into the
   * prompt, and an `AbortSignal` is transport state, not prompt content.
   */
  signal?: AbortSignal | undefined;
}

export interface LlmResponse<T> {
  data: T;
  raw_text: string;
  latency_ms: number;
}

export interface LlmClient {
  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>>;
}

/**
 * Retry knobs (issue #31 AC: "Retry logic with exponential backoff
 * (configurable)"). Structurally identical to the generalized
 * `src/shared/http/retry.ts`'s `RetryConfig` (issue #271) — aliased rather
 * than duplicated so the two can't drift, while keeping this name as the
 * public export `debate-engine/index.ts` already carries.
 */
export type LlmRetryConfig = RetryConfig;
