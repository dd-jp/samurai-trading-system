import { V2_CONTRACT_VERSION } from '@contracts';
import { describe, expect, it, vi } from 'vitest';
import { authHeaders, fetchWire } from './api.ts';

function serving(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('authHeaders', () => {
  it('sends a Bearer header only when there is a token', () => {
    expect(authHeaders(null)).toEqual({});
    expect(authHeaders('t0k')).toEqual({ Authorization: 'Bearer t0k' });
  });
});

describe('fetchWire', () => {
  it('passes the token and returns a body on the current contract', async () => {
    const body = { contract_version: V2_CONTRACT_VERSION, x: 1 };
    const fetchImpl = serving(body);
    expect(await fetchWire('/api/v2/overview', 'abc', fetchImpl)).toEqual({ kind: 'ok', body });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v2/overview', {
      headers: { Authorization: 'Bearer abc' },
      signal: undefined,
    });
  });

  it('reports the version a mismatched server claims', async () => {
    expect(await fetchWire('/u', null, serving({ contract_version: 'v0' }))).toEqual({
      kind: 'contract-mismatch',
      served: 'v0',
    });
  });

  it.each([null, { contract_version: 3 }, {}])(
    'reports no served version for the body %j',
    async (body) => {
      expect(await fetchWire('/u', null, serving(body))).toEqual({
        kind: 'contract-mismatch',
        served: null,
      });
    },
  );

  it('separates a rejected token from a failed request', async () => {
    expect(await fetchWire('/u', 'bad', serving({}, 401))).toEqual({ kind: 'unauthorized' });
    expect(await fetchWire('/u', 'ok', serving({}, 503))).toEqual({
      kind: 'failed',
      error: 'HTTP 503',
    });
    expect(await fetchWire('/u', 'ok', serving({ error: 'from is after to' }, 400))).toEqual({
      kind: 'failed',
      error: 'from is after to',
    });
  });

  it('turns a network error into a failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await fetchWire('/u', null, fetchImpl)).toEqual({ kind: 'failed', error: 'offline' });
  });
});
