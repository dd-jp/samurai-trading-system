/**
 * `AbortController`-based timeout wrapper around the global `fetch`
 * (issue #271, transport-layer-spec.md "Shared Transport Conventions" —
 * "every request timeout is pure boilerplate"). Every real HTTP client the
 * transport layer introduces (Alpaca, Polygon, Telegram, and the promoted
 * `AnthropicMessagesClient`) uses this rather than hand-rolling its own
 * `setTimeout`/`AbortController` pairing.
 */

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
