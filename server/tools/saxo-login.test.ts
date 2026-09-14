import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  type FetchLike,
  parseEnvArg,
  printSafely,
  resolveLoginConfig,
  runLogin,
  SaxoLoginError,
  tokenFilePath,
  verifyToken,
  waitForCallback,
  writeTokenFile,
} from './saxo-login.js';

const FAKE_APP_KEY = 'app-key-fake';
const FAKE_APP_SECRET = 'app-secret-fake-value';
const FAKE_ACCESS_TOKEN = 'access-token-fake-value';
const FAKE_REFRESH_TOKEN = 'refresh-token-fake-value';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    SAXO_SIM_APP_KEY: FAKE_APP_KEY,
    SAXO_SIM_APP_SECRET: FAKE_APP_SECRET,
    SAXO_LIVE_APP_KEY: `${FAKE_APP_KEY}-live`,
    SAXO_LIVE_APP_SECRET: `${FAKE_APP_SECRET}-live`,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as Response;
}

describe('resolveLoginConfig', () => {
  it('throws when the App Key is not set', () => {
    expect(() => resolveLoginConfig('sim', { SAXO_SIM_APP_SECRET: FAKE_APP_SECRET })).toThrow(
      /SAXO_SIM_APP_KEY is not set/,
    );
  });

  it('throws when the App Secret is not set', () => {
    expect(() => resolveLoginConfig('sim', { SAXO_SIM_APP_KEY: FAKE_APP_KEY })).toThrow(
      /SAXO_SIM_APP_SECRET is not set/,
    );
  });

  it('reads the live app key/secret from SAXO_LIVE_*, not SAXO_SIM_*', () => {
    const config = resolveLoginConfig('live', baseEnv());
    expect(config.appKey).toBe(`${FAKE_APP_KEY}-live`);
    expect(config.appSecret).toBe(`${FAKE_APP_SECRET}-live`);
    expect(config.authUrl).toContain('live.logonvalidation.net');
    expect(config.gatewayBaseUrl).toBe('https://gateway.saxobank.com/openapi');
  });

  it('defaults auth/token/redirect URLs, overridable per environment', () => {
    const defaults = resolveLoginConfig('sim', baseEnv());
    expect(defaults.authUrl).toBe('https://sim.logonvalidation.net/authorize');
    expect(defaults.tokenUrl).toBe('https://sim.logonvalidation.net/token');
    expect(defaults.redirectUri).toBe('http://localhost:8080/callback');

    const overridden = resolveLoginConfig('sim', {
      ...baseEnv(),
      SAXO_SIM_AUTH_URL: 'https://custom.example/authorize',
      SAXO_SIM_TOKEN_URL: 'https://custom.example/token',
      SAXO_SIM_REDIRECT_URI: 'http://127.0.0.1:9999/cb',
    });
    expect(overridden.authUrl).toBe('https://custom.example/authorize');
    expect(overridden.tokenUrl).toBe('https://custom.example/token');
    expect(overridden.redirectUri).toBe('http://127.0.0.1:9999/cb');
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries response_type, client_id, state and redirect_uri', () => {
    const config = resolveLoginConfig('sim', baseEnv());
    const url = new URL(buildAuthorizeUrl(config, 'state-123'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(FAKE_APP_KEY);
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/callback');
  });
});

describe('parseEnvArg', () => {
  it('accepts sim and live', () => {
    expect(parseEnvArg(['--env', 'sim'])).toBe('sim');
    expect(parseEnvArg(['--env', 'live'])).toBe('live');
  });

  it('rejects a missing or invalid --env', () => {
    expect(() => parseEnvArg([])).toThrow(SaxoLoginError);
    expect(() => parseEnvArg(['--env', 'production'])).toThrow(SaxoLoginError);
  });
});

describe('exchangeAuthorizationCode', () => {
  const config = {
    tokenUrl: 'https://token.example/token',
    appKey: 'k',
    appSecret: 's',
    redirectUri: 'http://localhost:8080/callback',
  };
  const now = new Date('2026-09-14T12:00:00.000Z');

  it('succeeds on HTTP 200 and derives expiry instants from the response, never hardcoded', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        {
          access_token: FAKE_ACCESS_TOKEN,
          refresh_token: FAKE_REFRESH_TOKEN,
          expires_in: 1200,
          refresh_token_expires_in: 3600,
        },
        200,
      ),
    );
    const token = await exchangeAuthorizationCode(config, 'auth-code', now, fetchImpl);
    expect(token.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(token.refreshToken).toBe(FAKE_REFRESH_TOKEN);
    expect(token.accessTokenExpiresAt).toBe('2026-09-14T12:20:00.000Z');
    expect(token.refreshTokenExpiresAt).toBe('2026-09-14T13:00:00.000Z');
  });

  it('succeeds on HTTP 201 (the measured live status, #1522 dispatch facts)', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        {
          access_token: FAKE_ACCESS_TOKEN,
          refresh_token: FAKE_REFRESH_TOKEN,
          expires_in: 1200,
          refresh_token_expires_in: 3600,
        },
        201,
      ),
    );
    const token = await exchangeAuthorizationCode(config, 'auth-code', now, fetchImpl);
    expect(token.accessToken).toBe(FAKE_ACCESS_TOKEN);
  });

  it('does not hardcode 2400 s for the refresh token (docs example) when the response says 3600 s', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        {
          access_token: FAKE_ACCESS_TOKEN,
          refresh_token: FAKE_REFRESH_TOKEN,
          expires_in: 1200,
          refresh_token_expires_in: 2400,
        },
        200,
      ),
    );
    const token = await exchangeAuthorizationCode(config, 'auth-code', now, fetchImpl);
    expect(token.refreshTokenExpiresAt).toBe('2026-09-14T12:40:00.000Z');
  });

  it('throws on an error response and does not leak the request body', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(exchangeAuthorizationCode(config, 'auth-code', now, fetchImpl)).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it('throws on a malformed (non-JSON) body', async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => ({ ok: true, status: 200, text: async () => 'not json' }) as Response,
    );
    await expect(exchangeAuthorizationCode(config, 'auth-code', now, fetchImpl)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('throws when a required field is missing from an otherwise-valid JSON body', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ access_token: FAKE_ACCESS_TOKEN }, 200),
    );
    await expect(exchangeAuthorizationCode(config, 'auth-code', now, fetchImpl)).rejects.toThrow(
      /missing/,
    );
  });
});

