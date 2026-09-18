import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { describeThrownSafely, sanitizeLogText, type TradingArm } from '../../shared/index.js';
import type { StoreMode } from '../../shared/store/index.js';
import { assertBindAllowed } from './bind-guard.js';
import { NULL_PROVIDER_STATUS, type ProviderStatusReader } from './provider-status.js';
import { isAuthorizedRequest } from './request-auth.js';
import { buildSnapshot } from './snapshot.js';
import type { DashboardQueryStore } from './types.js';

function renderResponderError(err: unknown): string {
  return sanitizeLogText(describeThrownSafely(err));
}

export interface DashboardServerOptions {
  port: number;
  host: string;
  store: DashboardQueryStore;
  dashboardCredential?: string | undefined;
  bundleRoot: string;
  mode: StoreMode;
  providers?: ProviderStatusReader;
}

export interface DashboardServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
} as const;

const TRADING_ARMS: readonly TradingArm[] = ['live', 'control'];

function isTradingArm(value: string): value is TradingArm {
  return (TRADING_ARMS as readonly string[]).includes(value);
}

function parseArmParam(
  searchParams: URLSearchParams,
): { ok: true; arm: TradingArm } | { ok: false; reason: string } {
  const values = searchParams.getAll('arm');
  if (values.length === 0) return { ok: true, arm: 'live' };
  if (values.length > 1) {
    return { ok: false, reason: `arm given more than once (${values.length} values)` };
  }
  const [value] = values;
  if (value !== undefined && isTradingArm(value)) return { ok: true, arm: value };
  return { ok: false, reason: `unrecognised arm '${value}' — expected 'live' or 'control'` };
}

const BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export function bundleContentType(filePath: string): string | undefined {
  return BUNDLE_CONTENT_TYPES[extname(filePath).toLowerCase()];
}

export function resolveBundlePath(root: string, urlPath: string): string | null {
  if (urlPath.includes('\0')) return null;

  const requested = urlPath.replace(/^\/+/, '');
  const target = requested === '' ? 'index.html' : requested;
  const resolvedRoot = resolvePath(root);
  const resolved = resolvePath(resolvedRoot, target);

  const rel = relative(resolvedRoot, resolved);
  if (rel === '') return null;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return resolved;
}

export function bundleDiagnostic(root: string): string | null {
  const resolvedRoot = resolvePath(root);
  const indexPath = join(resolvedRoot, 'index.html');
  let html: string;
  try {
    html = readFileSync(indexPath, 'utf8');
  } catch {
    return (
      `Dashboard bundle not found: ${indexPath} does not exist.\n` +
      'The React client is built ahead of time and served from disk (ADR-0010).\n' +
      'Run `npm run build` (or `npm run build:web`) and reload. `GET /api/snapshot` is\n' +
      'unaffected and still serving JSON.\n'
    );
  }
  if (html.includes('/src/main.tsx')) {
    return (
      `Dashboard bundle not built: ${indexPath} is the Vite SOURCE template, not a\n` +
      'build — its only script tag is `/src/main.tsx`, which this server does not\n' +
      'compile and will never serve. This is what a server started from source\n' +
      '(`tsx server/apps/service-api/index.ts`) points at; the built bundle lives\n' +
      'in `dist/client/` and is what `node dist/server/apps/service-api/index.js`\n' +
      'resolves.\n' +
      'Run `npm run build` and start from `dist/`. `GET /api/snapshot` is unaffected.\n'
    );
  }
  return null;
}

export function createDashboardServer(opts: DashboardServerOptions): DashboardServer {
  assertBindAllowed(opts.host, opts.dashboardCredential);

  const { host, store, mode } = opts;
  const bundleRoot = resolvePath(opts.bundleRoot);
  const providers = opts.providers ?? NULL_PROVIDER_STATUS;
  const requestedPort = opts.port;

  async function serveStatic(urlPath: string, res: ServerResponse) {
    const filePath = resolveBundlePath(bundleRoot, urlPath);
    const contentType = filePath === null ? undefined : bundleContentType(filePath);
    if (filePath === null || contentType === undefined) {
      await respondNotFound(res);
      return;
    }
    try {
      const body = await readFile(filePath);
      res
        .writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        })
        .end(body);
    } catch {
      await respondNotFound(res);
    }
  }

  async function respondNotFound(res: ServerResponse) {
    const diagnostic = bundleDiagnostic(bundleRoot);
    if (diagnostic !== null) {
      res
        .writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end(diagnostic);
      return;
    }
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'not found' }));
  }

  function handleSnapshotRequest(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
    if (!isAuthorizedRequest(req.headers.authorization, opts.dashboardCredential)) {
      res
        .writeHead(401, { ...JSON_HEADERS, 'WWW-Authenticate': 'Bearer' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const parsedArm = parseArmParam(parsedUrl.searchParams);
    if (!parsedArm.ok) {
      res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: parsedArm.reason }));
      return;
    }
    try {
      const snapshot = buildSnapshot(store, new Date(), mode, parsedArm.arm, providers);
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify(snapshot));
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: renderResponderError(err) }));
    }
  }

  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    let parsedUrl: URL;
    let urlPath: string;
    try {
      parsedUrl = new URL(req.url ?? '/', 'http://localhost');
      urlPath = decodeURIComponent(parsedUrl.pathname);
    } catch {
      res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'bad request' }));
      return;
    }

    if (urlPath === '/api/snapshot') {
      handleSnapshotRequest(req, res, parsedUrl);
      return;
    }

    void serveStatic(urlPath, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: renderResponderError(err) }));
    });
  });

  let actualPort = requestedPort;

  return {
    get port() {
      return actualPort;
    },
    get host() {
      return host;
    },
    get url() {
      return `http://${host}:${actualPort}`;
    },
    start() {
      return new Promise((resolve) =>
        server.listen(requestedPort, host, () => {
          const addr = server.address();
          actualPort = typeof addr === 'object' && addr !== null ? addr.port : requestedPort;
          resolve();
        }),
      );
    },
    stop() {
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
