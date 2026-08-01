/**
 * Typed error hierarchy for the real Alpaca market-data `AlpacaClient`
 * (ticket #273) — mirrors `src/debate-engine/llm/errors.ts`'s shape per
 * transport-layer-spec.md's "Shared Transport Conventions" module (issue
 * #271). Parallel to, but deliberately separate from,
 * `execution/adapters/alpaca-broker-errors.ts`'s hierarchy — see that
 * module's doc comment for why the two `AlpacaClient` interfaces (broker vs.
 * market data) don't share one error hierarchy.
 */

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
    return error.status !== undefined && error.status >= 500 && error.status <= 599;
  }
  return false;
}

/** Best-effort parse of a `Retry-After` header (seconds, per HTTP spec) into milliseconds. */
export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Caps how much of a response body is ever baked into an error message (goes straight to logs). */
const MAX_ERROR_BODY_CHARS = 500;

function truncateForError(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated, ${text.length} chars total)`
    : text;
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
  const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeout) {
    return new AlpacaDataTimeoutError(`Alpaca request timed out (${context}): ${message}`);
  }
  return new AlpacaDataProviderError(`Alpaca network error (${context}): ${message}`);
}
