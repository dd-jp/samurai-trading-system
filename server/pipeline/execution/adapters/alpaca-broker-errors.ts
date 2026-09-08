/**
 * Typed error hierarchy for the real Alpaca broker `AlpacaBrokerClient` (ticket
 * #273) — mirrors `server/pipeline/debate-engine/llm/errors.ts`'s shape per
 * transport-layer-spec.md's "Shared Transport Conventions" module (issue
 * #271): a `{Client}TimeoutError`, `{Client}RateLimitError` (with an
 * optional provider-supplied `retryAfterMs`), and a `{Client}ProviderError`
 * catch-all (auth/bad-request/5xx/network — not classified further).
 *
 * Named `AlpacaBroker*` rather than plain `Alpaca*` because this codebase has
 * two structurally unrelated client interfaces, `AlpacaBrokerClient` (broker,
 * this module) and `AlpacaMarketDataClient` (market data, see alpaca-client.ts's
 * doc comment) — `alpaca-http-client.ts` in
 * `market-data-service/sources/` has its own parallel `AlpacaData*`
 * hierarchy rather than sharing this one, since the two clients hit
 * different Alpaca APIs (Trading v2 vs. Market Data v2) and classification
 * must not silently couple across that boundary. The `Retry-After`-parsing
 * and body-truncation helpers underneath carry no such domain coupling, so
 * those are shared (`shared/http/response-errors.js`) rather than duplicated.
 */

import {
  classifyStatus,
  isServerErrorStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
  readErrorBody,
} from '../../../shared/index.js';

/**
 * The HTTP verb of the request that failed, as literally passed to
 * `fetch`/`fetchWithTimeout` — `AlpacaHttpBrokerClient.request`'s `init.method`
 * is typed to require one of these, so a new operation cannot omit it and
 * fall through to a default. Every error class below that can be retried
 * carries the verb of the request that produced it, and
 * `isRetryableAlpacaBrokerError` consults it (#1275) — mirrors
 * `saxo-broker-errors.ts`'s `SaxoHttpMethod` (#1273), not shared with it: the
 * two hierarchies stay independent per this module's own doc comment.
 */
