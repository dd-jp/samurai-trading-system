import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type ControlRequestWire,
  type ControlResponseWire,
  V2_CONTRACT_VERSION,
  type V2OverviewWire,
} from '../../../../contracts/index.js';
import { describeThrownSafely, sanitizeLogText } from '../../../shared/index.js';
import { carriesToken, DASHBOARD_TOKEN_ENV_VAR, isConfiguredToken } from './auth.js';
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

type BodyOutcome =
  | { readonly ok: true; readonly request: ControlRequestWire }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly error: string };

const OVERSIZED: BodyOutcome = {
  ok: false,
  status: 413,
  error: `body is larger than ${CONTROL_BODY_MAX_BYTES} bytes`,
};

function parseBody(text: string): BodyOutcome {
  const json = parseJson(text);
  if (!json.ok) return { ok: false, status: 400, error: 'body is not valid JSON' };
  const parsed = parseControlRequest(json.value);
  return parsed.ok ? parsed : { ok: false, status: 400, error: parsed.reason };
}

async function readControlRequest(req: IncomingMessage): Promise<BodyOutcome> {
  if (!isJsonRequest(req)) {
    return { ok: false, status: 415, error: 'content-type must be application/json' };
  }
  const text = declaredTooLarge(req) ? null : await readCappedBody(req);
  return text === null ? OVERSIZED : parseBody(text);
}

function postControl(controls: ControlWriter): Handler {
  return async (req, res) => {
    const outcome = await readControlRequest(req);
    if (outcome.ok) {
      const source = `dashboard ${req.socket.remoteAddress ?? 'unknown'}`;
      sendWriteResult(res, controls.write(outcome.request, source));
    } else if (outcome.status === 413) {
      refuseOversized(req, res);
    } else {
      sendError(res, outcome.status, outcome.error);
    }
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
    if (carriesToken(req.headers.authorization, token)) {
      await resolveHandler(routes, req)(req, res);
    } else {
      sendError(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
  };
}

function resolveHandler(routes: Map<string, Map<string, Handler>>, req: IncomingMessage): Handler {
  const methods = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (methods === undefined) return (_req, res) => sendError(res, 404, 'not found');
  const allow = [...methods.keys()].join(', ');
  return (
    methods.get(req.method ?? '') ??
    ((_req, res) => sendError(res, 405, 'method not allowed', { Allow: allow }))
  );
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
  if (!isConfiguredToken(token)) {
    throw new Error(
      `v2 dashboard refuses to start: ${DASHBOARD_TOKEN_ENV_VAR} is not set. Every request, ` +
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