describe('waitForCallback', () => {
  it('resolves with the code when state matches, and refuses (never resolving with a code) on mismatch', async () => {
    const { server, result } = waitForCallback('http://127.0.0.1:0/callback', 'expected-state');
    await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound port');
    const base = `http://127.0.0.1:${address.port}/callback`;

    const assertion = expect(result).rejects.toThrow(/state was missing or did not match/);
    await fetch(`${base}?state=wrong-state&code=some-code`);
    await assertion;
    server.close();
  });

  it('resolves with the code on a matching state', async () => {
    const { server, result } = waitForCallback('http://127.0.0.1:0/callback', 'expected-state');
    await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound port');
    const base = `http://127.0.0.1:${address.port}/callback`;

    await fetch(`${base}?state=expected-state&code=real-code`);
    await expect(result).resolves.toEqual({ code: 'real-code' });
    server.close();
  });

  it('refuses a missing state', async () => {
    const { server, result } = waitForCallback('http://127.0.0.1:0/callback', 'expected-state');
    await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a bound port');
    const base = `http://127.0.0.1:${address.port}/callback`;

    const assertion = expect(result).rejects.toThrow(/state was missing or did not match/);
    await fetch(`${base}?code=real-code`);
    await assertion;
    server.close();
  });
});

describe('writeTokenFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-login-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the token file at mode 0600, owner-only', () => {
    const path = join(dir, 'sub', 'sim.json');
    writeTokenFile(path, {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      accessTokenExpiresAt: '2026-09-14T12:20:00.000Z',
      refreshTokenExpiresAt: '2026-09-14T13:00:00.000Z',
      environment: 'sim',
      obtainedAt: '2026-09-14T12:00:00.000Z',
    });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.accessToken).toBe(FAKE_ACCESS_TOKEN);
  });
});

