const REQUEST_TIMEOUT_MS = 10_000;

export type FetchFailure = 'timeout' | 'network';

// the caught error is discarded on purpose: fetch failures can embed the URL, and the URL carries the api token
export async function fetchTokenUrl(
  fetchImpl: typeof fetch,
  url: URL,
): Promise<Response | FetchFailure> {
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    return error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
  }
}
