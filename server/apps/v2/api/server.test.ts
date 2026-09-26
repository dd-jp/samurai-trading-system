import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROL_REASON_MAX_CHARS,
  V2_CONTRACT_VERSION,
  type V2OverviewWire,
} from '../../../../contracts/index.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { BarsMarketData } from '../data/index.js';
import { ControlWriter } from './control-writer.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';
import {
  CONTROL_BODY_MAX_BYTES,
  createV2DashboardServer,
  type V2DashboardServer,
} from './server.js';

const TOKEN = 'test-dashboard-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
const clock = { now: () => new Date('2026-10-06T21:40:00.000Z') };

let db: StoreHandle;
let server: V2DashboardServer | undefined;
let faults: unknown[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await server?.stop();
  server = undefined;
  db?.close();
  faults = [];
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function start(
  overview?: () => Promise<V2OverviewWire>,
  storePath = ':memory:',
): Promise<string> {
  db = openSharedStore(storePath);
  const store = guardedStore(db, 'dashboard', { enabled: true });
  const reader = new OverviewReader(
    store,
    clock,
    'paper',
    new PositionsPanel(
      { lastBarsBefore: () => Promise.resolve(new Map()) },
      new BarsMarketData({ load: () => undefined }, [{ date: '2025-12-31', gbpUsd: 1.25 }]),
    ),
  );
  server = createV2DashboardServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    overview: overview ?? (() => reader.read()),
    controls: new ControlWriter(store, clock),
    onFault: (error) => faults.push(error),
  });
  await server.start();
  return server.url;
}

