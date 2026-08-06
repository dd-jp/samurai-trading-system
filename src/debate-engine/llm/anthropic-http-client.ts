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
import { truncateForError } from '../../shared/http/response-errors.js';
import type {
  AnthropicMessageOptions,
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

/**
 * Typed failure for this client's network boundary (non-2xx response,
 * unparseable body, or a parseable-but-malformed body) — replaces a plain
 * `Error` with a manually attached `status` property (PR #284 review). Kept
 * local to this module rather than added to `errors.ts`'s `LlmError`
 * hierarchy: `AnthropicLlmClient.classifyProviderError` (anthropic-client.ts)
 * already duck-types *any* thrown error's `.status` field into the typed
 * hierarchy (429 -> `LlmRateLimitError`, 408/504 -> `LlmTimeoutError`, else
 * -> `LlmProviderError`) precisely so this client doesn't need to know about
 * that classification — it only needs to expose `.status` consistently,
 * which this class does via a real property instead of a cast.
 */
export class AnthropicApiError extends Error {
  /** HTTP status code, or the response's status when the body itself failed to parse. */
  readonly status: number;
  /** Parsed response body, if one was available — for callers that want more than `message`. */
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'AnthropicApiError';
    this.status = status;
    this.body = body;
  }
}

/** Best-effort extraction of the Anthropic API's `{ error: { type, message } }` envelope. */
function describeErrorBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const detail = (body as { error?: { type?: unknown; message?: unknown } }).error;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const type = typeof detail.type === 'string' ? detail.type : 'error';
  const message = typeof detail.message === 'string' ? detail.message : undefined;
  return message === undefined ? undefined : `${type}: ${message}`;
}

/** Builds the typed error for a non-2xx response, preferring the API's own error envelope over bare `statusText`. */
async function buildApiError(response: Response): Promise<AnthropicApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const detail = describeErrorBody(body) ?? response.statusText;
  return new AnthropicApiError(
    response.status,
    `Anthropic API error: ${response.status} ${detail}`,
    body,
  );
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

  /**
   * `options.signal` (#347) is the cancellation seam the debate's latency
   * budget reaches through: it is handed to `fetchWithTimeout`, which composes
   * it with its own timeout signal via `AbortSignal.any`, so the real socket
   * closes when the caller cancels. This is the layer at which "aborted, not
   * merely ignored" is true — every layer above only forwards it.
   */
  async createMessage(
    request: AnthropicMessageRequest,
    options: AnthropicMessageOptions = {},
  ): Promise<AnthropicMessageResponse> {
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
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      this.timeoutMs,
    );

    if (!response.ok) {
      throw await buildApiError(response);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      // A 2xx with an unparseable body (truncated stream, HTML from an
      // intermediary proxy) would otherwise escape as a raw, unclassified
      // `SyntaxError` — wrap it in the same typed shape as every other
      // failure at this boundary (PR #284 review).
      throw new AnthropicApiError(
        response.status,
        `Anthropic API error: response body could not be parsed as JSON (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      );
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as { content?: unknown }).content)
    ) {
      throw new AnthropicApiError(
        response.status,
        `Anthropic API error: response body missing expected "content" array (${truncateForError(JSON.stringify(body))})`,
        body,
      );
    }
    return body as AnthropicMessageResponse;
  }
}
