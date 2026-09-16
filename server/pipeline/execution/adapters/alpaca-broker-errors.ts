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
 * those are shared (`shared/http/response-errors.js`) rather than duplicated —
 * as are the Timeout/RateLimit shapes and the retry-safe verb allowlist this
 * hierarchy shares with Saxo's (`venue-errors.ts`); the classes themselves
 * stay Alpaca's own so `instanceof` never crosses venues.
 */

import {
  classifyStatus,
  isServerErrorStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
  readErrorBody,
} from '../../../shared/index.js';
import {
  type HttpMethod,
  isRetrySafeMethod,
  VenueRateLimitError,
  VenueTimeoutError,
} from './venue-errors.js';

/** See `HttpMethod` (venue-errors.ts); `AlpacaHttpBrokerClient.request` types `init.method` as this */
export type AlpacaHttpMethod = HttpMethod;

/** Own classes, not the venue-agnostic bases: `instanceof` and `.name` never cross venues */
export class AlpacaBrokerTimeoutError extends VenueTimeoutError {}
export class AlpacaBrokerRateLimitError extends VenueRateLimitError {}

/** Any other upstream failure (auth, bad request, 5xx, network) — not classified further */
export class AlpacaBrokerProviderError extends Error {
  /** HTTP status code, when the failure came from a response rather than a network error */
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
   * there is nothing for `method` to change about their retryability
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
 * Retryable set per transport-layer-spec.md's shared-conventions module:
 * Timeout | RateLimit | ProviderError-with-5xx-status. 4xx `ProviderError`s
 * (auth, bad request, and — critically — the 404 `getOrderByClientOrderId`
 * maps to `null` before this predicate is ever consulted) stay non-retryable.
 *
 * Since #1275, Timeout/RateLimit/5xx retryability also carries the request's
 * verb: `isRetrySafeMethod` (venue-errors.ts) gates all three instead of
 * firing unconditionally, so a placement POST timeout, rate-limit or 5xx is
 * refused retry by this predicate alone, not only by `submitOrder`'s own
 * `maxAttempts: 1` override. DELETE's admission rests on `cancelOrder`
 * (`alpaca-http-client.ts`) normalising `204`/`404`/`422` to one terminal
 * outcome, not on a probed venue guarantee — unlike Saxo's, nothing here has
 * been measured against the real venue.
 */
export function isRetryableAlpacaBrokerError(error: unknown): boolean {
  if (error instanceof AlpacaBrokerTimeoutError || error instanceof AlpacaBrokerRateLimitError) {
    return isRetrySafeMethod(error.method);
  }
  if (error instanceof AlpacaBrokerProviderError) {
    return isServerErrorStatus(error.status) && isRetrySafeMethod(error.method);
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
  // `isTimeoutAbort`
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
  // `AlpacaBrokerProviderError.method`'s doc comment
  return new AlpacaBrokerProviderError(
    `Alpaca network error (${context}): ${message}`,
    undefined,
    undefined,
    undefined,
    method,
  );
}
