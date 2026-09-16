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
import type { RetryConfig } from '../../../shared/index.js';
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
   * Meter bookkeeping. NOT SENT TO THE MODEL — see `LlmAttribution`.
   *
   * A NESTED ENVELOPE rather than sibling `trace_id`/`stage`/`debate_id`
   * fields (PR #387 review). Those were stripped from the prompt by a
   * hand-maintained denylist inside `renderMessageContent`, which is the
   * failure shape this repo keeps producing: a rule expressed as a list of
   * names that nothing enforces. It had two live bugs waiting in it — the next
   * attribution field added here would have silently shipped to the model and
   * billed input tokens on every call (in a ticket whose whole purpose is
   * controlling spend), and a legitimate prompt field that happened to be
   * named `stage` would have been silently dropped before the model saw it.
   *
   * With one envelope, the split is structural: everything inside is meter
   * data and is excluded by construction, everything outside is prompt
   * content. Adding an attribution field needs no change anywhere else, and
   * `stage` is free to mean whatever a future prompt needs it to mean.
   */
  attribution?: LlmAttribution;
}

/**
 * Attribution for the local spend meter (llm/spend-sink.ts) — which tick,
 * which stage, and which debate a call should be billed against on the
 * dashboard.
 *
 * Declared by #367 for exactly this moment ("so that wiring attribution is a
 * one-line change at each call site instead of a second migration"); #326
 * supplies it. Every field stays optional: `LlmRequest` is constructed by
 * inline test doubles all over this suite, and the meter records
 * `'unattributed'` when they are absent rather than refusing the call.
 *
 * NOTHING IN HERE REACHES THE PROVIDER. `AnthropicLlmClient` serializes
 * `context` into the prompt, and this envelope is excluded from that — a trace
 * id and a content hash are bookkeeping, not prompt content, and putting them
 * on the wire would make a cost ticket cost tokens.
 */
interface LlmAttribution {
  trace_id?: string | undefined;
  stage?: string | undefined;
  /**
   * The debate this call belongs to (#326) — the join key to
   * `debate_log.debate_id`. See migrations/0012 for why this, rather than
   * `trace_id` + `stage`, is what attributes a call to a decision.
   */
  debate_id?: string | undefined;
  /**
   * `hashPromptTemplate(...)` (#1514, shared/llm/prompt-template-hash.ts) of
   * the STATIC prompt template this call site sends — not the rendered
   * prompt, which also carries per-request dynamic content (analyst views,
   * book context) and would make the hash different on every call. Rides
   * this envelope so a prompt edit is visible in `llm_spend` alongside
   * `model` the same way a model swap already is.
   */
  prompt_template_hash?: string | undefined;
  /**
   * Overrides the in-flight gate's `llmStage` (#1533) — its own naming for
   * `llm_gate_wait`/`llm_gate_refused` log lines, independent of `stage`
   * above. Falls back to `stage` when absent (`anthropic-client.ts`), which
   * is why most call sites (personas, disagreement-detector, critic) need no
   * change: their `stage` already names the gate correctly. `item-scorer.ts`
   * is the one caller that needs the two to diverge — its `stage` stays
   * `'market_intelligence'` for the load-bearing ADR-0008 spend-cap grouping
   * while `gate_stage` names the finer `'market_intelligence_scoring'` the
   * gate log wants. NEVER reaches `llm_spend` or the model prompt — same
   * exclusion as every other field in this envelope.
   */
  gate_stage?: string | undefined;
}

/**
 * Which side of the prompt/meter line each `LlmRequestContext` field falls on,
 * and the SINGLE SOURCE OF TRUTH for that split (PR #387 review).
 *
 * THIS IS THE COMPILER ENFORCEMENT, not documentation. `Record<keyof
 * LlmRequestContext, ...>` requires EVERY key of the interface to appear here,
 * so adding a field to `LlmRequestContext` without deciding whether the model
 * should see it FAILS TO COMPILE. It is not possible to extend the context and
 * forget — which is precisely what the previous denylist allowed.
 *
 * `AnthropicLlmClient` builds its prompt context by reading this map rather
 * than by naming fields, so the classification is load-bearing at runtime and
 * cannot rot into a stale comment. Deliberately declared in this
 * (non-test) module: `tsconfig.build.json` excludes test files from `npm run build`, so
 * a guard living in a `.test.ts` would not be typechecked by the build at all
 * and the enforcement would be imaginary.
 */
export const LLM_CONTEXT_FIELD_KIND = {
  analyst_views: 'prompt',
  debate_state: 'prompt',
  attribution: 'meter',
} satisfies Record<keyof LlmRequestContext, 'prompt' | 'meter'>;

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
 * `server/shared/http/retry.ts`'s `RetryConfig` (issue #271) — aliased rather
 * than duplicated so the two can't drift, while keeping this name as the
 * public export `debate-engine/index.ts` already carries.
 */
export type LlmRetryConfig = RetryConfig;