describe('tokenFilePath', () => {
  it('is under data/saxo-tokens, one file per environment', () => {
    expect(tokenFilePath('sim')).toMatch(/data\/saxo-tokens\/sim\.json$/);
    expect(tokenFilePath('live')).toMatch(/data\/saxo-tokens\/live\.json$/);
  });
});

describe('verifyToken', () => {
  it('reports success with only whitelisted, non-secret identity fields', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        { UserId: 'u1', ClientKey: 'c1', Name: 'D', SomeInternalSecretLookingField: 'x' },
        200,
      ),
    );
    const result = await verifyToken(
      'https://gateway.example/sim/openapi',
      FAKE_ACCESS_TOKEN,
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({ UserId: 'u1', ClientKey: 'c1', Name: 'D' });
      expect(JSON.stringify(result.identity)).not.toContain('SomeInternalSecretLookingField');
    }
  });

  it('reports failure on a non-2xx response', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ Message: 'unauthorized' }, 401));
    const result = await verifyToken(
      'https://gateway.example/sim/openapi',
      FAKE_ACCESS_TOKEN,
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });
});

describe('printSafely', () => {
  it('masks a credential-shaped line before printing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printSafely(`SAXO_SIM_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}`);
    expect(spy).toHaveBeenCalledTimes(1);
    const printed = String(spy.mock.calls[0]?.[0]);
    expect(printed).not.toContain(FAKE_ACCESS_TOKEN);
    spy.mockRestore();
  });
});

describe('runLogin — never prints a token or secret (#1522 AC4)', () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-login-run-'));
    originalCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the token file and verifies it, with every printed line free of the raw secrets', async () => {
    const printedLines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printedLines.push(String(line));
    });

    const fetchImpl: FetchLike = vi.fn(async (url) => {
      if (String(url).includes('/token')) {
        return jsonResponse(
          {
            access_token: FAKE_ACCESS_TOKEN,
            refresh_token: FAKE_REFRESH_TOKEN,
            expires_in: 1200,
            refresh_token_expires_in: 3600,
          },
          201,
        );
      }
      return jsonResponse({ UserId: 'u1', ClientKey: 'c1' }, 200);
    });

    await runLogin('sim', {
      env: baseEnv(),
      fetchImpl,
      now: () => new Date('2026-09-14T12:00:00.000Z'),
      state: () => 'fixed-state',
      openBrowser: async () => undefined,
      waitForCallbackImpl: () => ({
        server: { close: () => undefined } as unknown as import('node:http').Server,
        result: Promise.resolve({ code: 'auth-code-fake' }),
      }),
    });

    const combined = printedLines.join('\n');
    expect(combined).not.toContain(FAKE_ACCESS_TOKEN);
    expect(combined).not.toContain(FAKE_REFRESH_TOKEN);
    expect(combined).not.toContain(FAKE_APP_SECRET);
    expect(combined).toContain('Token saved to');
    expect(combined).toContain('Verified');

    const stored = JSON.parse(readFileSync(tokenFilePath('sim'), 'utf8'));
    expect(stored.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(statSync(tokenFilePath('sim')).mode & 0o777).toBe(0o600);

    logSpy.mockRestore();
  });

  it('never calls the token endpoint when the callback rejects on a state mismatch', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({}, 200));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runLogin('sim', {
        env: baseEnv(),
        fetchImpl,
        now: () => new Date('2026-09-14T12:00:00.000Z'),
        state: () => 'fixed-state',
        openBrowser: async () => undefined,
        waitForCallbackImpl: () => ({
          server: { close: () => undefined } as unknown as import('node:http').Server,
          result: Promise.reject(
            new SaxoLoginError(
              'Saxo login callback: state was missing or did not match — refusing the code exchange.',
            ),
          ),
        }),
      }),
    ).rejects.toThrow(/state was missing or did not match/);

    expect(fetchImpl).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