function postControl(url: string, body: unknown, headers: Record<string, string> = JSON_AUTH) {
  return fetch(`${url}/api/v2/controls`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const halt = { action: 'halt', reason: 'news shock', idempotency_key: 'key-0001' };

describe('createV2DashboardServer start-up', () => {
  it.each([undefined, '', '   '])('refuses to start without a configured token (%j)', (token) => {
    expect(() =>
      createV2DashboardServer({
        host: '127.0.0.1',
        port: 0,
        token,
        overview: () => {
          throw new Error('unused');
        },
        controls: {} as ControlWriter,
        onFault: () => undefined,
      }),
    ).toThrow(/SAMURAI_DASHBOARD_TOKEN is not set.*loopback included/s);
  });

  it('rejects start when the port is taken', async () => {
    const url = await start();
    const clash = createV2DashboardServer({
      host: '127.0.0.1',
      port: Number(new URL(url).port),
      token: TOKEN,
      overview: () => {
        throw new Error('unused');
      },
      controls: {} as ControlWriter,
      onFault: () => undefined,
    });
    await expect(clash.start()).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('createV2DashboardServer auth and routing', () => {
  it('refuses every request without the token, loopback included, before routing', async () => {
    const url = await start();
    for (const path of ['/api/v2/overview', '/api/v2/controls', '/nowhere']) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.headers.get('connection')).toBe('close');
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }
    const wrong = await fetch(`${url}/api/v2/overview`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect((await postControl(url, halt, { 'Content-Type': 'application/json' })).status).toBe(401);
  });

  it('serves the overview as uncached JSON with no CORS grant', async () => {
    const url = await start();
    const response = await fetch(`${url}/api/v2/overview`, {
      headers: { ...AUTH, Origin: 'http://evil.example' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body = (await response.json()) as V2OverviewWire;
    expect(body.contract_version).toBe(V2_CONTRACT_VERSION);
    expect(body.control.state).toBe('running');
  });

  it('answers an unknown path 404 and a wrong method 405 with Allow', async () => {
    const url = await start();
    const nothing = await fetch(`${url}/api/v2/nothing`, { headers: AUTH });
    expect(nothing.status).toBe(404);
    expect(nothing.headers.get('connection')).toBe('close');
    expect(await nothing.json()).toEqual({ error: 'not found' });
    const getControls = await fetch(`${url}/api/v2/controls`, { headers: AUTH });
    expect(getControls.status).toBe(405);
    expect(getControls.headers.get('allow')).toBe('POST');
    expect(getControls.headers.get('connection')).toBe('close');
    expect(await getControls.json()).toEqual({ error: 'method not allowed' });
    const postOverview = await fetch(`${url}/api/v2/overview`, { method: 'POST', headers: AUTH });
    expect(postOverview.status).toBe(405);
    expect(postOverview.headers.get('allow')).toBe('GET');
  });

  it('answers a fault with a bare 500 and hands the detail to the fault hook only', async () => {
    const fault = new Error('disk gone at /Users/someone/secret.sqlite');
    const url = await start(() => Promise.reject(fault));
    const response = await fetch(`${url}/api/v2/overview`, { headers: AUTH });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
    expect(faults).toEqual([fault]);
  });

  it('answers 503 with Retry-After while another connection holds the write lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-dashboard-busy-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const url = await start(undefined, join(dir, 'v2.sqlite'));
    db.pragma('busy_timeout = 0');
    const cycle = new BetterSqlite3(join(dir, 'v2.sqlite'));
    cleanups.push(() => cycle.close());
    cycle.exec('BEGIN IMMEDIATE');
    const response = await postControl(url, halt);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({ error: 'store busy' });
    cycle.exec('ROLLBACK');
    expect((await postControl(url, halt)).status).toBe(201);
  });
});

describe('POST /api/v2/controls', () => {
  it('records a control with the caller address as its source, and the overview shows it', async () => {
    const url = await start();
    const response = await postControl(url, halt);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      replayed: false,
      control: {
        control_id: 1,
        action: 'halt',
        reason: 'news shock',
        source: expect.stringMatching(/^dashboard (::ffff:)?127\.0\.0\.1$/),
        set_at: '2026-10-06T21:40:00.000Z',
      },
    });
    const overview = (await (
      await fetch(`${url}/api/v2/overview`, { headers: AUTH })
    ).json()) as V2OverviewWire;
    expect(overview.control.state).toBe('halted-manual');
  });

  it('replays a repeated key 200, refuses a reused key 409 and a second control 429', async () => {
    const url = await start();
    await postControl(url, halt);
    const replay = await postControl(url, halt);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, control: { control_id: 1 } });
    expect((await postControl(url, { ...halt, action: 'pause' })).status).toBe(409);
    const soon = await postControl(url, { ...halt, idempotency_key: 'key-0002' });
    expect(soon.status).toBe(429);
    expect(soon.headers.get('retry-after')).toBe('10');
    expect(await soon.json()).toEqual({ error: 'one control per 10 seconds' });
  });

  it('refuses a body that is not JSON, not a valid request or not labelled JSON', async () => {
    const url = await start();
    const notJson = await postControl(url, '{halt');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'body is not valid JSON' });
    const invalid = await postControl(url, { ...halt, action: 'flatten' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'action must be pause, halt or resume' });
    const form = await postControl(url, 'action=halt', {
      ...AUTH,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(form.status).toBe(415);
    expect(form.headers.get('connection')).toBe('close');
    expect(await form.json()).toEqual({ error: 'content-type must be application/json' });
    const unlabelled = await postControl(url, halt, AUTH);
    expect(unlabelled.status).toBe(415);
    const charset = await postControl(url, halt, {
      ...AUTH,
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(charset.status).toBe(201);
  });

  it('refuses a declared oversized body without reading it', async () => {
    const url = await start();
    const response = await postControl(url, {
      ...halt,
      reason: 'x'.repeat(CONTROL_BODY_MAX_BYTES),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('connection')).toBe('close');
    expect(await response.json()).toEqual({
      error: `body is larger than ${CONTROL_BODY_MAX_BYTES} bytes`,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_controls').get()).toEqual({ n: 0 });
  });

  it('fits the longest reason of three-byte characters and the longest key under the cap', async () => {
    const url = await start();
    const widest = JSON.stringify({
      action: 'halt',
      reason: '€'.repeat(CONTROL_REASON_MAX_CHARS),
      idempotency_key: 'k'.repeat(128),
    });
    expect(Buffer.byteLength(widest)).toBeLessThanOrEqual(CONTROL_BODY_MAX_BYTES);
    expect((await postControl(url, widest)).status).toBe(201);
  });

  it('accepts a body of exactly the cap', async () => {
    const url = await start();
    const padding = CONTROL_BODY_MAX_BYTES - JSON.stringify({ ...halt, reason: 'r' }).length;
    const exact = JSON.stringify({ ...halt, reason: `${' '.repeat(padding)}r` });
    expect(Buffer.byteLength(exact)).toBe(CONTROL_BODY_MAX_BYTES);
    expect((await postControl(url, exact)).status).toBe(201);
  });

  it('cuts off a streamed body that grows past the cap with no length declared', async () => {
    const url = await start();
    const { port } = new URL(url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/v2/controls',
          headers: { ...JSON_AUTH, 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write('{"reason":"');
      req.write('x'.repeat(CONTROL_BODY_MAX_BYTES));
      req.write('x'.repeat(CONTROL_BODY_MAX_BYTES));
    });
    expect(status).toBe(413);
    expect(db.prepare('SELECT COUNT(*) AS n FROM v2_controls').get()).toEqual({ n: 0 });
  });
});
