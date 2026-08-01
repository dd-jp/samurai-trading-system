/**
 * Real `AnthropicMessagesClient` (ticket #274) — see
 * docs/specs/transport-layer-spec.md ("Module: AnthropicMessagesClient
 * (production)"), Wayfinder map "Live Transport Layer" #259 (closed),
 * decision #261.
 *
 * Promotes the request shape proven in
 * `disagreement-detector.integration.test.ts` (raw `fetch` against
 * `https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`,
 * the `x-api-key` header) from test helper to a real production module.
 * Deliberately no `@anthropic-ai/sdk` dependency — `AnthropicMessagesClient`
 * (anthropic-client.ts) is a narrow structural interface so any wire client
 * satisfies it, and the proven integration-test shape is enough to implement
 * it without adding a new package dependency. Non-streaming: `createMessage`
 * always returns the complete parsed JSON body, never a stream.
 *
 * Uses `fetchWithTimeout` (issue #271, shared/http/fetch-with-timeout.ts) for
 * the network call itself, same as `HttpPolygonClient` — every real HTTP
 * client this transport layer introduces shares that boilerplate rather than
 * hand-rolling its own `AbortController`/`setTimeout` pairing. Tests stub the
 * global `fetch` (`vi.stubGlobal`), the same seam `fetch-with-timeout.test.ts`
 * itself uses, rather than this client inventing its own injectable-`fetch`
 * option.
 *
 * `AnthropicLlmClient.callWithTimeout` (anthropic-client.ts) separately races
 * the *whole* `createMessage` call against `config.timeoutMs`, with its timer
 * started before `createMessage()` is even invoked — that existing behavior
 * is unchanged by this ticket, and it is the one that actually decides a slow
 * call's `LlmTimeoutError` in practice. This client's own `timeoutMs` is
 * deliberately a separate, wider default rather than the same value as
 * `config.timeoutMs`: it exists only to abort a dangling in-flight request
 * after the outer race has already settled, not to race it — two timers on
 * an identical deadline would just be ambiguous about which one "wins".
 */

import { fetchWithTimeout } from '../../shared/http/fetch-with-timeout.js';
import type {
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessagesClient,
} from './anthropic-client.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** Wider than `AnthropicLlmClientConfig.timeoutMs`'s typical value (30s, production.ts's `DEFAULT_LLM_CLIENT_CONFIG`) — a backstop, not a race partner. See module doc comment. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Bumped from the stale `claude-3-5-haiku-latest` previously hardcoded in
 * `disagreement-detector.integration.test.ts` (this ticket bumps that
 * hardcode too, to keep the two from drifting again). Overridable via the
 * `ANTHROPIC_MODEL` env var — see `production.ts`, which reads it when
 * building `AnthropicLlmClientConfig.model`.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

export interface AnthropicHttpClientOptions {
  /** Defaults to `process.env.ANTHROPIC_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
  /** Per-request network timeout passed to `fetchWithTimeout`. Default 60s — a backstop, not tuned to race `AnthropicLlmClientConfig.timeoutMs`. See module doc comment. */
  timeoutMs?: number;
}

/** Real HTTP `AnthropicMessagesClient` against the Anthropic Messages API. */
export class AnthropicHttpMessagesClient implements AnthropicMessagesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: AnthropicHttpClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'AnthropicHttpMessagesClient: ANTHROPIC_API_KEY is not set. Provide it via the ' +
          'environment (.env.local, already provisioned) or pass { apiKey } explicitly.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createMessage(request: AnthropicMessageRequest): Promise<AnthropicMessageResponse> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(request),
      },
      this.timeoutMs,
    );

    if (!response.ok) {
      const error = new Error(
        `Anthropic API error: ${response.status} ${response.statusText}`,
      ) as Error & { status: number };
      error.status = response.status;
      throw error;
    }

    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as { content?: unknown }).content)
    ) {
      throw new Error(
        `Anthropic API error: response body missing expected "content" array (${JSON.stringify(body)})`,
      );
    }
    return body as AnthropicMessageResponse;
  }
}
