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
