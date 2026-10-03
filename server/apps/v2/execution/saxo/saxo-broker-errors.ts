import {
  classifyStatus,
  isServerErrorStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
  truncateForError,
} from '../../../../shared/index.js';
import {
  type HttpMethod,
  isRetrySafeMethod,
  VenueRateLimitError,
  VenueTimeoutError,
} from './venue-errors.js';

export type SaxoHttpMethod = HttpMethod;

export class SaxoBrokerTimeoutError extends VenueTimeoutError {}
export class SaxoBrokerRateLimitError extends VenueRateLimitError {}

export class SaxoBrokerProviderError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly venueMessage: string | undefined;
  readonly retryableTransportFailure: boolean;
  readonly method: SaxoHttpMethod | undefined;

  constructor(
    message: string,
    status?: number,
    code?: string,
    venueMessage?: string,
    retryableTransportFailure = false,
    method?: SaxoHttpMethod,
  ) {
    super(message);
    this.name = 'SaxoBrokerProviderError';
    this.status = status;
    this.code = code;
    this.venueMessage = venueMessage;
    this.retryableTransportFailure = retryableTransportFailure;
    this.method = method;
  }
}

export type SaxoBrokerError =
  | SaxoBrokerTimeoutError
  | SaxoBrokerRateLimitError
  | SaxoBrokerProviderError;

export function isDuplicateRequestRefusal(error: unknown): boolean {
  return error instanceof SaxoBrokerProviderError && error.status === 409;
}

export function isOrderNotFound(error: unknown): boolean {
  return (
    error instanceof SaxoBrokerProviderError &&
    (error.status === 404 || error.code === 'OrderNotFound')
  );
}

export function isRetryableSaxoBrokerError(error: unknown): boolean {
  if (error instanceof SaxoBrokerTimeoutError || error instanceof SaxoBrokerRateLimitError) {
    return isRetrySafeMethod(error.method);
  }
  if (error instanceof SaxoBrokerProviderError) {
    if (error.status !== undefined) {
      return isServerErrorStatus(error.status) && isRetrySafeMethod(error.method);
    }
    return error.retryableTransportFailure;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function collectSaxoErrorCandidates(parsed: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [parsed.ErrorInfo, parsed];
  if (Array.isArray(parsed.Orders)) {
    for (const leg of parsed.Orders) {
      if (isRecord(leg)) candidates.push(leg.ErrorInfo);
    }
  }
  return candidates;
}

function readSaxoErrorInfo(
  candidate: unknown,
): { code: string | undefined; message: string | undefined } | undefined {
  if (!isRecord(candidate)) return undefined;
  const code = typeof candidate.ErrorCode === 'string' ? candidate.ErrorCode : undefined;
  const message =
    typeof candidate.Message === 'string' ? truncateForError(candidate.Message) : undefined;
  return code === undefined && message === undefined ? undefined : { code, message };
}

function parseSaxoErrorInfo(bodyText: string): {
  code: string | undefined;
  message: string | undefined;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { code: undefined, message: undefined };
  }
  if (!isRecord(parsed)) return { code: undefined, message: undefined };

  for (const candidate of collectSaxoErrorCandidates(parsed)) {
    const info = readSaxoErrorInfo(candidate);
    if (info !== undefined) return info;
  }
  return { code: undefined, message: undefined };
}

export async function classifySaxoBrokerResponse(
  response: Response,
  context: string,
  method: SaxoHttpMethod,
): Promise<SaxoBrokerError> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }
  const detail = bodyText.length > 0 ? truncateForError(bodyText) : response.statusText;
  const message = `Saxo API error: ${response.status} ${detail} (${context})`;

  switch (classifyStatus(response.status)) {
    case 'rate-limit':
      return new SaxoBrokerRateLimitError(message, method, parseRetryAfterMs(response));
    case 'timeout':
      return new SaxoBrokerTimeoutError(message, method);
    default: {
      const { code, message: venueMessage } = parseSaxoErrorInfo(bodyText);
      return new SaxoBrokerProviderError(
        message,
        response.status,
        code,
        venueMessage,
        false,
        method,
      );
    }
  }
}

export function classifySaxoBrokerNetworkError(
  error: unknown,
  context: string,
  method: SaxoHttpMethod,
): SaxoBrokerError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new SaxoBrokerTimeoutError(`Saxo request timed out (${context}): ${message}`, method);
  }
  return new SaxoBrokerProviderError(
    `Saxo network error (${context}): ${message}`,
    undefined,
    undefined,
    undefined,
    method === 'GET',
  );
}
