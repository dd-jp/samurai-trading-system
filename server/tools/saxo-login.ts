/**
 * One-time operator login for Saxo OpenAPI (#1522) — `npm run saxo:login --
 * --env sim|live`. Runs the Authorization Code Grant
 * (developer.saxo/openapi/learn/oauth-authorization-code-grant) once per
 * environment and saves the resulting access/refresh tokens to a
 * gitignored, owner-only file. The saved session is what the orchestrator's
 * refresher renews from (#1523, adapters/saxo-token-source.ts); the developer
 * portal's 24-hour SIM-only token remains a fallback for an operator who has
 * not run this command, and is the only credential that ever existed before
 * it.
 *
 * Every line this command prints goes through `printSafely`, which routes
 * through the shared `maskCredentials` redaction pass (the same one
 * `safe-log.ts` uses for upstream-controlled text) — belt-and-braces on top
 * of never constructing a token/secret-bearing string for print in the
 * first place.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { SaxoTradingEnvironment } from '../pipeline/execution/adapters/saxo-http-client.js';
import type {
  FetchLike,
  SaxoOAuthConfig as SaxoLoginConfig,
  SaxoTokenResponse,
} from '../pipeline/execution/adapters/saxo-oauth.js';
import {
  requestSaxoToken,
  resolveSaxoOAuthConfig as resolveLoginConfig,
  SaxoOAuthError as SaxoLoginError,
} from '../pipeline/execution/adapters/saxo-oauth.js';
import type { SaxoTokenFileRecord } from '../pipeline/execution/adapters/saxo-token-file.js';
import { tokenFilePath, writeTokenFile } from '../pipeline/execution/adapters/saxo-token-file.js';
import { fetchWithTimeout, maskCredentials } from '../shared/index.js';

/**
 * The token endpoint, the config resolution and the token FILE all moved to
 * `pipeline/execution/adapters/` for #1523: the refresher that keeps the
 * session alive runs inside the orchestrator and must not import this CLI.
 * They are re-exported because this module's callers (and its tests) still
 * spell them this way.
 */
export {
  type FetchLike,
  resolveLoginConfig,
  type SaxoLoginConfig,
  SaxoLoginError,
  type SaxoTokenFileRecord,
  type SaxoTokenResponse,
  tokenFilePath,
  writeTokenFile,
};

const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

/** Loopback only (review round 1, finding 7) — a redirect URI host of `0.0.0.0` (or any other) would bind the code-receiving listener on every interface */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    throw new SaxoLoginError(
      `Saxo login: redirect URI host must be loopback (127.0.0.1/localhost), got "${target.hostname}" — refusing to bind a code-receiving listener on it.`,
    );
  }
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

  // `listen` failures (EADDRINUSE, EACCES, ...) are emitted asynchronously
  // on the server, not thrown from `listen()` itself — without this handler
  // one is an uncaught exception that `runLogin`'s try/catch never sees
  // (review round 1, finding 3)
  server.on('error', (cause) => {
    fail(
      new SaxoLoginError(
        `Saxo login callback server failed to start on ${redirectUri}: ${maskCredentials(
          cause instanceof Error ? cause.message : String(cause),
        )}`,
      ),
    );
  });

  const port = target.port === '' ? 80 : Number(target.port);
  server.listen(port, target.hostname);
  return { server, result };
}

/**
 * The authorization-code half of the token endpoint. The refresh half is the
 * refresher's (#1523); both post to the same endpoint under the same Basic
 * auth and the same 200-or-201 rule, so they share one implementation
 * (`requestSaxoToken`, saxo-oauth.ts).
 */
export async function exchangeAuthorizationCode(
  config: Pick<SaxoLoginConfig, 'tokenUrl' | 'appKey' | 'appSecret' | 'redirectUri'>,
  code: string,
  now: Date,
  fetchImpl: FetchLike,
): Promise<SaxoTokenResponse> {
  return requestSaxoToken(
    config,
    { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri },
    now,
    fetchImpl,
  );
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

/** Read-only proof call (#1522 AC3) — reports only success/failure and non-secret identity fields, never the token */
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

/** Routes every printed line through `maskCredentials` — see the module doc comment */
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
    // (no `open`/`xdg-open`) still lets the operator complete the login
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
  /** Overrides `tokenFilePath(environment)` — tests use this to sandbox the write under a temp directory instead of the real repo-root-anchored path */
  tokenPath?: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a single sequential auth flow (resolve deps, open browser, await callback, exchange code, write token, verify) where each step's `deps.x ?? default` is an independent fallback, not nested logic; splitting the steps into sub-functions would risk silently reordering a real OAuth login flow for no readability gain.
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
    // `closeAllConnections` drops any socket still open (an abandoned
    // browser tab) so `close()` doesn't wait on it — see the PR body's
    // recorded finding 5 for the still-open gap (no listener timeout)
    server.closeAllConnections();
    server.close();
  }

  const now = (deps.now ?? (() => new Date()))();
  const token = await exchangeAuthorizationCode(config, callback.code, now, fetchImpl);
  const path = deps.tokenPath ?? tokenFilePath(environment);
  // `loggedInAt` is this run's own timestamp, never carried over from a prior
  // file (#1524) — a manual login is exactly the event it records
  writeTokenFile(path, {
    ...token,
    environment,
    obtainedAt: now.toISOString(),
    loggedInAt: now.toISOString(),
  });
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
    throw new SaxoLoginError('Usage: npm run saxo:login -- --env sim|live');
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
