import {
  classifyStatus,
  isServerErrorStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
  readErrorDetail,
} from '../../../shared/index.js';

export class AlpacaDataTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlpacaDataTimeoutError';
  }
}

export class AlpacaDataRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'AlpacaDataRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AlpacaDataProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AlpacaDataProviderError';
    this.status = status;
  }
}

export class AlpacaDataUnderfetchError extends Error {
  readonly symbol: string;
  readonly timeframe: string;
  readonly requested: number;
  readonly received: number;
  readonly searchedFrom: string;
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

export type AlpacaDataError =
  | AlpacaDataTimeoutError
  | AlpacaDataRateLimitError
  | AlpacaDataProviderError;

export function isRetryableAlpacaDataError(error: unknown): boolean {
  if (error instanceof AlpacaDataTimeoutError || error instanceof AlpacaDataRateLimitError) {
    return true;
  }
  if (error instanceof AlpacaDataProviderError) {
    return isServerErrorStatus(error.status);
  }
  return false;
}

export async function classifyAlpacaDataResponse(
  response: Response,
  context: string,
): Promise<AlpacaDataError> {
  const message = `Alpaca API error: ${response.status} ${await readErrorDetail(response)} (${context})`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      return new AlpacaDataRateLimitError(message, parseRetryAfterMs(response));
    case 'timeout':
      return new AlpacaDataTimeoutError(message);
    default:
      return new AlpacaDataProviderError(message, response.status);
  }
}

export function classifyAlpacaDataNetworkError(error: unknown, context: string): AlpacaDataError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new AlpacaDataTimeoutError(`Alpaca request timed out (${context}): ${message}`);
  }
  return new AlpacaDataProviderError(`Alpaca network error (${context}): ${message}`);
}
