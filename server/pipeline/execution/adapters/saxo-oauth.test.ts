import { describe, expect, it, vi } from 'vitest';
import { type FetchLike, requestSaxoToken, SaxoOAuthError } from './saxo-oauth.js';

const CONFIG = {
  tokenUrl: 'https://sim.logonvalidation.test/token',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
};
const GRANT = { grant_type: 'refresh_token', refresh_token: 'test-refresh' } as const;
const NOW = new Date('2026-10-03T12:00:00.000Z');
const BODY = {
  access_token: 'test-access',
  refresh_token: 'test-refresh-2',
  expires_in: 1200,
  refresh_token_expires_in: 3600,
};

function answer(status: number, text: string): FetchLike {
  return vi.fn(async () => ({ status, text: async () => text }) as Response);
}

async function failure(fetchImpl: FetchLike): Promise<SaxoOAuthError> {
  const error: unknown = await requestSaxoToken(CONFIG, GRANT, NOW, fetchImpl).catch(
    (cause: unknown) => cause,
  );
  if (!(error instanceof SaxoOAuthError))
    throw new Error(`expected a SaxoOAuthError, got ${String(error)}`);
  return error;
}

describe('requestSaxoToken', () => {
  it('posts the grant with basic auth and returns absolute expiries', async () => {
    const fetchImpl = answer(201, JSON.stringify(BODY));

    await expect(requestSaxoToken(CONFIG, GRANT, NOW, fetchImpl)).resolves.toEqual({
      accessToken: 'test-access',
      refreshToken: 'test-refresh-2',
      accessTokenExpiresAt: '2026-10-03T12:20:00.000Z',
      refreshTokenExpiresAt: '2026-10-03T13:00:00.000Z',
    });
    expect(fetchImpl).toHaveBeenCalledWith(CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('test-app-key:test-app-secret').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=refresh_token&refresh_token=test-refresh',
    });
  });

  it('accepts HTTP 200', async () => {
    await expect(
      requestSaxoToken(CONFIG, GRANT, NOW, answer(200, JSON.stringify(BODY))),
    ).resolves.toMatchObject({ accessToken: 'test-access' });
  });

  it('names a network error', async () => {
    const error = await failure(
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    expect(error.message).toBe('Saxo token exchange failed: network error — ECONNRESET');
  });

  it('names a non-Error network failure', async () => {
    const error = await failure(
      vi.fn(async () => {
        throw 'offline';
      }),
    );
    expect(error.message).toBe('Saxo token exchange failed: network error — offline');
  });

  it('names an unreadable body with its status', async () => {
    const error = await failure(
      vi.fn(
        async () =>
          ({
            status: 200,
            text: async () => {
              throw new Error('socket closed');
            },
          }) as unknown as Response,
      ),
    );
    expect(error.message).toBe(
      'Saxo token exchange failed: response body could not be read — socket closed',
    );
    expect(error.status).toBe(200);
  });

  it('names a non-Error body read failure', async () => {
    const error = await failure(
      vi.fn(
        async () =>
          ({
            status: 200,
            text: async () => {
              throw 'gone';
            },
          }) as unknown as Response,
      ),
    );
    expect(error.message).toBe(
      'Saxo token exchange failed: response body could not be read — gone',
    );
  });

  it('refuses any other status and truncates the body to 500 characters', async () => {
    const error = await failure(answer(202, 'x'.repeat(600)));
    expect(error.message).toBe(`Saxo token exchange failed: HTTP 202 — ${'x'.repeat(500)}`);
    expect(error.status).toBe(202);
  });

  it('refuses a body that is not JSON', async () => {
    const error = await failure(answer(201, '{oops'));
    expect(error.message).toBe('Saxo token exchange failed: response body was not valid JSON.');
    expect(error.status).toBe(201);
  });

  const valid = JSON.stringify(BODY);
  it.each([
    ['null', 'null'],
    ['an empty access token', valid.replace('"test-access"', '""')],
    ['a non-string access token', valid.replace('"test-access"', '7')],
    ['an empty refresh token', valid.replace('"test-refresh-2"', '""')],
    ['a non-string refresh token', valid.replace('"test-refresh-2"', 'null')],
    ['a non-number expires_in', valid.replace('"expires_in":1200', '"expires_in":"1200"')],
    ['a non-finite expires_in', valid.replace('"expires_in":1200', '"expires_in":1e999')],
    [
      'a non-number refresh_token_expires_in',
      valid.replace('"refresh_token_expires_in":3600', '"refresh_token_expires_in":"3600"'),
    ],
    [
      'a non-finite refresh_token_expires_in',
      valid.replace('"refresh_token_expires_in":3600', '"refresh_token_expires_in":-1e999'),
    ],
  ])('refuses %s', async (_label, text) => {
    expect(text).not.toBe(valid);
    const error = await failure(answer(201, text));
    expect(error.message).toBe(
      'Saxo token exchange failed: response body is missing access_token/refresh_token/expires_in/refresh_token_expires_in.',
    );
    expect(error.status).toBe(201);
  });
});
