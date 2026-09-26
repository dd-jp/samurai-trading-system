import { V2_CONTRACT_VERSION } from '@contracts';

export type FetchOutcome<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'contract-mismatch'; readonly served: string | null }
  | { readonly kind: 'failed'; readonly error: string };

export function authHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

function servedVersion(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const version = (body as { contract_version?: unknown }).contract_version;
  return typeof version === 'string' ? version : null;
}

async function readWire<T>(response: Response): Promise<FetchOutcome<T>> {
  if (response.status === 401) return { kind: 'unauthorized' };
  if (!response.ok) return { kind: 'failed', error: `HTTP ${response.status}` };
  const body: unknown = await response.json();
  const served = servedVersion(body);
  if (served !== V2_CONTRACT_VERSION) return { kind: 'contract-mismatch', served };
  return { kind: 'ok', body: body as T };
}

export async function fetchWire<T>(
  url: string,
  token: string | null,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<FetchOutcome<T>> {
  try {
    return await readWire<T>(await fetchImpl(url, { headers: authHeaders(token), signal }));
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
