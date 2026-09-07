/**
 * Typed error hierarchy for `PolygonBarsClient` (issue #1238) — the same
 * `{Client}TimeoutError`/`{Client}RateLimitError`/`{Client}ProviderError`
 * shape `alpaca-data-errors.ts` uses per transport-layer-spec.md's "Shared
 * Transport Conventions" module, with one deliberate deviation from that
 * module's default `isRetryable` shape: see `isRetryablePolygonBarsError`.
 */

import {
  classifyStatus,
  isServerErrorStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
} from '../../../shared/index.js';

export class PolygonBarsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolygonBarsTimeoutError';
  }
}

export class PolygonBarsRateLimitError extends Error {
  /** Provider-supplied hint (from a `Retry-After` header), if one was given. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'PolygonBarsRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Any other upstream failure (auth, bad request, 5xx, network) — not classified further. */
export class PolygonBarsProviderError extends Error {
  /** HTTP status code, when the failure came from a response rather than a network error. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PolygonBarsProviderError';
    this.status = status;
  }
}

export type PolygonBarsError =
  | PolygonBarsTimeoutError
  | PolygonBarsRateLimitError
  | PolygonBarsProviderError;

/**
 * Retryable set: Timeout | ProviderError-with-5xx-status — deliberately
 * NARROWER than `isRetryableAlpacaDataError`'s Timeout | RateLimit |
 * ProviderError-with-5xx-status, which is the shared module's default.
 *
 * The other three clients (Alpaca ~200 req/min, Telegram effectively
 * unbounded for one bot) have headroom where a 429 is anomalous — retrying
 * it is recovering from a blip. Polygon's free tier is 5 calls/min, already
 * paced to ~4.6/min with no burst allowance (`venue-pacing.ts`'s
 * `DEFAULT_POLYGON_PACING`) specifically to stay under that ceiling. A 429
 * reaching this predicate means the ceiling was hit anyway; retrying it
 * immediately fights the exact constraint that produced it and risks
 * compounding the violation, not recovering from a transient one. A 5xx or a
 * timeout, by contrast, says nothing about the rate budget being exceeded —
 * those are worth the one retry this client's `RetryConfig` allows.
 */
export function isRetryablePolygonBarsError(error: unknown): boolean {
  if (error instanceof PolygonBarsTimeoutError) return true;
  if (error instanceof PolygonBarsProviderError) return isServerErrorStatus(error.status);
  return false;
}

/**
 * Classifies a non-2xx Polygon response into the typed hierarchy: 429 ->
 * RateLimit, 408/504 -> Timeout, else -> ProviderError. Deliberately does not
 * echo the response body into the message (unlike `classifyAlpacaDataResponse`)
 * — no test or caller here has ever needed it, and Polygon's own error bodies
 * are undocumented, so there is nothing curated to surface the way Alpaca's
 * `message` field is (`readErrorBody`'s doc comment, #1003).
 */
export function classifyPolygonBarsResponse(response: Response, context: string): PolygonBarsError {
  const message = `PolygonBarsClient: ${context} request failed with HTTP ${response.status}.`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      return new PolygonBarsRateLimitError(message, parseRetryAfterMs(response));
    case 'timeout':
      return new PolygonBarsTimeoutError(message);
    default:
      return new PolygonBarsProviderError(message, response.status);
  }
}

/** Classifies a network-level failure (e.g. a `fetchWithTimeout` abort) into the typed hierarchy. */
export function classifyPolygonBarsNetworkError(error: unknown, context: string): PolygonBarsError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new PolygonBarsTimeoutError(
      `PolygonBarsClient: ${context} request timed out: ${message}`,
    );
  }
  return new PolygonBarsProviderError(`PolygonBarsClient: ${context} network error: ${message}`);
}
