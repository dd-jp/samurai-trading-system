/**
 * Concrete `LlmClient` (ticket #31 AC: "Concrete implementation using
 * configured LLM provider"). The wire client is injected rather than
 * constructed here, mirroring `AlpacaClient`/`CcxtBrokerClient` — connection
 * provisioning (API key, base URL) is an ops concern, and `AnthropicMessagesClient`
 * is deliberately the narrow slice of the Anthropic Messages API this file
 * uses, so any real SDK client (or a test double) satisfies it structurally
 * without a hard dependency on a specific SDK package.
 */

import {
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmTimeoutError,
} from './errors.js';
import { wrapUntrusted } from './prompt-safety.js';
import { withRetry } from './retry.js';
import type { LlmClient, LlmRequest, LlmResponse, LlmRetryConfig } from './types.js';

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}

/** The subset of the Messages API response this client reads (text content blocks). */
export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
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
  ) {}

  complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    return withRetry(() => this.attempt(request), this.config.retry);
  }

  private async attempt<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    const start = Date.now();
    const rawText = await this.callWithTimeout(renderMessageContent(request));
    const latency_ms = Date.now() - start;

    const parsed = request.parseResponse(rawText);
    if (!parsed.valid) {
      throw new LlmMalformedResponseError(parsed.reason);
    }

    return { data: parsed.data, raw_text: rawText, latency_ms };
  }

  private callWithTimeout(content: string): Promise<string> {
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
      .then(extractText)
      .catch((error) => {
        throw classifyProviderError(error);
      });

    return Promise.race([call, timeout]);
  }
}
