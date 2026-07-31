/**
 * `AbortController`-based timeout wrapper around the global `fetch`
 * (issue #271, transport-layer-spec.md "Shared Transport Conventions" —
 * "every request timeout is pure boilerplate"). Every real HTTP client the
 * transport layer introduces (Alpaca, Polygon, Telegram, and the promoted
 * `AnthropicMessagesClient`) uses this rather than hand-rolling its own
 * `setTimeout`/`AbortController` pairing. If `init.signal` is set, it's
 * combined with the timeout's own signal via `AbortSignal.any` so callers
 * can still cancel in-flight requests externally.
 */

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}
