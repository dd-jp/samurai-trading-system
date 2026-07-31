/**
 * `AbortController`-based timeout wrapper around the global `fetch`
 * (issue #271, transport-layer-spec.md "Shared Transport Conventions" —
 * "every request timeout is pure boilerplate"). Every real HTTP client the
 * transport layer introduces (Alpaca, Polygon, Telegram, and the promoted
 * `AnthropicMessagesClient`) uses this rather than hand-rolling its own
 * `setTimeout`/`AbortController` pairing.
 *
 * If `init.signal` is set, it's combined with the timeout's own signal via
 * `AbortSignal.any` (Node >=20.3; this project's floor is Node >=24, per
 * `package.json` `engines`) so callers can still cancel in-flight requests
 * externally. The timeout aborts with a `TimeoutError` `DOMException` as its
 * `reason`, distinguishing it from a caller-initiated abort (whose default
 * reason, if the caller doesn't supply one, is an `AbortError`
 * `DOMException`) — callers composing this with `withRetry` can inspect
 * `(error as DOMException).name` / `signal.reason?.name` to tell a
 * retryable timeout from an explicit cancel that must not be retried.
 */

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}
