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

/**
 * The HTTP verb of the request that failed, as literally passed to
 * `fetch`/`fetchWithTimeout` — `SaxoHttpBrokerClient.request`'s `init.method`
 * is typed to require one of these, so a new operation cannot omit it and
 * fall through to a default. Every error class below that can be retried
 * carries the verb of the request that produced it, and `isRetryableSaxoBrokerError`
 * consults it — see that function's doc comment for the two different
 * allowlists this type feeds (status-less transport failures vs.
 * timeout/rate-limit/5xx).
 */
export type SaxoHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * `method` (#1273) is the verb of the request that timed out — set at both
 * construction sites, the `fetchWithTimeout` deadline abort
 * (`classifySaxoBrokerNetworkError`) and a 408/504 response
 * (`classifySaxoBrokerResponse`) — so `isRetryableSaxoBrokerError` can gate
 * retry on it instead of retrying every timeout unconditionally, which is
 * what let a timed-out placement POST retry before this ticket.
 */
export class SaxoBrokerTimeoutError extends Error {
  readonly method: SaxoHttpMethod;

  constructor(message: string, method: SaxoHttpMethod) {
    super(message);
    this.name = 'SaxoBrokerTimeoutError';
    this.method = method;
  }
}

/** `method` (#1273): see `SaxoBrokerTimeoutError`'s doc comment — same reason, same gate. */
export class SaxoBrokerRateLimitError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly method: SaxoHttpMethod;

  constructor(message: string, method: SaxoHttpMethod, retryAfterMs?: number) {
    super(message);
    this.name = 'SaxoBrokerRateLimitError';
    this.method = method;
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
 * the same conservative way it always has been. GET is the only verb that
 * sets it `true` (#1223's own allowlist); this ticket does not widen it —
 * see `classifySaxoBrokerNetworkError`'s doc comment for why DELETE stays
 * out of it even though DELETE's timeout retry (pre-existing on `origin/main`,
 * unconditional on every verb, and merely preserved rather than added by
 * #1273 — see `isRetrySafeSaxoMethod` below) is allowed to differ.
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
 * Verified-safe-to-repeat verbs for a Saxo timeout, rate-limit or 5xx (#1273)
 * — a genuinely different, and looser, question than
 * `classifySaxoBrokerNetworkError`'s status-less-failure allowlist (GET
 * only), because these three shapes always mean *something* answered (a
 * deadline was hit, or a real response with a status came back), where a
 * status-less failure means nothing did.
 *
 * The check is keyed on the VERB alone, not on the operation behind it —
 * `cancelOrder` is what earned DELETE's place on this list (doc 43:33
 * measured a repeat order-cancel as venue-idempotent: `DELETE
 * .../orders/{OrderId}` on an already-cancelled or unknown id answers `404
 * {"ErrorInfo":{"ErrorCode":"OrderNotFound"}}`, not a second cancel or an
 * error that hides one), but the admission itself is "this verb is safe",
 * not "this specific call site was proven safe". A second, future DELETE
 * operation would inherit retry from being a DELETE, with no independent
 * proof of its own idempotence — the same verb-declaration-not-safety-audit
 * posture #1223 took for GET (see that ticket's `SaxoHttpMethod` history).
 * `cancelOrder` (`saxo-http-client.ts`) is the only DELETE call site today,
 * so nothing is live; a reviewer adding a second one is the point where this
 * allowlist's verb-only admission actually gets tested.
 *
 * GET is on the list for a narrower reason that needs no per-operation
 * evidence at all: repeating a read cannot mutate venue state, by HTTP
 * semantics, regardless of which read it is.
 *
 * PUT and PATCH are left off — not because they are unsafe (PUT is
 * idempotent by HTTP semantics too), but because no Saxo call site uses
 * either today and nothing has verified one venue-idempotent the way doc
 * 43:33 did for DELETE; excluding them is "unverified, so unlisted", not a
 * claim that they would fail. POST is excluded on principle regardless of
 * status or verification: `placeOrder` is the one operation an accidental
 * duplicate is expensive for (a second live order, doc 43), so this
 * allowlist admits verbs, not verb-plus-status-code carve-outs — a POST 429
 * (doc 43:13 shows it firing before any semantic check, so probably no order
 * exists yet) is excluded for the same reason a POST 5xx is: uniformity, not
 * a claim that every excluded case is independently dangerous.
 */
function isRetrySafeSaxoMethod(method: SaxoHttpMethod | undefined): boolean {
  return method === 'GET' || method === 'DELETE';
}

/**
 * Timeout | RateLimit | 5xx | (status-less transport failure on a GET).
 * A 409 is deliberately NOT retryable: retrying inside the window re-earns
 * the 409. A status-less `SaxoBrokerProviderError` (no response was ever
 * received — #1223) defers entirely to `retryableTransportFailure`, which is
 * `true` only when the failing request was a GET.
 *
 * Timeout, rate-limit and a real 5xx response are, since #1273, gated by
 * `isRetrySafeSaxoMethod` instead of firing unconditionally — a `SaxoBrokerTimeoutError`
 * or `SaxoBrokerRateLimitError` always carries the request's verb, and a 5xx
 * `SaxoBrokerProviderError` carries it whenever `status` does (every real
 * construction site sets both together); `isServerErrorStatus` still gates
 * the status range first, so a non-5xx status (401, 404, 409, …) stays
 * non-retryable regardless of verb.
 */
export function isRetryableSaxoBrokerError(error: unknown): boolean {
  if (error instanceof SaxoBrokerTimeoutError || error instanceof SaxoBrokerRateLimitError) {
    return isRetrySafeSaxoMethod(error.method);
  }
  if (error instanceof SaxoBrokerProviderError) {
    if (error.status !== undefined) {
      return isServerErrorStatus(error.status) && isRetrySafeSaxoMethod(error.method);
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
 * enough to be gated by `isRetrySafeSaxoMethod` instead of retrying
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
 * cancel's DELETE timeout retry is allowed below (#1273's `isRetrySafeSaxoMethod`)
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
