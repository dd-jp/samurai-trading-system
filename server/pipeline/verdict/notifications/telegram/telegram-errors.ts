/**
 * Typed error hierarchy for the real Telegram Bot API client (ticket #275) —
 * mirrors `execution/adapters/alpaca-broker-errors.ts` and
 * `debate-engine/llm/errors.ts` per docs/specs/transport-layer-spec.md's
 * "Shared Transport Conventions" module (issue #271), which names Telegram
 * explicitly alongside Alpaca and Polygon: a `{Client}TimeoutError`, a
 * `{Client}RateLimitError` (with an optional provider-supplied
 * `retryAfterMs`), and a `{Client}ProviderError` catch-all.
 *
 * **The bot token lives in the request URL** (`/bot<token>/<method>`), so no
 * error raised here ever carries the URL — only the bare method name as
 * context. Every message on this path goes straight to a log.
 *
 * Telegram supplies its retry hint in the JSON body
 * (`parameters.retry_after`, seconds) rather than a `Retry-After` header, so
 * classification reads both and prefers the body's value.
 */

import { classifyStatus, parseRetryAfterMs, truncateForError } from '../../../../shared/index.js';

export class TelegramTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramTimeoutError';
  }
}

export class TelegramRateLimitError extends Error {
  /** Provider-supplied hint (`parameters.retry_after`, or a `Retry-After` header), if given. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TelegramRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Any other upstream failure (auth, bad request, 409 conflict, 5xx, network) — not classified further. */
export class TelegramProviderError extends Error {
  /** HTTP status code, when the failure came from a response rather than a network error. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TelegramProviderError';
    this.status = status;
  }
}

/**
 * A bare network failure (DNS/connection refused/reset — Node/undici's
 * `TypeError: fetch failed`, with no response and no abort involved). Split
 * out from `TelegramProviderError` (#1108) because the two must be retried
 * differently: this is a transient local/transport blip, not Telegram
 * rejecting the request, so it belongs in the retryable set the same way a
 * timeout does.
 */
export class TelegramNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramNetworkError';
  }
}

export type TelegramError =
  | TelegramTimeoutError
  | TelegramRateLimitError
  | TelegramProviderError
  | TelegramNetworkError;

/**
 * Retryable set per transport-layer-spec.md's shared-conventions module:
 * Timeout | RateLimit | NetworkError | ProviderError-with-5xx-status. 4xx
 * `ProviderError`s stay non-retryable — including 409 Conflict, which under
 * `getUpdates` means a *second poller holds the bot token*; retrying that in
 * a tight loop only fights the other consumer (the poll loop handles it with
 * a long backoff and a loud log instead, see telegram-bot-api-client.ts) —
 * and including the caller-initiated abort that `classifyTelegramThrown`
 * deliberately keeps as a `ProviderError` with no status, not a
 * `NetworkError`.
 */
export function isRetryableTelegramError(error: unknown): boolean {
  if (
    error instanceof TelegramTimeoutError ||
    error instanceof TelegramRateLimitError ||
    error instanceof TelegramNetworkError
  ) {
    return true;
  }
  if (error instanceof TelegramProviderError) {
    return error.status !== undefined && error.status >= 500;
  }
  return false;
}

/** Telegram's error envelope: `{ ok: false, description, error_code, parameters: { retry_after } }`. */
function retryAfterMsFromBody(bodyText: string): number | undefined {
  try {
    const body = JSON.parse(bodyText) as { parameters?: { retry_after?: unknown } };
    const seconds = body.parameters?.retry_after;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
    return seconds * 1000;
  } catch {
    return undefined;
  }
}

/** Best-effort extraction of Telegram's `description` field, falling back to the raw body. */
function describe(bodyText: string, response: Response): string {
  if (bodyText.length === 0) return response.statusText;
  try {
    const body = JSON.parse(bodyText) as { description?: unknown };
    if (typeof body.description === 'string' && body.description.length > 0) {
      return body.description;
    }
  } catch {
    // Not JSON (an intermediary proxy's HTML, say) — fall through to the raw text.
  }
  return truncateForError(bodyText);
}

/**
 * Classifies a non-2xx Bot API response: 429 -> RateLimit, 408/504 ->
 * Timeout, else -> ProviderError. `context` is the bare API method name —
 * never the request URL, which embeds the bot token.
 */
export async function classifyTelegramResponse(
  response: Response,
  context: string,
): Promise<TelegramError> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }

  const message = `Telegram Bot API error: ${response.status} ${describe(bodyText, response)} (${context})`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      // Telegram's hint is in the JSON body, not the header — prefer it.
      return new TelegramRateLimitError(
        message,
        retryAfterMsFromBody(bodyText) ?? parseRetryAfterMs(response),
      );
    case 'timeout':
      return new TelegramTimeoutError(message);
    default:
      return new TelegramProviderError(message, response.status);
  }
}

/**
 * Wraps a thrown transport failure (network error, or `fetchWithTimeout`'s
 * `TimeoutError` `DOMException`) into the typed hierarchy. A caller-initiated
 * `AbortError` — the poll loop's own `stop()` — is deliberately mapped to
 * `TelegramProviderError` with no status: not a timeout, and not retryable.
 *
 * Only a genuine bare network failure is a `TelegramNetworkError` (#1108):
 * Node/undici's `fetch` throws a `TypeError` with the exact message `fetch
 * failed` (cause carries the DNS/connection detail) when the request never
 * reached a server, and that is the sole signal accepted here. Everything
 * else thrown by `#request`'s try block — `JSON.stringify` on a circular
 * body, `new URL()` on a malformed `baseUrl`, or any other deterministic
 * programming/config fault — falls to `TelegramProviderError` (non-retryable)
 * instead: those are not transient, and retrying one 3x with backoff on
 * every alert send would fail the same way every time while masking the
 * actual defect.
 */
export function classifyTelegramThrown(error: unknown, context: string): TelegramError {
  if (
    error instanceof TelegramTimeoutError ||
    error instanceof TelegramRateLimitError ||
    error instanceof TelegramNetworkError
  ) {
    return error;
  }
  if (error instanceof TelegramProviderError) {
    return error;
  }
  // Deliberately a duck-typed `name` check rather than `shared`'s
  // `isTimeoutAbort`, which requires a real `DOMException`: the poll loop's
  // long-running `getUpdates` can surface a timeout as an undici error object
  // that is not a DOMException, and treating that as a provider fault would
  // make a routine long-poll expiry look like Telegram breaking.
  const name = (error as { name?: unknown } | null)?.name;
  const detail = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError') {
    return new TelegramTimeoutError(`Telegram Bot API timeout: ${detail} (${context})`);
  }
  if (name === 'AbortError') {
    return new TelegramProviderError(`Telegram Bot API transport failure: ${detail} (${context})`);
  }
  if (error instanceof TypeError && error.message.startsWith('fetch failed')) {
    return new TelegramNetworkError(`Telegram Bot API transport failure: ${detail} (${context})`);
  }
  return new TelegramProviderError(`Telegram Bot API transport failure: ${detail} (${context})`);
}