export type AlpacaHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * `method` (#1275) is the verb of the request that timed out — set at both
 * construction sites, the `fetchWithTimeout` deadline abort
 * (`classifyAlpacaBrokerNetworkError`) and a 408/504 response
 * (`classifyAlpacaBrokerResponse`) — so `isRetryableAlpacaBrokerError` can
 * gate retry on it instead of retrying every timeout unconditionally, which
 * is what let a timed-out placement POST retry before this ticket.
 */
export class AlpacaBrokerTimeoutError extends Error {
  readonly method: AlpacaHttpMethod;

  constructor(message: string, method: AlpacaHttpMethod) {
    super(message);
    this.name = 'AlpacaBrokerTimeoutError';
    this.method = method;
  }
}

/** `method` (#1275): see `AlpacaBrokerTimeoutError`'s doc comment — same reason, same gate. */
export class AlpacaBrokerRateLimitError extends Error {
  /** Provider-supplied hint (from a `Retry-After` header), if one was given. */
  readonly retryAfterMs: number | undefined;
  readonly method: AlpacaHttpMethod;

  constructor(message: string, method: AlpacaHttpMethod, retryAfterMs?: number) {
    super(message);
    this.name = 'AlpacaBrokerRateLimitError';
    this.method = method;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Any other upstream failure (auth, bad request, 5xx, network) — not classified further. */
export class AlpacaBrokerProviderError extends Error {
  /** HTTP status code, when the failure came from a response rather than a network error. */
  readonly status: number | undefined;
  /**
   * Alpaca's own numeric error code (e.g. `42210000`), when the failure came
   * from a response whose body was parseable JSON carrying one — see
   * `sanitizeBrokerError`'s `readVenueCode` (`broker-error.ts`), which reads
   * this field off the thrown cause to populate `BrokerError.venueCode`
   * (issue #953). Only `AlpacaBrokerProviderError` carries this: Timeout and
   * RateLimit are classified before any body is inspected for a venue code,
   * and 429/408/504 responses do not carry Alpaca's `{code, message}` shape.
   */
  readonly code: string | undefined;
  /**
   * Alpaca's own diagnostic `message` string (e.g. "invalid
   * take_profit.limit_price 746.96 ... sub-penny increment does not fulfill
   * minimum pricing criteria"), when the response body carried one — see
   * `sanitizeBrokerError`'s `readVenueMessage` (`broker-error.ts`), which
   * reads this field off the thrown cause to populate `BrokerError.venueMessage`
   * (issue #1003). This is `readErrorBody`'s allowlisted, length-bounded
   * `message` field — never the raw response body, and never this error's own
   * `.message` (which embeds the full body text and is deliberately NOT read
   * by `sanitizeBrokerError`, per broker-error.ts's H1 boundary). Same scope
   * restriction as `code`: only `AlpacaBrokerProviderError` carries this.
   */
  readonly venueMessage: string | undefined;
  /**
   * The verb of the request this came from (#1275), when known — set by
   * `classifyAlpacaBrokerResponse` (every response-classified `ProviderError`
   * has one) but left `undefined` by a status-less construction
   * (`classifyAlpacaBrokerNetworkError`'s network-error branch, `request<T>`'s
   * JSON-parse failure, and `failValidation`'s malformed-body failure): none
   * of those ever carry a `status`, so `isRetryableAlpacaBrokerError`'s
   * `isServerErrorStatus` gate already excludes them regardless of verb, and
   * there is nothing for `method` to change about their retryability.
   */
  readonly method: AlpacaHttpMethod | undefined;

  constructor(
    message: string,
    status?: number,
    code?: string,
    venueMessage?: string,
    method?: AlpacaHttpMethod,
  ) {
    super(message);
    this.name = 'AlpacaBrokerProviderError';
    this.status = status;
    this.code = code;
    this.venueMessage = venueMessage;
    this.method = method;
  }
}

export type AlpacaBrokerError =
  | AlpacaBrokerTimeoutError
  | AlpacaBrokerRateLimitError
  | AlpacaBrokerProviderError;

/**
 * Retry-safe verbs for an Alpaca timeout, rate-limit or 5xx (#1275) — GET by
 * HTTP semantics alone (a read cannot mutate venue state, regardless of which
 * read it is); DELETE because `cancelOrder` (`alpaca-http-client.ts`) already
 * normalizes every terminal outcome (`204`/`404`/`422`) to "nothing working
 * under this id any more", so a repeated cancel lands on that same
 * normalization rather than mutating anything a first cancel did not already
 * settle. Neither admission rests on a probed venue guarantee — unlike
 * Saxo's equivalent (`saxo-broker-errors.ts`), where DELETE was measured
 * (doc 43:33), nothing here has been measured against the real venue.
 *
 * POST is excluded on principle, unconditionally: `submitOrder` and its
 * siblings are the operations an accidental duplicate is expensive for (a
 * second live order), and this repo has never probed Alpaca's response to a
 * duplicate `client_order_id` (see `alpaca-adapter.ts`'s `rearmProtectiveLegs`
 * comments) — so POST is refused here independent of whether that unverified
 * 422 guarantee turns out to be true.
 *
 * PUT/PATCH are in `AlpacaHttpMethod` (no Alpaca client call currently uses
 * either) but are likewise left off this allowlist — not because either is
 * known to be unsafe, but because, like POST, neither has been probed either.
 * Add a verb here only on evidence, never on the absence of a reason to
 * exclude it.
 */
function isRetrySafeAlpacaMethod(method: AlpacaHttpMethod | undefined): boolean {
  return method === 'GET' || method === 'DELETE';
}

/**
 * Retryable set per transport-layer-spec.md's shared-conventions module:
 * Timeout | RateLimit | ProviderError-with-5xx-status. 4xx `ProviderError`s
 * (auth, bad request, and — critically — the 404 `getOrderByClientOrderId`
 * maps to `null` before this predicate is ever consulted) stay non-retryable.
 *
 * Since #1275, Timeout/RateLimit/5xx retryability also carries the request's
 * verb: `isRetrySafeAlpacaMethod` gates all three instead of firing
 * unconditionally, so a placement POST timeout, rate-limit or 5xx is refused
 * retry by this predicate alone, not only by `submitOrder`'s own
 * `maxAttempts: 1` override.
 */
export function isRetryableAlpacaBrokerError(error: unknown): boolean {
  if (error instanceof AlpacaBrokerTimeoutError || error instanceof AlpacaBrokerRateLimitError) {
    return isRetrySafeAlpacaMethod(error.method);
  }
  if (error instanceof AlpacaBrokerProviderError) {
    return isServerErrorStatus(error.status) && isRetrySafeAlpacaMethod(error.method);
  }
  return false;
}

/**
 * Classifies a non-2xx Alpaca response into the typed hierarchy: 429 ->
 * RateLimit, 408/504 -> Timeout, else -> ProviderError. `method` (#1275,
 * required for the same reason #1273 made it required on
 * `classifySaxoBrokerResponse`): the verb of the request whose response this
 * is, so `isRetryableAlpacaBrokerError` can gate on it instead of retrying
 * unconditionally.
 */
export async function classifyAlpacaBrokerResponse(
  response: Response,
  context: string,
  method: AlpacaHttpMethod,
): Promise<AlpacaBrokerError> {
  const { detail, code, message: venueMessage } = await readErrorBody(response);
  const message = `Alpaca API error: ${response.status} ${detail} (${context})`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      return new AlpacaBrokerRateLimitError(message, method, parseRetryAfterMs(response));
    case 'timeout':
      return new AlpacaBrokerTimeoutError(message, method);
    default:
      return new AlpacaBrokerProviderError(message, response.status, code, venueMessage, method);
  }
}

/**
 * Classifies a network-level failure (e.g. a `fetchWithTimeout` abort) into
 * the typed hierarchy. `method` (#1275) is required, not defaulted, so a new
 * call site must say what it did rather than silently inheriting a
 * safe-looking default (mirrors #1223's `classifySaxoBrokerNetworkError`).
 */
export function classifyAlpacaBrokerNetworkError(
  error: unknown,
  context: string,
  method: AlpacaHttpMethod,
): AlpacaBrokerError {
  // A caller-supplied signal's plain `AbortError` is deliberately NOT a timeout
  // and falls through to the non-retryable ProviderError branch — see
  // `isTimeoutAbort`.
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new AlpacaBrokerTimeoutError(
      `Alpaca request timed out (${context}): ${message}`,
      method,
    );
  }
  // No `status` on this branch (nothing responded), so `method` is passed for
  // record-keeping only — `isRetryableAlpacaBrokerError`'s `isServerErrorStatus`
  // gate already makes this non-retryable regardless of verb; see
  // `AlpacaBrokerProviderError.method`'s doc comment.
  return new AlpacaBrokerProviderError(
    `Alpaca network error (${context}): ${message}`,
    undefined,
    undefined,
    undefined,
    method,
  );
}
