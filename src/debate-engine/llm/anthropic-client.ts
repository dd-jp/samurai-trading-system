/**
 * Concrete `LlmClient` (ticket #31 AC: "Concrete implementation using
 * configured LLM provider"). The wire client is injected rather than
 * constructed here, mirroring `AlpacaClient`/`CcxtBrokerClient` — connection
 * provisioning (API key, base URL) is an ops concern, and `AnthropicMessagesClient`
 * is deliberately the narrow slice of the Anthropic Messages API this file
 * uses, so any real SDK client (or a test double) satisfies it structurally
 * without a hard dependency on a specific SDK package.
 */

import { withRetry } from '../../shared/index.js';
import {
  LlmCancelledError,
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmTimeoutError,
} from './errors.js';
import type { AnthropicUsage } from './pricing.js';
import { wrapUntrusted } from './prompt-safety.js';
import { type LlmSpendSink, NULL_SPEND_SINK } from './spend-sink.js';
import type { LlmClient, LlmRequest, LlmResponse, LlmRetryConfig } from './types.js';

/**
 * Only failure modes the spec calls out as transient are retried (timeout,
 * rate limit, malformed response — a fresh sample may parse cleanly).
 * Anything else (auth errors, bad requests, unclassified `LlmProviderError`s)
 * is assumed non-transient and rethrown immediately. Closed over the
 * generalized `withRetry` (issue #271) — this predicate, and the LLM
 * client's retry behavior, are unchanged from before that generalization.
 */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError
  );
}

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}

/** The subset of the Messages API response this client reads (text content blocks). */
export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  /**
   * Token counts, fed to the local spend meter (llm/spend-sink.ts). Optional
   * because `AnthropicMessagesClient` is a structural interface any wire
   * client may satisfy — the many test doubles in this suite return `content`
   * alone, and requiring `usage` would break every one of them for a field
   * nothing trading-critical reads.
   *
   * The real API always sends it; `AnthropicHttpMessagesClient` casts the
   * whole body through, so it arrives at runtime without extra parsing.
   */
  usage?: AnthropicUsage;
  /**
   * The model that actually served the request, which is not always the model
   * requested — a server-side fallback can reroute a refused request to a
   * different (differently priced) model. Preferred over `config.model` when
   * pricing, so the meter bills what ran rather than what was asked for.
   */
  model?: string;
}

/**
 * Per-call transport options (#347). Separate from `AnthropicMessageRequest`,
 * which is the wire body — a signal is not something to serialize and send.
 */
export interface AnthropicMessageOptions {
  /** Aborts the underlying request. Wire clients that can honour it should. */
  signal?: AbortSignal | undefined;
}

export interface AnthropicMessagesClient {
  /**
   * `options` is a second, OPTIONAL parameter rather than a field on the
   * request body: TypeScript lets an implementation declare fewer parameters
   * than the interface, so every existing wire double in this suite
   * (`createMessage(request)`) still satisfies this interface unchanged. That
   * matters because `AnthropicMessagesClient` is deliberately structural — any
   * SDK client or fake can satisfy it — and a required parameter would have
   * broken all of them for a capability only the real HTTP client can honour.
   */
  createMessage(
    request: AnthropicMessageRequest,
    options?: AnthropicMessageOptions,
  ): Promise<AnthropicMessageResponse>;
}

export interface AnthropicLlmClientConfig {
  model: string;
  max_tokens: number;
  /** Per-attempt timeout; exceeding this raises `LlmTimeoutError` and may be retried. */
  timeoutMs: number;
  retry: LlmRetryConfig;
}

/**
 * `request.context.analyst_views` (and any `debate_state`) carries the same
 * ingested free text (`key_points`, persona rationale) as `request.prompt` —
 * some callers (e.g. `disagreement-detector.ts`) rely on it entirely rather
 * than interpolating free text into the prompt string. Wrapping it here
 * (#208, prompt-safety.ts) is what makes the mitigation hold on the actual
 * wire content sent to the provider, not just on `personas.ts`'s `prompt`.
 */
