/**
 * Typed error hierarchy for `SaxoHttpBrokerClient` — the same three-class
 * shape as `alpaca-broker-errors.ts` (transport-layer-spec.md's shared
 * conventions), kept separate because Saxo's error body is
 * `{ErrorInfo: {ErrorCode, Message}}` (nested, string code) where Alpaca's is
 * `{code, message}` (flat, numeric), and `readErrorBody` only reads the latter.
 */

import {
  classifyStatus,
  isServerErrorStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
  truncateForError,
} from '../../../shared/index.js';

export class SaxoBrokerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaxoBrokerTimeoutError';
  }
}

export class SaxoBrokerRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'SaxoBrokerRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Any other upstream failure. `status`, `code` and `venueMessage` are the
 * fields `sanitizeBrokerError` reads into `BrokerError`; `code` is Saxo's
 * `ErrorInfo.ErrorCode` string (`OrderTypeNotSupported`, `OrderNotFound`, …).
 *
 * A 409 carries no body at all (VERIFIED): it is the duplicate-request guard
 * refusing an identical body + `x-request-id` inside the rolling window
 * (doc 43), and the adapter treats it as "look the order up, do not retry".
 */
export class SaxoBrokerProviderError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly venueMessage: string | undefined;

  constructor(message: string, status?: number, code?: string, venueMessage?: string) {
    super(message);
    this.name = 'SaxoBrokerProviderError';
    this.status = status;
    this.code = code;
    this.venueMessage = venueMessage;
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

/** Timeout | RateLimit | 5xx. A 409 is deliberately NOT retryable: retrying inside the window re-earns the 409. */
export function isRetryableSaxoBrokerError(error: unknown): boolean {
  if (error instanceof SaxoBrokerTimeoutError || error instanceof SaxoBrokerRateLimitError) {
    return true;
  }
  if (error instanceof SaxoBrokerProviderError) {
    return isServerErrorStatus(error.status);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Pulls `ErrorCode`/`Message` from Saxo's two documented error shapes: the
 * order envelope `{ErrorInfo: {ErrorCode, Message}, Orders: [{ErrorInfo}]}`
 * (VERIFIED on a rejected placement) and the flat `{ErrorCode, Message}` the
 * gateway uses elsewhere. A leg-level `ErrorInfo` is read when the top level
 * carries none, so a rejected related order still names its cause.
 */
export function parseSaxoErrorInfo(bodyText: string): {
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

  const candidates: unknown[] = [parsed.ErrorInfo, parsed];
  if (Array.isArray(parsed.Orders)) {
    for (const leg of parsed.Orders) {
      if (isRecord(leg)) candidates.push(leg.ErrorInfo);
    }
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const code = typeof candidate.ErrorCode === 'string' ? candidate.ErrorCode : undefined;
    const message =
      typeof candidate.Message === 'string' ? truncateForError(candidate.Message) : undefined;
    if (code !== undefined || message !== undefined) return { code, message };
  }
  return { code: undefined, message: undefined };
}

export async function classifySaxoBrokerResponse(
  response: Response,
  context: string,
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
      return new SaxoBrokerRateLimitError(message, parseRetryAfterMs(response));
    case 'timeout':
      return new SaxoBrokerTimeoutError(message);
    default: {
      const { code, message: venueMessage } = parseSaxoErrorInfo(bodyText);
      return new SaxoBrokerProviderError(message, response.status, code, venueMessage);
    }
  }
}

export function classifySaxoBrokerNetworkError(error: unknown, context: string): SaxoBrokerError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new SaxoBrokerTimeoutError(`Saxo request timed out (${context}): ${message}`);
  }
  return new SaxoBrokerProviderError(`Saxo network error (${context}): ${message}`);
}
