import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SignalWire } from '../../../../contracts/index.js';
import { UsEquityRegularHoursCalendar } from '../../../providers/calendar/index.js';
import {
  guardedStore,
  migratedMemoryStore,
  type StoreHandle,
} from '../../../shared/store/index.js';
import {
  createSignalsServer,
  isLoopbackHost,
  parseListLimit,
  SIGNAL_BODY_MAX_BYTES,
  type SignalsServer,
  type SignalsServerOptions,
} from './server.js';
import { SignalStore } from './store.js';

const PAYLOAD = { symbol: 'INTC', entry: 24.5, targets: [26, 28], stop: 23 };
const JSON_TYPE = { 'Content-Type': 'application/json' };

let db: StoreHandle | undefined;
let server: SignalsServer | undefined;
let recorded: SignalWire[] = [];
let faults: unknown[] = [];
let now = new Date('2026-09-30T15:00:00.000Z');

afterEach(async () => {
  await server?.stop();
  server = undefined;
  db?.close();
  db = undefined;
  recorded = [];
  faults = [];
  now = new Date('2026-09-30T15:00:00.000Z');
});

async function start(store?: SignalsServerOptions['store']): Promise<number> {
  db = migratedMemoryStore();
  const clock = { now: () => now };
  server = createSignalsServer({
    port: 0,
    store: store ?? new SignalStore(guardedStore(db, 'v2', { enabled: true }), clock),
    calendar: new UsEquityRegularHoursCalendar(),
    clock,
    onRecorded: (signal) => recorded.push(signal),
    onFault: (error) => faults.push(error),
  });
  await server.start();
  return Number(new URL(server.url).port);
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

function send(
  port: number,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function post(port: number, body: unknown, headers: Record<string, string> = JSON_TYPE) {
  return send(port, 'POST', '/api/v2/signals', { body: JSON.stringify(body), headers });
}

describe('POST /api/v2/signals', () => {
  it('stores an in-session signal as queued for immediate processing', async () => {
    const port = await start();
    const reply = await post(port, PAYLOAD);
    expect(reply.status).toBe(201);
    const body = JSON.parse(reply.text) as { signal: SignalWire; replayed: boolean };
    expect(body.replayed).toBe(false);
    expect(body.signal).toMatchObject({
      symbol: 'INTC',
      session: 'in_session',
      process_after: '2026-09-30T15:00:00.000Z',
      status: 'queued',
    });
    expect(recorded).toEqual([body.signal]);
  });

  it('queues an out-of-session signal for the next open', async () => {
    now = new Date('2026-09-30T22:00:00.000Z');
    const port = await start();
    const body = JSON.parse((await post(port, PAYLOAD)).text) as { signal: SignalWire };
    expect(body.signal).toMatchObject({
      session: 'out_of_session',
      process_after: '2026-10-01T13:30:00.000Z',
    });
  });

  it('replays a duplicate with 200 and does not re-announce it', async () => {
    const port = await start();
    const first = JSON.parse((await post(port, PAYLOAD)).text) as { signal: SignalWire };
    const again = await post(port, PAYLOAD);
    expect(again.status).toBe(200);
    expect(JSON.parse(again.text)).toEqual({ signal: first.signal, replayed: true });
    expect(recorded).toHaveLength(1);
  });

  it('accepts a charset on the JSON content type', async () => {
    const port = await start();
    const reply = await post(port, PAYLOAD, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(reply.status).toBe(201);
  });

  it('refuses an invalid payload with the validation reason', async () => {
    const port = await start();
    const reply = await post(port, { ...PAYLOAD, stop: 25 });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.text)).toEqual({
      error: 'stop must be below the entry: signals are US longs only',
    });
    expect(recorded).toEqual([]);
  });

  it('refuses a non-JSON content type with 415', async () => {
    const port = await start();
    const reply = await post(port, PAYLOAD, { 'Content-Type': 'text/plain' });
    expect(reply.status).toBe(415);
  });

  it('refuses a missing content type with 415', async () => {
    const port = await start();
    const reply = await send(port, 'POST', '/api/v2/signals', { body: JSON.stringify(PAYLOAD) });
    expect(reply.status).toBe(415);
  });

  it('refuses malformed JSON with 400', async () => {
    const port = await start();
    const reply = await send(port, 'POST', '/api/v2/signals', {
      body: '{"symbol":',
      headers: JSON_TYPE,
    });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.text)).toEqual({ error: 'body is not valid JSON' });
  });

  it('refuses a body over the cap with 413', async () => {
    const port = await start();
    const reply = await post(port, { ...PAYLOAD, source: 'x'.repeat(SIGNAL_BODY_MAX_BYTES) });
    expect(reply.status).toBe(413);
  });

  it('refuses an oversized chunked body with 413', async () => {
    const port = await start();
    const reply = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/v2/signals',
          headers: { ...JSON_TYPE, 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write('x'.repeat(SIGNAL_BODY_MAX_BYTES));
      req.end('y');
    });
    expect(reply).toBe(413);
  });

  it('refuses a body that is JSON but not an object', async () => {
    const port = await start();
    const reply = await post(port, [PAYLOAD]);
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.text)).toEqual({ error: 'body must be a JSON object' });
  });
});