function renderMessageContent<T>(request: LlmRequest<T>): string {
  // Attribution (#326) is meter bookkeeping, not prompt content. Stripped
  // before serialization so threading a trace id and a debate hash through
  // `context` neither costs input tokens on every call nor feeds the model
  // opaque identifiers it has no use for.
  const {
    trace_id: _trace_id,
    stage: _stage,
    debate_id: _debate_id,
    ...promptContext
  } = request.context;
  const contextJson = JSON.stringify(promptContext, null, 2);
  return `${request.prompt}\n\nContext:\n${wrapUntrusted(contextJson)}`;
}

function extractText(response: AnthropicMessageResponse): string {
  return response.content
    .filter(
      (block): block is { type: string; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

/**
 * Duck-types the injected client's thrown errors into the typed hierarchy
 * (errors.ts) via the Anthropic SDK's conventional `status` field, rather
 * than importing the SDK's own error classes — keeping `AnthropicMessagesClient`
 * a structural interface any provider client can satisfy.
 */
function classifyProviderError(error: unknown): Error {
  if (
    error instanceof LlmTimeoutError ||
    error instanceof LlmRateLimitError ||
    error instanceof LlmMalformedResponseError ||
    error instanceof LlmProviderError
  ) {
    return error;
  }

  const status =
    typeof error === 'object' && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    return new LlmRateLimitError(message);
  }
  if (status === 408 || status === 504) {
    return new LlmTimeoutError(message);
  }
  return new LlmProviderError(message);
}

export class AnthropicLlmClient implements LlmClient {
  constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly config: AnthropicLlmClientConfig,
    /**
     * Where token usage is metered. Defaults to `NULL_SPEND_SINK` so every
     * existing construction site — tests, backtests, anything without a shared
     * store — keeps working unchanged and simply meters nothing.
     */
    private readonly spendSink: LlmSpendSink = NULL_SPEND_SINK,
  ) {}

  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    // Checked before the retry loop, not inside it: a request whose signal is
    // already aborted must cost nothing at all. This is the guard that makes
    // "no further LLM calls after the budget fires" (#347) hold even for a
    // call the round loop had already begun to dispatch.
    if (request.signal?.aborted === true) {
      return Promise.reject(
        new LlmCancelledError('LLM call cancelled before dispatch: caller signal already aborted'),
      );
    }
    return withRetry(() => this.attempt(request), this.config.retry, isRetryable);
  }

  private async attempt<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const start = Date.now();
    const response = await this.callWithTimeout(renderMessageContent(request), request.signal);
    const latency_ms = Date.now() - start;

    // Metered BEFORE the parse gate below, because a malformed response was
    // still generated and still billed. Recording only well-formed responses
    // would make the meter understate spend by exactly the calls most likely
    // to be retried — i.e. it would be most wrong when it matters most.
    this.recordSpend(request, response, latency_ms);

    const rawText = extractText(response);
    const parsed = request.parseResponse(rawText);
    if (!parsed.valid) {
      throw new LlmMalformedResponseError(parsed.reason);
    }

    return { data: parsed.data, raw_text: rawText, latency_ms };
  }

  /**
   * Note what is NOT metered: a call that times out or throws never reaches
   * here, so its tokens are missing from the total even though the provider
   * may have generated (and billed) them. There is no usage block to read on a
   * failed call — the information does not exist client-side — so this is a
   * known floor on the figure, not an oversight. Retries are each counted
   * separately, which is correct: each attempt is separately billed.
   *
   * `latency_ms` (#326) is the SAME number returned to the caller on
   * `LlmResponse` — measured once, around `callWithTimeout`, and passed in
   * rather than re-measured here, so the persisted figure and the logged one
   * can never disagree. It is recorded even for a response that goes on to
   * fail the parse gate below, for the same reason the tokens are: the call
   * took that long and cost that much whether or not the answer was usable.
   */
  private recordSpend<T>(
    request: LlmRequest<T>,
    response: AnthropicMessageResponse,
    latency_ms: number,
  ): void {
    if (response.usage === undefined) return;
    try {
      this.spendSink.record({
        trace_id: request.context.trace_id ?? 'unattributed',
        stage: request.context.stage ?? 'debate',
        debate_id: request.context.debate_id,
        model: response.model ?? this.config.model,
        usage: response.usage,
        latency_ms,
        timestamp: new Date(),
      });
    } catch {
      // The sink contract says `record` must not throw, and the SQLite
      // implementation honours it — but `LlmSpendSink` is a public interface
      // any caller may implement, so trusting that contract per-implementation
      // leaves the guarantee one bad sink away from failing a trading call.
      // Enforced here, at the boundary, where it actually holds.
      //
      // Silent by necessity: this class has no logger, and adding one to carry
      // a metering failure would widen a hot constructor for a message the
      // SQLite sink already logs for itself. The observable symptom — a spend
      // total that stops rising — is on the dashboard either way.
    }
  }

  /**
   * Races the wire call against `config.timeoutMs` — and, since #347, CANCELS
   * the loser instead of abandoning it. Three things changed here, all of them
   * live on the production path (this timeout fires on every slow call, not
   * only on a timed-out debate):
   *
   *  - The per-call timeout now aborts its own in-flight request. Before, a
   *    timed-out call kept running and was RETRIED underneath itself
   *    (`LlmTimeoutError` is retryable), so one slow call could hold two or
   *    three concurrent requests open against the provider's rate limit and
   *    bill for all of them while at most one answer was ever read.
   *  - `callerSignal` (the debate's latency budget) is combined with that
   *    timeout via `AbortSignal.any`, so either can cancel the request.
   *  - The timer is cleared once the race settles. It used to leak one
   *    unfired timer per LLM call, forever — a real leak at soak scale.
   */
  private async callWithTimeout(
    content: string,
    callerSignal?: AbortSignal,
  ): Promise<AnthropicMessageResponse> {
    const timeoutController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const expired = new LlmTimeoutError(`LLM call exceeded ${this.config.timeoutMs}ms`);
        // Abort first, reject second: the point of the ticket is that the
        // request stops, not merely that the caller stops waiting. The same
        // error object is the abort reason, so a wire client that surfaces
        // `signal.reason` and this race report the identical failure.
        timeoutController.abort(expired);
        reject(expired);
      }, this.config.timeoutMs);
    });

    const signal =
      callerSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([callerSignal, timeoutController.signal]);

    const call = this.client
      .createMessage(
        {
          model: this.config.model,
          max_tokens: this.config.max_tokens,
          messages: [{ role: 'user', content }],
        },
        { signal },
      )
      .catch((error) => {
        throw classifyProviderError(error);
      });

    // No `call.catch(() => {})` guard here, deliberately: the losing side now
    // REJECTS (aborted) instead of hanging, but `Promise.race` attaches its
    // own handlers to `call`, so that late rejection is handled-and-ignored,
    // not unhandled. Same finding as `latency-budget.ts` — see the note there.
    try {
      return await Promise.race([call, timeout]);
    } catch (error) {
      // A caller-initiated abort surfaces from `fetch` as a generic
      // `AbortError`, which `classifyProviderError` can only call an
      // `LlmProviderError` — i.e. a counterfeit provider fault. Attributed
      // here instead, where the caller's signal is in scope.
      if (callerSignal?.aborted === true) {
        // `cause` carries the original: this branch fires on ANY failure that
        // surfaces once the signal is aborted, so a real 429 or 500 racing the
        // abort would otherwise be silently relabelled and lost.
        throw new LlmCancelledError('LLM call cancelled by caller while in flight', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
