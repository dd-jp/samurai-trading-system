/**
 * Typed error hierarchy for the real Alpaca broker `AlpacaClient` (ticket
 * #273) — mirrors `src/debate-engine/llm/errors.ts`'s shape per
 * transport-layer-spec.md's "Shared Transport Conventions" module (issue
 * #271): a `{Client}TimeoutError`, `{Client}RateLimitError` (with an
 * optional provider-supplied `retryAfterMs`), and a `{Client}ProviderError`
 * catch-all (auth/bad-request/5xx/network — not classified further).
 *
 * Named `AlpacaBroker*` rather than plain `Alpaca*` because this codebase has
 * two structurally unrelated `AlpacaClient` interfaces (broker vs. market
 * data, see alpaca-client.ts's doc comment) — `alpaca-http-client.ts` in
 * `market-data-service/sources/` has its own parallel `AlpacaData*`
 * hierarchy rather than sharing this one, since the two clients hit
 * different Alpaca APIs (Trading v2 vs. Market Data v2) and classification
 * must not silently couple across that boundary. The `Retry-After`-parsing
 * and body-truncation helpers underneath carry no such domain coupling, so
 * those are shared (`shared/http/response-errors.js`) rather than duplicated.
 */

import {
  classifyStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
  readErrorDetail,
} from '../../shared/index.js';

export class AlpacaBrokerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlpacaBrokerTimeoutError';
  }
}

export class AlpacaBrokerRateLimitError extends Error {
  /** Provider-supplied hint (from a `Retry-After` header), if one was given. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'AlpacaBrokerRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Any other upstream failure (auth, bad request, 5xx, network) — not classified further. */
export class AlpacaBrokerProviderError extends Error {
  /** HTTP status code, when the failure came from a response rather than a network error. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AlpacaBrokerProviderError';
    this.status = status;
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
 */
export function isRetryableAlpacaBrokerError(error: unknown): boolean {
  if (error instanceof AlpacaBrokerTimeoutError || error instanceof AlpacaBrokerRateLimitError) {
    return true;
  }
  if (error instanceof AlpacaBrokerProviderError) {
    return error.status !== undefined && error.status >= 500;
  }
  return false;
}

/** Classifies a non-2xx Alpaca response into the typed hierarchy: 429 -> RateLimit, 408/504 -> Timeout, else -> ProviderError. */
export async function classifyAlpacaBrokerResponse(
  response: Response,
  context: string,
): Promise<AlpacaBrokerError> {
  const message = `Alpaca API error: ${response.status} ${await readErrorDetail(response)} (${context})`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      return new AlpacaBrokerRateLimitError(message, parseRetryAfterMs(response));
    case 'timeout':
      return new AlpacaBrokerTimeoutError(message);
    default:
      return new AlpacaBrokerProviderError(message, response.status);
  }
}

/** Classifies a network-level failure (e.g. a `fetchWithTimeout` abort) into the typed hierarchy. */
export function classifyAlpacaBrokerNetworkError(
  error: unknown,
  context: string,
): AlpacaBrokerError {
  // A caller-supplied signal's plain `AbortError` is deliberately NOT a timeout
  // and falls through to the non-retryable ProviderError branch — see
  // `isTimeoutAbort`.
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new AlpacaBrokerTimeoutError(`Alpaca request timed out (${context}): ${message}`);
  }
  return new AlpacaBrokerProviderError(`Alpaca network error (${context}): ${message}`);
}
