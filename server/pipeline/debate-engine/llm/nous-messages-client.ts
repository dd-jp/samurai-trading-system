/**
 * The debate engine's wire client, against Nous.
 *
 * Replaces `AnthropicHttpMessagesClient` (#274) as part of the single-provider
 * cutover — see docs/adr/0009-single-provider-nous.md. It satisfies the same
 * `AnthropicMessagesClient` interface, which is why nothing above it changes:
 * `AnthropicLlmClient`'s retry policy, timeout race, `AbortSignal`
 * cancellation, prompt-safety wrapping, error classification and spend
 * metering are all provider-neutral, and that interface is documented as
 * deliberately structural precisely so a non-SDK wire client can satisfy it.
 *
 * NAMING: `AnthropicMessagesClient`, `AnthropicLlmClient` and `AnthropicUsage`
 * now name a provider this system no longer talks to. The rename is mechanical
 * but touches ~15 test files, and folding it into the cutover diff would bury
 * the two silent-failure paths that diff exists to close (unpriced models, and
 * truncation retries). Left as a follow-up.
 *
 * The request shape needs no translation: `AnthropicMessageRequest.messages`
 * is already `Array<{ role: 'user'; content: string }>`, which is what an
 * OpenAI-compatible endpoint expects. Only the response is remapped, into the
 * `content` block array `extractText` and `recordSpend` already read.
 */

import type { LlmInFlightGate, NousChatResult } from '../../../shared/llm/index.js';
import {
  LlmInFlightRefusedError,
  NousRefusalError,
  NousTruncatedError,
  nousChat,
} from '../../../shared/llm/index.js';
import type {
  AnthropicMessageOptions,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './anthropic-client.js';
import { LlmAdmissionRefusedError, LlmRefusalError, LlmTruncatedError } from './errors.js';

export interface NousMessagesClientOptions {
  apiKey: string;
  baseUrl: string;
  /**
   * Network backstop. Defaults to `nousChat`'s own, deliberately WIDER than
   * `DEFAULT_LLM_CLIENT_CONFIG.timeoutMs`: that value governs the outer
   * race in `AnthropicLlmClient.callWithTimeout`, whose timer starts before
   * `createMessage` is even called, so it is the one that actually decides a
   * slow call's `LlmTimeoutError`. Two timers on an identical deadline would
   * only be ambiguous about which won.
   *
   * Named rather than quoted as a number: this comment said "(30s)" until
   * #1080 moved the shipped value to 28s, and a literal restated here is a
   * second source of truth that goes stale silently.
   */
  timeoutMs?: number;
  /**
   * The account-wide in-flight cap (#1080). Required, so that a construction
   * site cannot silently uncap the account — see `in-flight-gate.ts`.
   */
  gate: LlmInFlightGate;
  /**
   * The caller's per-call deadline, in milliseconds, as the GATE should
   * understand it: the whole budget a call has, queue wait included.
   *
   * Set from `AnthropicLlmClientConfig.timeoutMs` at the composition root, not
   * from `timeoutMs` above — this client's `timeoutMs` is the wider network
   * backstop, while the timer that actually decides a slow call's
   * `LlmTimeoutError` is `AnthropicLlmClient.callWithTimeout`'s, whose clock
   * starts before `createMessage` is called and therefore spans the gate wait
   * too. Omitted means "queue without a deadline", which disables the
   * admission check for this client.
   */
  gateBudgetMs?: number | undefined;
}

export class NousMessagesClient implements AnthropicMessagesClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number | undefined;
  readonly #gate: LlmInFlightGate;
  readonly #gateBudgetMs: number | undefined;

  constructor(options: NousMessagesClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs;
    this.#gate = options.gate;
    this.#gateBudgetMs = options.gateBudgetMs;
  }

  /**
   * `options.signal` is the cancellation seam the debate's latency budget
   * reaches through — handed down to `fetchWithTimeout`, which composes it
   * with its own timeout via `AbortSignal.any` so the real socket closes when
   * the caller cancels. This is the layer at which "aborted, not merely
   * ignored" is true; every layer above only forwards it.
   */
  async createMessage(
    request: AnthropicMessageRequest,
    options: AnthropicMessageOptions = {},
  ): Promise<AnthropicMessageResponse> {
    let result: NousChatResult;
    try {
      result = await nousChat(
        {
          apiKey: this.#apiKey,
          baseUrl: this.#baseUrl,
          ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
          signal: options.signal,
          gate: this.#gate,
          gateBudgetMs: this.#gateBudgetMs,
          // Per-call (#1533): the caller's `options.stage` names risk-critic
          // and MI-scoring calls correctly on the gate's log lines instead of
          // every call reading `'debate'`. `'debate'` remains the default for
          // callers that pass no options at all (test doubles, programmatic
          // callers), matching this client's pre-#1533 behaviour
          llmStage: options.stage ?? 'debate',
        },
        {
          model: request.model,
          messages: request.messages,
          max_tokens: request.max_tokens,
        },
      );
    } catch (error) {
      // This adapter is the seam where a Nous-shaped failure becomes the typed
      // LLM hierarchy, which is what keeps `anthropic-client.ts` free of any
      // provider's error classes. A refusal is translated here rather than left
      // to `classifyProviderError`, which duck-types on `.status` alone: it
      // would land on `LlmProviderError` — non-retryable either way, but
      // indistinguishable in the log from a dead API key, and with the burned
      // call's tokens discarded (#1391)
      if (error instanceof NousRefusalError) {
        throw new LlmRefusalError(error.message, error.signal, error.usage);
      }
      // Translated here for the same reason (#1394): left to
      // `classifyProviderError` a truncation lands on `LlmProviderError`,
      // where it is indistinguishable from a dead API key and its
      // `max_tokens`/`usage` are discarded. Not retried either way — see
      // `LlmTruncatedError`
      if (error instanceof NousTruncatedError) {
        throw new LlmTruncatedError(error.message, error.model, error.max_tokens, error.usage);
      }
      // #1080, same reason as the two above: left to `classifyProviderError`
      // an in-flight refusal lands on `LlmProviderError` and is counted as
      // `transport` — indistinguishable in the log from a dead gateway, which
      // is exactly the distinction the gate was built to make measurable. No
      // call was sent, so there are no tokens and no usage to carry
      if (error instanceof LlmInFlightRefusedError) {
        throw new LlmAdmissionRefusedError(error);
      }
      throw error;
    }

    return {
      content: [{ type: 'text', text: result.text }],
      usage: result.usage,
      // `nousChat` has already decided which id is safe to meter against — the
      // provider's echo only when this system can price it, otherwise the id
      // that was requested. `AnthropicLlmClient.recordSpend` prefers this field
      // over its configured model, so an unpriceable echo landing here would
      // record an unpriced row, and an unpriced row does not count against the
      // spend cap
      model: result.model,
      // #1012: threaded straight through — `nousChat` is the only place that
      // measures it (see its `ttfb_ms` doc comment)
      ttfb_ms: result.ttfb_ms,
    };
  }
}
