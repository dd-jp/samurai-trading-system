/**
 * One-time operator login for Saxo OpenAPI (#1522) — `yarn saxo:login --env
 * sim|live`. Runs the Authorization Code Grant
 * (developer.saxo/openapi/learn/oauth-authorization-code-grant) once per
 * environment and saves the resulting access/refresh tokens to a
 * gitignored, owner-only file. Today's only working credential is the
 * developer portal's 24-hour SIM-only token (saxo-http-client.ts) — this
 * command is what makes a LIVE token obtainable at all, and what replaces
 * hand-copying the portal token for SIM.
 *
 * Never handles a real login itself — the callback server, code exchange
 * and verification below all run, but only ever against a fake token
 * endpoint in tests. A real SIM/live run is the operator's, by hand.
 *
 * Every line this command prints goes through `printSafely`, which routes
 * through the shared `maskCredentials` redaction pass (the same one
 * `safe-log.ts` uses for upstream-controlled text) — belt-and-braces on top
 * of never constructing a token/secret-bearing string for print in the
 * first place.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  SAXO_CREDENTIAL_ENV_VARS,
  SAXO_GATEWAY_URLS,
  type SaxoTradingEnvironment,
} from '../pipeline/execution/adapters/saxo-http-client.js';
import { fetchWithTimeout, maskCredentials } from '../shared/index.js';

export class SaxoLoginError extends Error {}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REDIRECT_URI = 'http://localhost:8080/callback';

/**
 * Both Saxo apps register the same localhost redirect (#1522's ticket
 * body); the environment picks which authorize/token host it points at.
 */
const DEFAULT_AUTH_URLS: Readonly<Record<SaxoTradingEnvironment, string>> = {
  sim: 'https://sim.logonvalidation.net/authorize',
  live: 'https://live.logonvalidation.net/authorize',
};
const DEFAULT_TOKEN_URLS: Readonly<Record<SaxoTradingEnvironment, string>> = {
  sim: 'https://sim.logonvalidation.net/token',
  live: 'https://live.logonvalidation.net/token',
};

const APP_CREDENTIAL_ENV_VARS: Readonly<
  Record<SaxoTradingEnvironment, { appKey: string; appSecret: string }>
> = {
  sim: { appKey: 'SAXO_SIM_APP_KEY', appSecret: 'SAXO_SIM_APP_SECRET' },
  live: { appKey: 'SAXO_LIVE_APP_KEY', appSecret: 'SAXO_LIVE_APP_SECRET' },
};

export interface SaxoLoginConfig {
  environment: SaxoTradingEnvironment;
  appKey: string;
  appSecret: string;
  authUrl: string;
  tokenUrl: string;
  redirectUri: string;
  gatewayBaseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function resolveLoginConfig(
  environment: SaxoTradingEnvironment,
  env: NodeJS.ProcessEnv = process.env,
): SaxoLoginConfig {
  const credNames = APP_CREDENTIAL_ENV_VARS[environment];
  const appKey = readEnv(env, credNames.appKey);
  const appSecret = readEnv(env, credNames.appSecret);
  if (appKey === undefined) {
    throw new SaxoLoginError(`${credNames.appKey} is not set. Provide it via .env.local.`);
  }
  if (appSecret === undefined) {
    throw new SaxoLoginError(`${credNames.appSecret} is not set. Provide it via .env.local.`);
  }
  const upper = environment.toUpperCase();
  const authUrl = readEnv(env, `SAXO_${upper}_AUTH_URL`) ?? DEFAULT_AUTH_URLS[environment];
  const tokenUrl = readEnv(env, `SAXO_${upper}_TOKEN_URL`) ?? DEFAULT_TOKEN_URLS[environment];
  const redirectUri = readEnv(env, `SAXO_${upper}_REDIRECT_URI`) ?? DEFAULT_REDIRECT_URI;
  const gatewayNames = SAXO_CREDENTIAL_ENV_VARS[environment];
  const gatewayBaseUrl = readEnv(env, gatewayNames.gateway) ?? SAXO_GATEWAY_URLS[environment];
  return { environment, appKey, appSecret, authUrl, tokenUrl, redirectUri, gatewayBaseUrl };
}

export function randomState(): string {
  return randomBytes(24).toString('hex');
}

export function buildAuthorizeUrl(config: SaxoLoginConfig, state: string): string {
  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.appKey);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', config.redirectUri);
  return url.toString();
}

