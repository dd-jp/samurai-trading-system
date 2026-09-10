/**
 * The venue-agnostic half of a broker client's typed error hierarchy — what
 * `saxo-broker-errors.ts` and `alpaca-broker-errors.ts` each used to carry a
 * copy of: the HTTP verb every retryable error records, the Timeout and
 * RateLimit shapes, and the verb allowlist both retry predicates gate on.
 *
 * Each venue keeps its own subclasses so `instanceof` and `.name` stay
 * venue-specific, its own ProviderError (the two disagree on what a
 * status-less failure means — see `SaxoBrokerProviderError.retryableTransportFailure`)
 * and its own error-body parsing (Saxo nests `{ErrorInfo: {ErrorCode,
 * Message}}`, Alpaca is flat `{code, message}`).
 */

/**
 * The HTTP verb of the request that failed, as literally passed to
 * `fetch`/`fetchWithTimeout`. Each venue client's `request` types its
 * `init.method` as this, so a new operation cannot omit the verb and fall
 * through to a default — every retryable error below carries it and the
 * venue's retry predicate consults it (#1223, #1273, #1275).
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * `method` is the verb of the request that timed out — set at both
 * construction sites, the `fetchWithTimeout` deadline abort and a 408/504
 * response — so the venue's retry predicate can gate on it instead of
 * retrying every timeout unconditionally, which is what once let a timed-out
 * placement POST retry (#1273, #1275).
 */
export class VenueTimeoutError extends Error {
  readonly method: HttpMethod;

  constructor(message: string, method: HttpMethod) {
    super(message);
    this.name = new.target.name;
    this.method = method;
  }
}

/** `method`: see `VenueTimeoutError` — same reason, same gate. */
export class VenueRateLimitError extends Error {
  /** Provider-supplied hint (from a `Retry-After` header), if one was given. */
  readonly retryAfterMs: number | undefined;
  readonly method: HttpMethod;

  constructor(message: string, method: HttpMethod, retryAfterMs?: number) {
    super(message);
    this.name = new.target.name;
    this.method = method;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The verbs a timeout, rate-limit or 5xx may be retried on, for both venues.
 *
 * GET needs no per-venue evidence: repeating a read cannot mutate venue state,
 * by HTTP semantics, whichever read it is. DELETE is here because each
 * venue's `cancelOrder` — the only DELETE call site on either — lands a
 * repeat on the same terminal outcome as the first (Saxo: measured, doc
 * 43:33, `404 OrderNotFound`; Alpaca: normalised by the client, `204`/`404`/
 * `422` all read as "nothing working under this id"). The admission is by
 * VERB, not by operation: a second DELETE operation would inherit retry with
 * no proof of its own, and a reviewer adding one is where this allowlist's
 * posture actually gets tested.
 *
 * POST is excluded on principle regardless of status: `placeOrder` is the one
 * operation an accidental duplicate is expensive for, and neither venue's
 * response to a duplicate has been probed. A POST 429 almost certainly placed
 * nothing, but it stays out for uniformity — one gate per verb, not
 * verb-plus-status carve-outs. PUT and PATCH are unused by every call site and
 * unverified on both venues, so they are unlisted rather than judged unsafe.
 * Add a verb only on evidence, never on the absence of a reason to exclude it.
 */
export function isRetrySafeMethod(method: HttpMethod | undefined): boolean {
  return method === 'GET' || method === 'DELETE';
}
