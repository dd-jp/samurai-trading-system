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

export interface AnthropicMessagesClient {
  createMessage(request: AnthropicMessageRequest): Promise<AnthropicMessageResponse>;
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
  const contextJson = JSON.stringify(request.context, null, 2);
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
    return withRetry(() => this.attempt(request), this.config.retry, isRetryable);
  }

  private async attempt<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const start = Date.now();
    const response = await this.callWithTimeout(renderMessageContent(request));
    const latency_ms = Date.now() - start;

    // Metered BEFORE the parse gate below, because a malformed response was
    // still generated and still billed. Recording only well-formed responses
    // would make the meter understate spend by exactly the calls most likely
    // to be retried — i.e. it would be most wrong when it matters most.
    this.recordSpend(request, response);

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
   */
  private recordSpend<T>(request: LlmRequest<T>, response: AnthropicMessageResponse): void {
    if (response.usage === undefined) return;
    try {
      this.spendSink.record({
        trace_id: request.context.trace_id ?? 'unattributed',
        stage: request.context.stage ?? 'debate',
        model: response.model ?? this.config.model,
        usage: response.usage,
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

  private callWithTimeout(content: string): Promise<AnthropicMessageResponse> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new LlmTimeoutError(`LLM call exceeded ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
    });

    const call = this.client
      .createMessage({
        model: this.config.model,
        max_tokens: this.config.max_tokens,
        messages: [{ role: 'user', content }],
      })
      .catch((error) => {
        throw classifyProviderError(error);
      });

    return Promise.race([call, timeout]);
  }
}