export interface CallbackResult {
  code: string;
}

/**
 * Listens on the redirect URI's own host:port and path. Resolves only on a
 * `state` that matches exactly — a missing or mismatched `state` is refused
 * here, before `runLogin` ever reaches the token exchange (#1522 AC2).
 */
export function waitForCallback(
  redirectUri: string,
  expectedState: string,
): { server: Server; result: Promise<CallbackResult> } {
  const target = new URL(redirectUri);
  let settle: (result: CallbackResult) => void;
  let fail: (error: Error) => void;
  const result = new Promise<CallbackResult>((resolvePromise, rejectPromise) => {
    settle = resolvePromise;
    fail = rejectPromise;
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? target.host}`);
    if (requestUrl.pathname !== target.pathname) {
      res.writeHead(404).end();
      return;
    }
    const state = requestUrl.searchParams.get('state');
    if (state === null || state !== expectedState) {
      res
        .writeHead(400, { 'content-type': 'text/plain' })
        .end('State mismatch — refusing to log in.');
      fail(
        new SaxoLoginError(
          'Saxo login callback: state was missing or did not match — refusing the code exchange.',
        ),
      );
      return;
    }
    const error = requestUrl.searchParams.get('error');
    if (error !== null) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Saxo login was not completed.');
      fail(new SaxoLoginError(`Saxo authorize endpoint returned error=${error}`));
      return;
    }
    const code = requestUrl.searchParams.get('code');
    if (code === null || code.length === 0) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing authorization code.');
      fail(new SaxoLoginError('Saxo login callback: no code in the redirect.'));
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end('Login complete — you can close this tab.');
    settle({ code });
  });

  const port = target.port === '' ? 80 : Number(target.port);
  server.listen(port, target.hostname);
  return { server, result };
}

export interface SaxoTokenResponse {
  accessToken: string;
  refreshToken: string;
  /** ISO instant, derived from the response's `expires_in` (measured 1200 s live, 2026-09-14 — never hardcoded). */
  accessTokenExpiresAt: string;
  /** ISO instant, derived from the response's `refresh_token_expires_in` (measured 3600 s live, 2026-09-14 — never hardcoded). */
  refreshTokenExpiresAt: string;
}

/**
 * HTTP Basic AppKey:AppSecret at the token URL. Both 200 and 201 count as
 * success — the live gateway measured 201 on 2026-09-14 (#1522's dispatch
 * facts); the docs' example shows 200.
 */
export async function exchangeAuthorizationCode(
  config: Pick<SaxoLoginConfig, 'tokenUrl' | 'appKey' | 'appSecret' | 'redirectUri'>,
  code: string,
  now: Date,
  fetchImpl: FetchLike,
): Promise<SaxoTokenResponse> {
  const basic = Buffer.from(`${config.appKey}:${config.appSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });
  let response: Response;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new SaxoLoginError(
      `Saxo token exchange failed: network error — ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new SaxoLoginError(
      `Saxo token exchange failed: response body could not be read — ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  // Masked even though a token-endpoint error body is not expected to echo
  // the app secret back — defense in depth, matching saxo-http-client.ts's
  // own error-body posture.
  if (response.status !== 200 && response.status !== 201) {
    throw new SaxoLoginError(
      `Saxo token exchange failed: HTTP ${response.status} — ${maskCredentials(text).slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaxoLoginError('Saxo token exchange failed: response body was not valid JSON.');
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.access_token !== 'string' ||
    parsed.access_token.length === 0 ||
    typeof parsed.refresh_token !== 'string' ||
    parsed.refresh_token.length === 0 ||
    typeof parsed.expires_in !== 'number' ||
    !Number.isFinite(parsed.expires_in) ||
    typeof parsed.refresh_token_expires_in !== 'number' ||
    !Number.isFinite(parsed.refresh_token_expires_in)
  ) {
    throw new SaxoLoginError(
      'Saxo token exchange failed: response body is missing access_token/refresh_token/expires_in/refresh_token_expires_in.',
    );
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessTokenExpiresAt: new Date(now.getTime() + parsed.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(
      now.getTime() + parsed.refresh_token_expires_in * 1000,
    ).toISOString(),
  };
}

export function tokenFilePath(environment: SaxoTradingEnvironment): string {
  return resolve(`data/saxo-tokens/${environment}.json`);
}

export interface SaxoTokenFileRecord extends SaxoTokenResponse {
  environment: SaxoTradingEnvironment;
  obtainedAt: string;
}

/** Directory `0o700`, file `0o600` — owner-read-only, matching `rotating-file-sink.ts`'s posture for the most sensitive file this process writes. */
export function writeTokenFile(path: string, record: SaxoTokenFileRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

const IDENTITY_FIELDS = ['UserId', 'ClientKey', 'Name', 'Culture', 'Language'] as const;

export type SaxoIdentitySummary = Partial<Record<(typeof IDENTITY_FIELDS)[number], string>>;

function pickIdentityFields(body: Record<string, unknown>): SaxoIdentitySummary {
  const out: SaxoIdentitySummary = {};
  for (const field of IDENTITY_FIELDS) {
    const value = body[field];
    if (typeof value === 'string') out[field] = value;
  }
  return out;
}

export type SaxoVerification =
  | { ok: true; identity: SaxoIdentitySummary }
  | { ok: false; status?: number };

/** Read-only proof call (#1522 AC3) — reports only success/failure and non-secret identity fields, never the token. */
export async function verifyToken(
  gatewayBaseUrl: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<SaxoVerification> {
  let response: Response;
  try {
    response = await fetchImpl(`${gatewayBaseUrl.replace(/\/+$/, '')}/port/v1/users/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false, status: response.status };
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return { ok: false, status: response.status };
  }
  return { ok: true, identity: isRecord(body) ? pickIdentityFields(body) : {} };
}

/** Routes every printed line through `maskCredentials` — see the module doc comment. */
export function printSafely(line: string): void {
  console.log(maskCredentials(line));
}

async function openInBrowser(url: string): Promise<void> {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
      child.once('error', rejectPromise);
      child.once('spawn', () => {
        child.unref();
        resolvePromise();
      });
    });
  } catch {
    // Best-effort only. The URL is always printed above, so a headless host
    // (no `open`/`xdg-open`) still lets the operator complete the login.
  }
}

