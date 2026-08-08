/**
 * Provider-agnostic HTTP-response error-message helpers (issue #273 code
 * review — hoisted out of duplicate copies in `execution/adapters/
 * alpaca-broker-errors.ts` and `market-data-service/sources/
 * alpaca-data-errors.ts`, the first two of what `transport-layer-spec.md`'s
 * "Shared Transport Conventions" module expects to be several per-client
 * `{Client}TimeoutError`/`{Client}RateLimitError`/`{Client}ProviderError`
 * hierarchies). Unlike the error *classes* themselves — which stay
 * per-client, since each client's classification must not couple across
 * providers/interfaces — parsing a `Retry-After` header and truncating an
 * oversized response body for an error message carry zero domain knowledge,
 * so there is no reason for every client to reimplement them.
 */

/** Best-effort parse of a `Retry-After` header (seconds, per HTTP spec) into milliseconds. */
export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  // An empty/whitespace header means "no usable value", not 0 — `Number('')`
  // is 0, so it must be rejected before the numeric parse.
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Caps how much of a response body is ever baked into an error message (goes straight to logs). */
const MAX_ERROR_BODY_CHARS = 500;

/** Truncates `text` to `MAX_ERROR_BODY_CHARS`, appending a note of the original length when it does. */
export function truncateForError(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated, ${text.length} chars total)`
    : text;
}

/**
 * Best-effort detail for a non-2xx response's error message: the truncated
 * body if there is one, else `statusText`.
 *
 * A body that cannot be read at all (already-consumed stream, mid-flight
 * network drop) degrades to `statusText` rather than throwing — this runs on
 * the path that is *already* reporting a failure, and a throw here would
 * replace a useful provider error with a meaningless one.
 *
 * Not usable by a client that needs the raw body for something else as well —
 * Telegram parses `parameters.retry_after` out of it — since a `Response` body
 * can only be read once.
 */
export async function readErrorDetail(response: Response): Promise<string> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }
  return bodyText.length > 0 ? truncateForError(bodyText) : response.statusText;
}

/**
 * Which kind of failure an HTTP status represents, per transport-layer-spec.md's
 * "Shared Transport Conventions" module. The classes stay per-vendor — each
 * client's error hierarchy must not couple to another's — but this mapping is
 * the same everywhere and is the part that costs something to keep in sync.
 */
export type HttpErrorKind = 'rate-limit' | 'timeout' | 'provider';

/** 429 -> rate-limit, 408/504 -> timeout, everything else -> provider. */
export function classifyStatus(status: number): HttpErrorKind {
  if (status === 429) return 'rate-limit';
  if (status === 408 || status === 504) return 'timeout';
  return 'provider';
}

/**
 * Whether a thrown value is `fetchWithTimeout`'s deadline abort.
 *
 * That helper aborts with `new DOMException(…, 'TimeoutError')`; a
 * caller-supplied signal's plain `AbortError` is deliberately NOT a timeout and
 * must fall through to the non-retryable branch, or a deliberate shutdown would
 * be retried as if the provider were slow.
 */
export function isTimeoutAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}