describe('GET /api/v2/signals', () => {
  it('lists signals newest first', async () => {
    const port = await start();
    await post(port, PAYLOAD);
    now = new Date('2026-09-30T15:01:00.000Z');
    await post(port, { ...PAYLOAD, symbol: 'AMD' });
    const reply = await send(port, 'GET', '/api/v2/signals');
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(reply.text) as { signals: SignalWire[] };
    expect(body.signals.map((signal) => signal.symbol)).toEqual(['AMD', 'INTC']);
  });

  it('honours a limit', async () => {
    const port = await start();
    await post(port, PAYLOAD);
    await post(port, { ...PAYLOAD, symbol: 'AMD' });
    const body = JSON.parse((await send(port, 'GET', '/api/v2/signals?limit=1')).text) as {
      signals: SignalWire[];
    };
    expect(body.signals).toHaveLength(1);
  });

  it('refuses a limit out of range', async () => {
    const port = await start();
    expect((await send(port, 'GET', '/api/v2/signals?limit=0')).status).toBe(400);
  });

  it('returns one signal by id with its events', async () => {
    const port = await start();
    const { signal } = JSON.parse((await post(port, PAYLOAD)).text) as { signal: SignalWire };
    const reply = await send(port, 'GET', `/api/v2/signals/${signal.signal_id}`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual(signal);
  });

  it('answers 404 for an unknown id', async () => {
    const port = await start();
    const reply = await send(port, 'GET', '/api/v2/signals/00000000-0000-0000-0000-000000000000');
    expect(reply.status).toBe(404);
  });

  it('answers 404 for a malformed id', async () => {
    const port = await start();
    expect((await send(port, 'GET', '/api/v2/signals/not-an-id')).status).toBe(404);
  });

  it('answers 405 for a POST to a signal id', async () => {
    const port = await start();
    const reply = await send(port, 'POST', '/api/v2/signals/00000000-0000-0000-0000-000000000000', {
      body: '{}',
      headers: JSON_TYPE,
    });
    expect(reply.status).toBe(405);
  });
});

describe('docs and routing', () => {
  it('serves the OpenAPI document naming its own loopback server', async () => {
    const port = await start();
    const reply = await send(port, 'GET', '/openapi.json');
    expect(reply.status).toBe(200);
    const spec = JSON.parse(reply.text) as {
      openapi: string;
      servers: { url: string }[];
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.servers).toEqual([{ url: `http://127.0.0.1:${port}` }]);
    expect(Object.keys(spec.paths)).toEqual(['/api/v2/signals', '/api/v2/signals/{id}']);
  });

  it('serves the Swagger UI page', async () => {
    const port = await start();
    const reply = await send(port, 'GET', '/docs');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(reply.text).toContain("url: '/openapi.json'");
    expect(reply.text.match(/integrity="sha384-[A-Za-z0-9+/]{64}"/g)).toHaveLength(2);
  });

  it('answers 404 for an unknown path and 405 for a wrong method', async () => {
    const port = await start();
    expect((await send(port, 'GET', '/nope')).status).toBe(404);
    expect((await send(port, 'DELETE', '/api/v2/signals')).status).toBe(405);
    expect((await send(port, 'POST', '/docs')).status).toBe(405);
  });

  it('refuses a request whose Host is not loopback', async () => {
    const port = await start();
    const reply = await send(port, 'GET', '/api/v2/signals', {
      headers: { Host: `attacker.example:${port}` },
    });
    expect(reply.status).toBe(403);
  });

  it('accepts localhost as the Host', async () => {
    const port = await start();
    const reply = await send(port, 'GET', '/api/v2/signals', {
      headers: { Host: `localhost:${port}` },
    });
    expect(reply.status).toBe(200);
  });

  it('answers 500 and reports the fault when the store throws', async () => {
    const boom = new Error('disk gone');
    const port = await start({
      record: () => {
        throw boom;
      },
      get: () => undefined,
      list: () => [],
    });
    const reply = await post(port, PAYLOAD);
    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.text)).toEqual({ error: 'internal error' });
    expect(faults).toEqual([boom]);
  });

  it('binds to the loopback address only', async () => {
    await start();
    expect(server?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1:8789', true],
    ['localhost:8789', true],
    ['127.0.0.1:8790', false],
    ['127.0.0.1', false],
    ['evil.example:8789', false],
    [undefined, false],
  ])('%s → %s', (host, expected) => {
    expect(isLoopbackHost(host, 8789)).toBe(expected);
  });
});

describe('parseListLimit', () => {
  it.each([
    [null, 50],
    ['1', 1],
    ['200', 200],
    ['0', undefined],
    ['201', undefined],
    ['1.5', undefined],
    ['-1', undefined],
    ['abc', undefined],
    ['', undefined],
  ])('%s → %s', (raw, expected) => {
    expect(parseListLimit(raw)).toBe(expected);
  });
});
