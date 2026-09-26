import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type ControlRequestWire,
  type ControlResponseWire,
  type JournalWire,
  type ResearchWire,
  V2_CONTRACT_VERSION,
  type V2OverviewWire,
} from '../../../../contracts/index.js';
import { carriesToken, DASHBOARD_TOKEN_ENV_VAR, isConfiguredToken } from './auth.js';
import {
  type ControlWriteResult,
  type ControlWriter,
  parseControlRequest,
} from './control-writer.js';
import { type JournalQuery, parseJournalQuery } from './journal-reader.js';

export const CONTROL_BODY_MAX_BYTES = 1_024;
const BUSY_RETRY_AFTER_SECONDS = 1;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface V2DashboardServerOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly overview: () => Promise<V2OverviewWire>;
  readonly controls: ControlWriter;
  readonly journal: (query: JournalQuery) => JournalWire;
  readonly research: () => ResearchWire;
  readonly onFault: (error: unknown) => void;
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

function refuseAndClose(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
  headers = {},
): void {
  res.on('finish', () => req.destroy());
  sendError(res, status, error, { ...headers, Connection: 'close' });
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

const UNREAD_BODY_STATUSES: ReadonlySet<number> = new Set([413, 415]);

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
    } else if (UNREAD_BODY_STATUSES.has(outcome.status)) {
      refuseAndClose(req, res, outcome.status, outcome.error);
    } else {
      sendError(res, outcome.status, outcome.error);
    }
  };
}

function getJournal(journal: (query: JournalQuery) => JournalWire): Handler {
  return (req, res) => {
    const parsed = parseJournalQuery(new URL(req.url ?? '/', 'http://localhost').searchParams);
    if (parsed.ok) sendJson(res, 200, journal(parsed.query));
    else sendError(res, 400, parsed.reason);
  };
}

function routesFor(opts: V2DashboardServerOptions): Map<string, Map<string, Handler>> {
  return new Map([
    [
      '/api/v2/overview',
      new Map([['GET', async (_req, res) => sendJson(res, 200, await opts.overview())]]),
    ],
    ['/api/v2/controls', new Map([['POST', postControl(opts.controls)]])],
    ['/api/v2/journal', new Map([['GET', getJournal(opts.journal)]])],
    ['/api/v2/research', new Map([['GET', (_req, res) => sendJson(res, 200, opts.research())]])],
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
      refuseAndClose(req, res, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
  };
}

function resolveHandler(routes: Map<string, Map<string, Handler>>, req: IncomingMessage): Handler {
  const methods = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (methods === undefined) return (req, res) => refuseAndClose(req, res, 404, 'not found');
  const allow = [...methods.keys()].join(', ');
  return (
    methods.get(req.method ?? '') ??
    ((req, res) => refuseAndClose(req, res, 405, 'method not allowed', { Allow: allow }))
  );
}

function isStoreBusy(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SQLITE_BUSY';
}

function respondToFault(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
  } else if (isStoreBusy(error)) {
    sendError(res, 503, 'store busy', { 'Retry-After': String(BUSY_RETRY_AFTER_SECONDS) });
  } else {
    sendError(res, 500, 'internal error');
  }
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
      .catch((error: unknown) => {
        respondToFault(res, error);
        opts.onFault(error);
      });
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
