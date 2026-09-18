
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

export type AlpacaHttpMethod = HttpMethod;

export class AlpacaBrokerTimeoutError extends VenueTimeoutError {}
export class AlpacaBrokerRateLimitError extends VenueRateLimitError {}

export class AlpacaBrokerProviderError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly venueMessage: string | undefined;
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

export function isRetryableAlpacaBrokerError(error: unknown): boolean {
  if (error instanceof AlpacaBrokerTimeoutError || error instanceof AlpacaBrokerRateLimitError) {
    return isRetrySafeMethod(error.method);
  }
  if (error instanceof AlpacaBrokerProviderError) {
    return isServerErrorStatus(error.status) && isRetrySafeMethod(error.method);
  }
  return false;
}

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

export function classifyAlpacaBrokerNetworkError(
  error: unknown,
  context: string,
  method: AlpacaHttpMethod,
): AlpacaBrokerError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new AlpacaBrokerTimeoutError(
      `Alpaca request timed out (${context}): ${message}`,
      method,
    );
  }
  return new AlpacaBrokerProviderError(
    `Alpaca network error (${context}): ${message}`,
    undefined,
    undefined,
    undefined,
    method,
  );
}
