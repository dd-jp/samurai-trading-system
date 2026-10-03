import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { fetchWithTimeout, maskCredentials } from '../../../../shared/index.js';
import type { SaxoTradingEnvironment } from './saxo-environment.js';
import type {
  FetchLike,
  SaxoOAuthConfig as SaxoLoginConfig,
  SaxoTokenResponse,
} from './saxo-oauth.js';
import {
  requestSaxoToken,
  resolveSaxoOAuthConfig as resolveLoginConfig,
  SaxoOAuthError as SaxoLoginError,
} from './saxo-oauth.js';
import { type SaxoTokenFileRecord, tokenFilePath, writeTokenFile } from './saxo-token-file.js';

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

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

type CallbackOutcome =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'reject'; readonly page: string; readonly error: SaxoLoginError }
  | { readonly kind: 'accept'; readonly code: string };

function classifyCallback(requestUrl: URL, target: URL, expectedState: string): CallbackOutcome {
  if (requestUrl.pathname !== target.pathname) return { kind: 'ignore' };
  const state = requestUrl.searchParams.get('state');
  if (state === null || state !== expectedState) {
    return {
      kind: 'reject',
      page: 'State mismatch — refusing to log in.',
      error: new SaxoLoginError(
        'Saxo login callback: state was missing or did not match — refusing the code exchange.',
      ),
    };
  }
  const error = requestUrl.searchParams.get('error');
  if (error !== null) {
    return {
      kind: 'reject',
      page: 'Saxo login was not completed.',
      error: new SaxoLoginError(`Saxo authorize endpoint returned error=${error}`),
    };
  }
  const code = requestUrl.searchParams.get('code');
  if (code === null || code.length === 0) {
    return {
      kind: 'reject',
      page: 'Missing authorization code.',
      error: new SaxoLoginError('Saxo login callback: no code in the redirect.'),
    };
  }
  return { kind: 'accept', code };
}

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
    const outcome = classifyCallback(
      new URL(req.url ?? '/', `http://${req.headers.host ?? target.host}`),
      target,
      expectedState,
    );
    if (outcome.kind === 'ignore') {
      res.writeHead(404).end();
      return;
    }
    if (outcome.kind === 'reject') {
      res.writeHead(400, { 'content-type': 'text/plain' }).end(outcome.page);
      fail(outcome.error);
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end('Login complete — you can close this tab.');
    settle({ code: outcome.code });
  });

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

export function printSafely(line: string): void {
  console.log(maskCredentials(line));
}

function browserOpener(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  return platform === 'win32' ? 'start' : 'xdg-open';
}

async function openInBrowser(url: string): Promise<void> {
  const opener = browserOpener(process.platform);
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
      child.once('error', rejectPromise);
      child.once('spawn', () => {
        child.unref();
        resolvePromise();
      });
    });
  } catch {}
}

export interface RunLoginDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  waitForCallbackImpl?: typeof waitForCallback;
  openBrowser?: (url: string) => Promise<void>;
  state?: () => string;
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
    server.closeAllConnections();
    server.close();
  }

  const now = (deps.now ?? (() => new Date()))();
  const token = await exchangeAuthorizationCode(config, callback.code, now, fetchImpl);
  const path = deps.tokenPath ?? tokenFilePath(environment);
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
