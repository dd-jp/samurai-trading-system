import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type ControlResponseWire,
  V2_CONTRACT_VERSION,
  type V2OverviewWire,
} from '../../../../contracts/index.js';
import {
  DASHBOARD_CREDENTIAL_ENV_VAR,
  describeThrownSafely,
  isAuthorizedRequest,
  isConfiguredCredential,
  sanitizeLogText,
} from '../../../shared/index.js';
import {
  type ControlWriteResult,
  type ControlWriter,
  parseControlRequest,
} from './control-writer.js';

export const CONTROL_BODY_MAX_BYTES = 1_024;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface V2DashboardServerOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly overview: () => V2OverviewWire;
  readonly controls: ControlWriter;
}

export interface V2DashboardServer {
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { ...JSON_HEADERS, ...headers }).end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: string, headers = {}): void {
  sendJson(res, status, { error }, headers);
}

function refuseOversized(req: IncomingMessage, res: ServerResponse): void {
  res.on('finish', () => req.destroy());
  sendError(res, 413, `body is larger than ${CONTROL_BODY_MAX_BYTES} bytes`, {
    Connection: 'close',
  });
}

function declaredTooLarge(req: IncomingMessage): boolean {
  return Number(req.headers['content-length'] ?? 0) > CONTROL_BODY_MAX_BYTES;
}

function readCappedBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > CONTROL_BODY_MAX_BYTES) {
        settled = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isJsonRequest(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0]?.trim() === 'application/json';
}

function sendWriteResult(res: ServerResponse, result: ControlWriteResult): void {
  if (result.kind === 'conflict') {
    sendError(res, 409, result.reason);
    return;
  }
  if (result.kind === 'too-soon') {
    sendError(res, 429, 'one control per 10 seconds', {
      'Retry-After': String(result.retryAfterSeconds),
    });
    return;
  }
  const body: ControlResponseWire = {
    contract_version: V2_CONTRACT_VERSION,
    control: result.control,
    replayed: result.kind === 'replayed',
  };
  sendJson(res, result.kind === 'created' ? 201 : 200, body);
}

function postControl(controls: ControlWriter): Handler {
  return async (req, res) => {
    if (!isJsonRequest(req)) return sendError(res, 415, 'content-type must be application/json');
    if (declaredTooLarge(req)) return refuseOversized(req, res);
    const text = await readCappedBody(req);
    if (text === null) return refuseOversized(req, res);
    const json = parseJson(text);
    if (!json.ok) return sendError(res, 400, 'body is not valid JSON');
    const parsed = parseControlRequest(json.value);
    if (!parsed.ok) return sendError(res, 400, parsed.reason);
    const source = `dashboard ${req.socket.remoteAddress ?? 'unknown'}`;
    sendWriteResult(res, controls.write(parsed.request, source));
  };
}

function routesFor(opts: V2DashboardServerOptions): Map<string, Map<string, Handler>> {
  return new Map([
    ['/api/v2/overview', new Map([['GET', (_req, res) => sendJson(res, 200, opts.overview())]])],
    ['/api/v2/controls', new Map([['POST', postControl(opts.controls)]])],
  ]);
}

function dispatch(
  routes: Map<string, Map<string, Handler>>,
  token: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!isAuthorizedRequest(req.headers.authorization, token)) {
      return sendError(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const methods = routes.get(path);
    if (methods === undefined) return sendError(res, 404, 'not found');
    const handler = methods.get(req.method ?? '');
    if (handler === undefined) {
      return sendError(res, 405, 'method not allowed', { Allow: [...methods.keys()].join(', ') });
    }
    await handler(req, res);
  };
}

function respondToFault(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendError(res, 500, sanitizeLogText(describeThrownSafely(error)));
}

export function createV2DashboardServer(opts: V2DashboardServerOptions): V2DashboardServer {
  const { token } = opts;
  if (!isConfiguredCredential(token)) {
    throw new Error(
      `v2 dashboard refuses to start: ${DASHBOARD_CREDENTIAL_ENV_VAR} is not set. Every request, ` +
        'loopback included, must carry it as `Authorization: Bearer <value>` (dashboard spec §5).',
    );
  }
  const handle = dispatch(routesFor(opts), token);
  const server: Server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((error: unknown) => respondToFault(res, error));
  });
  let port = opts.port;
  return {
    get url() {
      return `http://${opts.host}:${port}`;
    },
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
          const address = server.address();
          port = typeof address === 'object' && address !== null ? address.port : opts.port;
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
