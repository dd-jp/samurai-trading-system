
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
