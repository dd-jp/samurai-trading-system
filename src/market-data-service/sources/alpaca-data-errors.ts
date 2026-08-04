/**
 * Typed error hierarchy for the real Alpaca market-data `AlpacaClient`
 * (ticket #273) — mirrors `src/debate-engine/llm/errors.ts`'s shape per
 * transport-layer-spec.md's "Shared Transport Conventions" module (issue
 * #271). Parallel to, but deliberately separate from,
 * `execution/adapters/alpaca-broker-errors.ts`'s hierarchy — see that
 * module's doc comment for why the two `AlpacaClient` interfaces (broker vs.
 * market data) don't share one error hierarchy. The `Retry-After`-parsing
 * and body-truncation helpers underneath carry no such domain coupling, so
 * those are shared (`shared/http/response-errors.js`) rather than duplicated.
 */

import { parseRetryAfterMs, truncateForError } from '../../shared/index.js';

export class AlpacaDataTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlpacaDataTimeoutError';
  }
}

export class AlpacaDataRateLimitError extends Error {
  /** Provider-supplied hint (from a `Retry-After` header), if one was given. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'AlpacaDataRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Any other upstream failure (auth, bad request, 5xx, network) — not classified further. */
export class AlpacaDataProviderError extends Error {
  /** HTTP status code, when the failure came from a response rather than a network error. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AlpacaDataProviderError';
    this.status = status;
  }
}

/**
 * The venue answered fine — it just does not have `requested` bars in the
 * searched range (issue #292). Deliberately NOT an `AlpacaDataProviderError`:
 * nothing upstream failed, so classifying it as a provider fault would make
 * "Alpaca is broken" and "this symbol is too sparse for the window you asked
 * for" indistinguishable to anyone reading logs.
 *
 * Carries the numbers a human needs to act on it (which symbol, how many bars
 * were asked for, how many exist in the widened range) rather than a bare
 * message, so a caller that wants to degrade can read `received` instead of
 * re-parsing the text. Never retryable: repeating an identical request cannot
 * conjure bars that do not exist.
 */
export class AlpacaDataUnderfetchError extends Error {
  readonly symbol: string;
  readonly timeframe: string;
  /** Bars the caller asked for. */
  readonly requested: number;
  /** Bars the widened range actually produced. */
  readonly received: number;
  /** Start of the widest range searched (the retry's), ISO-8601. */
  readonly searchedFrom: string;
  /** `asOf` — the point-in-time boundary, never widened. */
  readonly searchedTo: string;

  constructor(details: {
    symbol: string;
    timeframe: string;
    requested: number;
    received: number;
    searchedFrom: string;
    searchedTo: string;
  }) {
    super(
      `AlpacaHttpDataClient.getBars: ${details.symbol} ${details.timeframe} produced ` +
        `${details.received} bars for a requested ${details.requested} over ` +
        `${details.searchedFrom}..${details.searchedTo} (the widest range this request ` +
        'is allowed to search). Refusing to ' +
        'return a short window silently — an indicator computed over fewer bars than the ' +
        "caller asked for is wrong, not merely degraded. Pass partial: 'allow' if this " +
        'call site genuinely tolerates fewer bars.',
    );
    this.name = 'AlpacaDataUnderfetchError';
    this.symbol = details.symbol;
    this.timeframe = details.timeframe;
    this.requested = details.requested;
    this.received = details.received;
    this.searchedFrom = details.searchedFrom;
    this.searchedTo = details.searchedTo;
  }
}

/**
 * What the `classify*` functions below can return — i.e. the ways an Alpaca
 * REQUEST can fail. `AlpacaDataUnderfetchError` is deliberately NOT a member:
 * it is raised by `getBars` after a successful request, above both the page
 * walk and `withRetry`, so no classifier can ever produce one and widening
 * this union would only tell callers of `classifyAlpacaDataResponse` to expect
 * a value it cannot return. Retryability is decided at runtime by
 * `isRetryableAlpacaDataError(error: unknown)`, which returns false for an
 * underfetch (pinned by a test) regardless of this type.
 */
export type AlpacaDataError =
  | AlpacaDataTimeoutError
  | AlpacaDataRateLimitError
  | AlpacaDataProviderError;

/**
 * Retryable set per transport-layer-spec.md's shared-conventions module:
 * Timeout | RateLimit | ProviderError-with-5xx-status.
 */
export function isRetryableAlpacaDataError(error: unknown): boolean {
  if (error instanceof AlpacaDataTimeoutError || error instanceof AlpacaDataRateLimitError) {
    return true;
  }
  if (error instanceof AlpacaDataProviderError) {
    return error.status !== undefined && error.status >= 500;
  }
  return false;
}

/** Classifies a non-2xx Alpaca response into the typed hierarchy: 429 -> RateLimit, 408/504 -> Timeout, else -> ProviderError. */
export async function classifyAlpacaDataResponse(
  response: Response,
  context: string,
): Promise<AlpacaDataError> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }
  const detail = bodyText.length > 0 ? truncateForError(bodyText) : response.statusText;
  const message = `Alpaca API error: ${response.status} ${detail} (${context})`;

  if (response.status === 429) {
    return new AlpacaDataRateLimitError(message, parseRetryAfterMs(response));
  }
  if (response.status === 408 || response.status === 504) {
    return new AlpacaDataTimeoutError(message);
  }
  return new AlpacaDataProviderError(message, response.status);
}

/** Classifies a network-level failure (e.g. a `fetchWithTimeout` abort) into the typed hierarchy. */
export function classifyAlpacaDataNetworkError(error: unknown, context: string): AlpacaDataError {
  // `fetchWithTimeout` aborts with `new DOMException(…, 'TimeoutError')` as the
  // abort reason (see src/shared/http/fetch-with-timeout.ts) — a caller-supplied
  // signal's plain `AbortError` is deliberately NOT a timeout and falls through
  // to the non-retryable ProviderError branch.
  const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeout) {
    return new AlpacaDataTimeoutError(`Alpaca request timed out (${context}): ${message}`);
  }
  return new AlpacaDataProviderError(`Alpaca network error (${context}): ${message}`);
}