export interface RunLoginDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  waitForCallbackImpl?: typeof waitForCallback;
  openBrowser?: (url: string) => Promise<void>;
  state?: () => string;
}

export async function runLogin(
  environment: SaxoTradingEnvironment,
  deps: RunLoginDeps = {},
): Promise<void> {
  const config = resolveLoginConfig(environment, deps.env ?? process.env);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike =
    deps.fetchImpl ?? ((url, init) => fetchWithTimeout(url, init, timeoutMs));
  const wait = deps.waitForCallbackImpl ?? waitForCallback;
  const state = (deps.state ?? randomState)();
  const authorizeUrl = buildAuthorizeUrl(config, state);

  printSafely(`Saxo ${environment} login — open this URL and sign in:`);
  printSafely(authorizeUrl);
  await (deps.openBrowser ?? openInBrowser)(authorizeUrl);

  const { server, result } = wait(config.redirectUri, state);
  let callback: CallbackResult;
  try {
    callback = await result;
  } finally {
    server.close();
  }

  const now = (deps.now ?? (() => new Date()))();
  const token = await exchangeAuthorizationCode(config, callback.code, now, fetchImpl);
  const path = tokenFilePath(environment);
  writeTokenFile(path, { ...token, environment, obtainedAt: now.toISOString() });
  printSafely(`Token saved to ${path} (mode 0600, gitignored).`);

  const verification = await verifyToken(config.gatewayBaseUrl, token.accessToken, fetchImpl);
  if (verification.ok) {
    printSafely(
      `Verified: GET port/v1/users/me succeeded. ${JSON.stringify(verification.identity)}`,
    );
  } else {
    const suffix = verification.status === undefined ? '' : ` (HTTP ${verification.status})`;
    printSafely(`Verification FAILED: GET port/v1/users/me did not succeed${suffix}.`);
  }
}

export function parseEnvArg(argv: readonly string[]): SaxoTradingEnvironment {
  const index = argv.indexOf('--env');
  const value = index === -1 ? undefined : argv[index + 1];
  if (value !== 'sim' && value !== 'live') {
    throw new SaxoLoginError('Usage: yarn saxo:login --env sim|live');
  }
  return value;
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  try {
    const environment = parseEnvArg(process.argv.slice(2));
    await runLogin(environment);
  } catch (error) {
    printSafely(
      `saxo:login failed: ${error instanceof Error ? maskCredentials(error.message) : String(error)}`,
    );
    process.exitCode = 1;
  }
}
