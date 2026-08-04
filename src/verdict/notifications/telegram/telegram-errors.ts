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

import { parseRetryAfterMs, truncateForError } from '../../../shared/index.js';

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

export type TelegramError = TelegramTimeoutError | TelegramRateLimitError | TelegramProviderError;

/**
 * Retryable set per transport-layer-spec.md's shared-conventions module:
 * Timeout | RateLimit | ProviderError-with-5xx-status. 4xx `ProviderError`s
 * stay non-retryable — including 409 Conflict, which under `getUpdates` means
 * a *second poller holds the bot token*; retrying that in a tight loop only
 * fights the other consumer (the poll loop handles it with a long backoff and
 * a loud log instead, see telegram-bot-api-client.ts).
 */
export function isRetryableTelegramError(error: unknown): boolean {
  if (error instanceof TelegramTimeoutError || error instanceof TelegramRateLimitError) {
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

  if (response.status === 429) {
    return new TelegramRateLimitError(
      message,
      retryAfterMsFromBody(bodyText) ?? parseRetryAfterMs(response),
    );
  }
  if (response.status === 408 || response.status === 504) {
    return new TelegramTimeoutError(message);
  }
  return new TelegramProviderError(message, response.status);
}

/**
 * Wraps a thrown transport failure (network error, or `fetchWithTimeout`'s
 * `TimeoutError` `DOMException`) into the typed hierarchy. A caller-initiated
 * `AbortError` — the poll loop's own `stop()` — is deliberately mapped to
 * `TelegramProviderError` with no status: not a timeout, and not retryable.
 */
export function classifyTelegramThrown(error: unknown, context: string): TelegramError {
  if (error instanceof TelegramTimeoutError || error instanceof TelegramRateLimitError) {
    return error;
  }
  if (error instanceof TelegramProviderError) {
    return error;
  }
  const name = (error as { name?: unknown } | null)?.name;
  const detail = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError') {
    return new TelegramTimeoutError(`Telegram Bot API timeout: ${detail} (${context})`);
  }
  return new TelegramProviderError(`Telegram Bot API transport failure: ${detail} (${context})`);
}
