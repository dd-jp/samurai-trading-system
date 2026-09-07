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
 *
 * `retryableTransportFailure` (#1223) is set only by
 * `classifySaxoBrokerNetworkError` for a status-less failure (`fetch`
 * rejecting rather than resolving — ECONNRESET, DNS failure, socket hangup)
 * and is meaningless once `status` is set (a response was received). It
 * defaults to `false`: a status-less error with no method context is treated
 * the same conservative way it always has been.
 */
export class SaxoBrokerProviderError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly venueMessage: string | undefined;
  readonly retryableTransportFailure: boolean;

  constructor(
    message: string,
    status?: number,
    code?: string,
    venueMessage?: string,
    retryableTransportFailure = false,
  ) {
    super(message);
    this.name = 'SaxoBrokerProviderError';
    this.status = status;
    this.code = code;
    this.venueMessage = venueMessage;
    this.retryableTransportFailure = retryableTransportFailure;
  }
}

/**
 * The HTTP verb of the request that failed, as literally passed to
 * `fetch`/`fetchWithTimeout` — `SaxoHttpBrokerClient.request`'s `init.method`
 * is typed to require one of these, so a new operation cannot omit it and
 * fall through to a default. Transport-failure retryability is scoped off
 * this value alone (#1223): GET is assumed side-effect-free by HTTP
 * semantics, and only GET retries a status-less transport failure. This is
 * verb-declaration enforcement, not a safety audit — the compiler forces
 * every call site to state its verb, it does not verify a given GET is
 * genuinely a safe read. Every other verb, including DELETE (cancel), stays
 * non-retryable by default: doc 43 records that a repeat cancel is idempotent
 * at the venue (`404 OrderNotFound`), but this ticket declines to widen
 * cancel's status-less-transport-failure behavior on that basis — it stays
 * exactly as conservative as it was before #1223 (no retry).
 */
export type SaxoHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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

/**
 * Timeout | RateLimit | 5xx | (status-less transport failure on a GET).
 * A 409 is deliberately NOT retryable: retrying inside the window re-earns
 * the 409. A status-less `SaxoBrokerProviderError` (no response was ever
 * received — #1223) defers entirely to `retryableTransportFailure`, which is
 * `true` only when the failing request was a GET; `isServerErrorStatus`
 * never fires for it since `status` is `undefined`.
 */
export function isRetryableSaxoBrokerError(error: unknown): boolean {
  if (error instanceof SaxoBrokerTimeoutError || error instanceof SaxoBrokerRateLimitError) {
    return true;
  }
  if (error instanceof SaxoBrokerProviderError) {
    if (error.status !== undefined) return isServerErrorStatus(error.status);
    return error.retryableTransportFailure;
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

/**
 * `method` is the verb of the request that failed to get a response at all —
 * required, not defaulted, so a new call site must say what it did rather
 * than silently inheriting a safe-looking default (#1223). Only GET marks
 * the resulting `SaxoBrokerProviderError` retryable; every other verb,
 * including DELETE, does not (see `SaxoHttpMethod`'s doc comment).
 */
export function classifySaxoBrokerNetworkError(
  error: unknown,
  context: string,
  method: SaxoHttpMethod,
): SaxoBrokerError {
  const message = error instanceof Error ? error.message : String(error);
  if (isTimeoutAbort(error)) {
    return new SaxoBrokerTimeoutError(`Saxo request timed out (${context}): ${message}`);
  }
  return new SaxoBrokerProviderError(
    `Saxo network error (${context}): ${message}`,
    undefined,
    undefined,
    undefined,
    method === 'GET',
  );
}
