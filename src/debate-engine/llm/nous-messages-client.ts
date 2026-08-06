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

import { nousChat } from '../../shared/llm/nous-chat.js';
import type {
  AnthropicMessageOptions,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './anthropic-client.js';

export interface NousMessagesClientOptions {
  apiKey: string;
  baseUrl: string;
  /**
   * Network backstop. Defaults to `nousChat`'s own, deliberately WIDER than
   * `AnthropicLlmClientConfig.timeoutMs` (30s): that value governs the outer
   * race in `AnthropicLlmClient.callWithTimeout`, whose timer starts before
   * `createMessage` is even called, so it is the one that actually decides a
   * slow call's `LlmTimeoutError`. Two timers on an identical deadline would
   * only be ambiguous about which won.
   */
  timeoutMs?: number;
}

export class NousMessagesClient implements AnthropicMessagesClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number | undefined;

  constructor(options: NousMessagesClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#timeoutMs = options.timeoutMs;
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
    const result = await nousChat(
      {
        apiKey: this.#apiKey,
        baseUrl: this.#baseUrl,
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
        signal: options.signal,
      },
      {
        model: request.model,
        messages: request.messages,
        max_tokens: request.max_tokens,
      },
    );

    return {
      content: [{ type: 'text', text: result.text }],
      usage: result.usage,
      // `nousChat` has already decided which id is safe to meter against — the
      // provider's echo only when this system can price it, otherwise the id
      // that was requested. `AnthropicLlmClient.recordSpend` prefers this field
      // over its configured model, so an unpriceable echo landing here would
      // record an unpriced row, and an unpriced row does not count against the
      // spend cap.
      model: result.model,
    };
  }
}
