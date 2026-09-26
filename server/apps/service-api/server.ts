import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

export function createDashboardServer(opts: DashboardServerOptions): DashboardServer {
  assertBindAllowed(opts.host, opts.dashboardCredential);

  const { host, store, mode } = opts;
  const providers = opts.providers ?? NULL_PROVIDER_STATUS;
  const requestedPort = opts.port;

  function snapshotBody(arm: TradingArm): { status: 200 | 500; body: string } {
    try {
      const snapshot = buildSnapshot(store, new Date(), mode, arm, providers);
      return { status: 200, body: JSON.stringify(snapshot) };
    } catch (err) {
      return { status: 500, body: JSON.stringify({ error: renderResponderError(err) }) };
    }
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
    const { status, body } = snapshotBody(parsedArm.arm);
    res.writeHead(status, JSON_HEADERS).end(body);
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

    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'not found' }));
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
