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
