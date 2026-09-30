import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SignalWire } from '../../../../contracts/index.js';
import type { Clock } from '../../../shared/index.js';
import { SWAGGER_HTML, signalsOpenApi } from './openapi.js';
import { parseSignalPayload } from './payload.js';
import { SIGNAL_LIST_MAX, type SignalStore } from './store.js';
import { classifySignalWindow, type SessionCalendar } from './window.js';

const SIGNALS_HOST = '127.0.0.1';
export const SIGNAL_BODY_MAX_BYTES = 4_096;
const DEFAULT_LIST_LIMIT = 50;
const SIGNAL_PATH = /^\/api\/v2\/signals\/([0-9a-f-]{36})$/;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface SignalsServerOptions {
  readonly port: number;
  readonly store: Pick<SignalStore, 'record' | 'get' | 'list'>;
  readonly calendar: SessionCalendar;
  readonly clock: Clock;
  readonly onRecorded?: ((signal: SignalWire) => void) | undefined;
  readonly onFault: (error: unknown) => void;
}

export interface SignalsServer {
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS).end(JSON.stringify(body));
}

function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): void {
  res.on('finish', () => req.destroy());
  res.writeHead(status, { ...JSON_HEADERS, Connection: 'close' }).end(JSON.stringify({ error }));
}

function readCappedBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= SIGNAL_BODY_MAX_BYTES) chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(size > SIGNAL_BODY_MAX_BYTES ? null : Buffer.concat(chunks).toString('utf8')),
    );
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

function declaredTooLarge(req: IncomingMessage): boolean {
  return Number(req.headers['content-length'] ?? 0) > SIGNAL_BODY_MAX_BYTES;
}

type BodyOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415; readonly error: string };

async function readJsonBody(req: IncomingMessage): Promise<BodyOutcome> {
  if (!isJsonRequest(req)) {
    return { ok: false, status: 415, error: 'content-type must be application/json' };
  }
  const text = declaredTooLarge(req) ? null : await readCappedBody(req);
  if (text === null) {
    return { ok: false, status: 413, error: `body is larger than ${SIGNAL_BODY_MAX_BYTES} bytes` };
  }
  const json = parseJson(text);
  return json.ok ? json : { ok: false, status: 400, error: 'body is not valid JSON' };
}

function postSignal(opts: SignalsServerOptions): Handler {
  return async (req, res) => {
    const body = await readJsonBody(req);
    if (!body.ok) {
      refuse(req, res, body.status, body.error);
      return;
    }
    const parsed = parseSignalPayload(body.value);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.reason });
      return;
    }
    const receivedAt = opts.clock.now();
    const window = classifySignalWindow(receivedAt, opts.calendar);
    const { signal, replayed } = opts.store.record(parsed.payload, receivedAt, window);
    sendJson(res, replayed ? 200 : 201, { signal, replayed });
    if (!replayed) opts.onRecorded?.(signal);
  };
}

export function parseListLimit(raw: string | null): number | undefined {
  if (raw === null) return DEFAULT_LIST_LIMIT;
  const limit = Number(raw);
  return /^\d+$/.test(raw) && limit >= 1 && limit <= SIGNAL_LIST_MAX ? limit : undefined;
}

function listSignals(opts: SignalsServerOptions): Handler {
  return (req, res) => {
    const limit = parseListLimit(requestUrl(req).searchParams.get('limit'));
    if (limit === undefined) {
      sendJson(res, 400, { error: `limit must be an integer from 1 to ${SIGNAL_LIST_MAX}` });
      return;
    }
    sendJson(res, 200, { signals: opts.store.list(limit) });
  };
}

function getSignal(opts: SignalsServerOptions, signalId: string): Handler {
  return (_req, res) => {
    const signal = opts.store.get(signalId);
    if (signal === undefined) sendJson(res, 404, { error: 'no such signal' });
    else sendJson(res, 200, signal);
  };
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

function staticRoutes(
  opts: SignalsServerOptions,
  url: () => string,
): Map<string, Map<string, Handler>> {
  return new Map([
    [
      '/api/v2/signals',
      new Map([
        ['POST', postSignal(opts)],
        ['GET', listSignals(opts)],
      ]),
    ],
    [
      '/openapi.json',
      new Map<string, Handler>([['GET', (_req, res) => sendJson(res, 200, signalsOpenApi(url()))]]),
    ],
    [
      '/docs',
      new Map<string, Handler>([
        [
          'GET',
          (_req, res) => {
            res
              .writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
              })
              .end(SWAGGER_HTML);
          },
        ],
      ]),
    ],
  ]);
}

function methodsFor(
  routes: Map<string, Map<string, Handler>>,
  opts: SignalsServerOptions,
  path: string,
): Map<string, Handler> | undefined {
  const signalId = SIGNAL_PATH.exec(path)?.[1];
  if (signalId !== undefined) return new Map([['GET', getSignal(opts, signalId)]]);
  return routes.get(path);
}

function resolveHandler(methods: Map<string, Handler> | undefined, method: string): Handler {
  if (methods === undefined) return (req, res) => refuse(req, res, 404, 'not found');
  return methods.get(method) ?? ((req, res) => refuse(req, res, 405, 'method not allowed'));
}

export function isLoopbackHost(host: string | undefined, port: number): boolean {
  return host === `${SIGNALS_HOST}:${port}` || host === `localhost:${port}`;
}

export function createSignalsServer(opts: SignalsServerOptions): SignalsServer {
  let port = opts.port;
  const url = () => `http://${SIGNALS_HOST}:${port}`;
  const routes = staticRoutes(opts, url);
  const handle: Handler = async (req, res) => {
    if (!isLoopbackHost(req.headers.host, port)) {
      refuse(req, res, 403, 'host must be the loopback address');
      return;
    }
    const methods = methodsFor(routes, opts, requestUrl(req).pathname);
    await resolveHandler(methods, req.method ?? '')(req, res);
  };
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((error: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        opts.onFault(error);
      });
  });
  return {
    get url() {
      return url();
    },
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, SIGNALS_HOST, () => {
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
