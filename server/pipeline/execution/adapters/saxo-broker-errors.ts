/**
 * Typed error hierarchy for `SaxoHttpBrokerClient` — the three-class shape
 * transport-layer-spec.md's shared conventions prescribe, built on
 * `venue-errors.ts`. What stays Saxo-specific: the error body is
 * `{ErrorInfo: {ErrorCode, Message}}` (nested, string code) where Alpaca's is
 * `{code, message}` (flat, numeric), and a status-less GET failure is
 * retryable here (#1223) where Alpaca's never is.
 */

import {
  classifyStatus,
  isServerErrorStatus,
  isTimeoutAbort,
  parseRetryAfterMs,
  truncateForError,
} from '../../../shared/index.js';
import {
  type HttpMethod,
  isRetrySafeMethod,
  VenueRateLimitError,
  VenueTimeoutError,
} from './venue-errors.js';

/** See `HttpMethod` (venue-errors.ts); `SaxoHttpBrokerClient.request` types `init.method` as this. */
export type SaxoHttpMethod = HttpMethod;

export class SaxoBrokerTimeoutError extends VenueTimeoutError {
  constructor(message: string, method: SaxoHttpMethod) {
    super('SaxoBrokerTimeoutError', message, method);
  }
}

export class SaxoBrokerRateLimitError extends VenueRateLimitError {
  constructor(message: string, method: SaxoHttpMethod, retryAfterMs?: number) {
    super('SaxoBrokerRateLimitError', message, method, retryAfterMs);
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
 * the same conservative way it always has been. GET is the only verb that
 * sets it `true` (#1223's own allowlist); this ticket does not widen it —
 * see `classifySaxoBrokerNetworkError`'s doc comment for why DELETE stays
 * out of it even though DELETE's timeout retry (pre-existing on `origin/main`,
 * unconditional on every verb, and merely preserved rather than added by
 * #1273 — see `isRetryableSaxoBrokerError` below) is allowed to differ.
 *
 * `method` (#1273) is separate from `retryableTransportFailure`: it is set
 * only when `status` is also set (a real 5xx response, from
 * `classifySaxoBrokerResponse`) and feeds `isRetryableSaxoBrokerError`'s
 * verb gate for that case. It is `undefined` on every status-less
 * construction, where `retryableTransportFailure` already carries the verb
 * decision made at construction time.
 */
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

/**
 * Timeout | RateLimit | 5xx | (status-less transport failure on a GET).
 * A 409 is deliberately NOT retryable: retrying inside the window re-earns
 * the 409. A status-less `SaxoBrokerProviderError` (no response was ever
 * received — #1223) defers entirely to `retryableTransportFailure`, which is
 * `true` only when the failing request was a GET.
 *
 * Timeout, rate-limit and a real 5xx response are, since #1273, gated by
 * `isRetrySafeMethod` (venue-errors.ts) instead of firing unconditionally — a
 * `SaxoBrokerTimeoutError` or `SaxoBrokerRateLimitError` always carries the
 * request's verb, and a 5xx `SaxoBrokerProviderError` carries it whenever
 * `status` does (every real construction site sets both together);
 * `isServerErrorStatus` still gates the status range first, so a non-5xx
 * status (401, 404, 409, …) stays non-retryable regardless of verb.
 *
 * The allowlist is shared with Alpaca, but DELETE's place on it was earned
 * HERE: doc 43:33 measured a repeat `DELETE .../orders/{OrderId}` on an
 * already-cancelled or unknown id answering `404 {"ErrorInfo":{"ErrorCode":
 * "OrderNotFound"}}`, not a second cancel. That is a looser question than
 * `classifySaxoBrokerNetworkError`'s status-less allowlist (GET only): these
 * three shapes always mean *something* answered, a status-less failure means
 * nothing did.
 */
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

/**
 * `method` (#1273, required for the same reason #1223 made it required on
 * `classifySaxoBrokerNetworkError`): the verb of the request whose response
 * this is, so a 408/504 (`SaxoBrokerTimeoutError`), 429
 * (`SaxoBrokerRateLimitError`) or 5xx (`SaxoBrokerProviderError`) all carry
 * enough to be gated by `isRetrySafeMethod` instead of retrying
 * unconditionally.
 */
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

/**
 * `method` is the verb of the request that failed to get a response at all —
 * required, not defaulted, so a new call site must say what it did rather
 * than silently inheriting a safe-looking default (#1223). Only GET marks
 * the resulting status-less `SaxoBrokerProviderError` retryable via
 * `retryableTransportFailure`; every other verb, including DELETE, does not.
 *
 * DELETE stays out of `retryableTransportFailure` deliberately, even though
 * cancel's DELETE timeout retry is allowed below (#1273's `isRetrySafeMethod`)
 * — that retry already existed on `origin/main` (every verb's timeout was
 * unconditionally retryable pre-#1273) and is *preserved*, not newly added,
 * by this ticket; #1273 was not asked to *add* a status-less retry cancel
 * does not have today. A status-less network failure and a timeout carry the
 * identical ambiguity — neither says whether the venue ever saw the
 * request — so there is no safety distinction between them here, only a
 * scope one: widening this branch to match is a real behavior change this
 * ticket was not asked to make, and is left for a follow-up to decide with
 * its own review, not folded in silently.
 */
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
