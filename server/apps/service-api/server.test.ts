import { InMemoryQueryStore } from './fixture-store.js';
import { createDashboardServer, type DashboardServer } from './server.js';

let server: DashboardServer;
let base: string;

beforeAll(async () => {
  server = createDashboardServer({
    port: 0,
    host: '127.0.0.1',
    store: new InMemoryQueryStore(),
    mode: 'paper',
  });
  await server.start();
  base = server.url;
});

afterAll(async () => {
  await server.stop();
});

describe('dashboard server — no client bundle', () => {
  it('serves no page: the v2 dashboard serves the client (dashboard spec §7)', async () => {
    for (const path of ['/', '/index.html', '/assets/index.js']) {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not found' });
    }
  });
});

class TwoArmQueryStore extends InMemoryQueryStore {
  override getOpenPositions(asOf: Date, arm: 'live' | 'control') {
    return super.getOpenPositions(asOf, arm).map((p) => ({
      ...p,
      idempotency_key: `${p.idempotency_key}-${arm}`,
    }));
  }

  override getRecentClosedTrades(limit: number, asOf: Date, arm: 'live' | 'control') {
    return super.getRecentClosedTrades(limit, asOf, arm).map((t) => ({
      ...t,
      idempotency_key: `${t.idempotency_key}-${arm}`,
    }));
  }
}

describe('dashboard server — arm scoping (#1592)', () => {
  let armServer: DashboardServer;
  let armBase: string;

  beforeAll(async () => {
    armServer = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new TwoArmQueryStore(),
      mode: 'paper',
    });
    await armServer.start();
    armBase = armServer.url;
  });

  afterAll(async () => {
    await armServer.stop();
  });

  it('serves the live arm by default, with no ?arm= given', async () => {
    const r = await fetch(`${armBase}/api/snapshot`, { cache: 'no-store' });
    expect(r.status).toBe(200);
    const snap = (await r.json()) as { arm: string; positions: { idempotency_key: string }[] };
    expect(snap.arm).toBe('live');
    expect(snap.positions[0]?.idempotency_key).toMatch(/-live$/);
  });

  it('serves the control arm on ?arm=control, never the live rows', async () => {
    const r = await fetch(`${armBase}/api/snapshot?arm=control`, { cache: 'no-store' });
    expect(r.status).toBe(200);
    const snap = (await r.json()) as {
      arm: string;
      positions: { idempotency_key: string }[];
      closed_trades: { idempotency_key: string }[];
    };
    expect(snap.arm).toBe('control');
    expect(snap.positions.every((p) => p.idempotency_key.endsWith('-control'))).toBe(true);
    expect(snap.closed_trades.every((t) => t.idempotency_key.endsWith('-control'))).toBe(true);
  });

  it('serves the live arm on the explicit ?arm=live, same as the default', async () => {
    const r = await fetch(`${armBase}/api/snapshot?arm=live`, { cache: 'no-store' });
    const snap = (await r.json()) as { arm: string };
    expect(snap.arm).toBe('live');
  });

  it('400s an unrecognised arm rather than guessing live', async () => {
    const r = await fetch(`${armBase}/api/snapshot?arm=bogus`, { cache: 'no-store' });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('bogus');
  });

  it('400s a repeated ?arm= param rather than silently taking the first', async () => {
    const r = await fetch(`${armBase}/api/snapshot?arm=live&arm=control`, { cache: 'no-store' });
    expect(r.status).toBe(400);
  });

  it('400s an empty ?arm= value rather than falling back to live', async () => {
    const r = await fetch(`${armBase}/api/snapshot?arm=`, { cache: 'no-store' });
    expect(r.status).toBe(400);
  });
});

describe('dashboard server — api', () => {
  it('serves a JSON snapshot at GET /api/snapshot with the four CLI views', async () => {
    const r = await fetch(`${base}/api/snapshot`, { cache: 'no-store' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const snap = (await r.json()) as {
      mode: string;
      positions: unknown[];
      debates: unknown[];
      verdicts: unknown[];
      analysts: unknown[];
      metrics: unknown;
      tick_status: unknown;
    };

    expect(snap.positions.length).toBeGreaterThan(0);
    expect(snap.debates.length).toBeGreaterThan(0);
    expect(snap.verdicts.length).toBeGreaterThan(0);
    expect(snap.analysts.length).toBeGreaterThan(0);
    expect(snap.tick_status).not.toBeNull();
    expect(snap.metrics).toBeDefined();
    expect(snap.mode).toBe('paper');
  });

  it('returns 405 for non-GET methods (read-only by construction)', async () => {
    for (const path of ['/api/snapshot', '/', '/assets/index-abc123.js']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET');
    }
  });

  it('returns 404 for unknown api paths', async () => {
    const r = await fetch(`${base}/api/trades`);
    expect(r.status).toBe(404);
  });
});

describe('dashboard server — /api/snapshot error responder guard (#1355)', () => {
  function makeHostileError(): Error {
    const err = new Error('placeholder');
    Object.defineProperty(err, 'message', {
      get(): string {
        throw new Error('render boom');
      },
      configurable: true,
    });
    return err;
  }

  class ThrowingStore extends InMemoryQueryStore {
    override getOpenPositions(): never {
      throw makeHostileError();
    }
  }

  let hostileServer: DashboardServer;

  beforeAll(async () => {
    hostileServer = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new ThrowingStore(),
      mode: 'paper',
    });
    await hostileServer.start();
  });

  afterAll(async () => {
    await hostileServer.stop();
  });

  it('completes the 500 response (body written, connection closed) instead of hanging', async () => {
    const result = await fetch(`${hostileServer.url}/api/snapshot`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    }).then(
      async (r) => ({
        completed: true as const,
        status: r.status,
        body: (await r.json()) as { error: string },
      }),
      (error: unknown) => ({ completed: false as const, error }),
    );
    expect(result.completed).toBe(true);
    if (result.completed) {
      expect(result.status).toBe(500);
      expect(result.body.error).toBe('[unrenderable error]');
    }
  }, 10_000);
});

describe('dashboard server — /api/snapshot headersSent guard (#1355 round 1)', () => {
  class BigIntPoisonedStore extends InMemoryQueryStore {
    override getOpenPositions(asOf: Date) {
      const [first, ...rest] = super.getOpenPositions(asOf, 'live');
      if (first === undefined) {
        throw new Error('fixture store returned no positions to poison');
      }
      return [{ ...first, stop: 1n as unknown as number }, ...rest];
    }
  }

  let poisonedServer: DashboardServer;

  beforeAll(async () => {
    poisonedServer = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new BigIntPoisonedStore(),
      mode: 'paper',
    });
    await poisonedServer.start();
  });

  afterAll(async () => {
    await poisonedServer.stop();
  });

  it('completes the response instead of throwing ERR_HTTP_HEADERS_SENT out of the catch', async () => {
    const result = await fetch(`${poisonedServer.url}/api/snapshot`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    }).then(
      async (r) => ({ completed: true as const, status: r.status, body: await r.text() }),
      (error: unknown) => ({ completed: false as const, error }),
    );
    expect(result.completed).toBe(true);
    if (result.completed) {
      expect(result.status).toBe(200);
      expect(result.body).toBe('');
    }
  }, 10_000);
});

describe('dashboard server — bind guard (#887, ADR-0019)', () => {
  it('refuses a non-loopback HOST with no credential configured', () => {
    expect(() =>
      createDashboardServer({
        port: 0,
        host: '0.0.0.0',
        store: new InMemoryQueryStore(),
        mode: 'paper',
      }),
    ).toThrow(/HOST=0\.0\.0\.0.*SAMURAI_DASHBOARD_TOKEN/s);
  });

  it('still constructs for the default loopback bind with no credential — regression guard', () => {
    expect(() =>
      createDashboardServer({
        port: 0,
        host: '127.0.0.1',
        store: new InMemoryQueryStore(),
        mode: 'paper',
      }),
    ).not.toThrow();
  });

  it('permits a non-loopback HOST once a credential is configured', () => {
    expect(() =>
      createDashboardServer({
        port: 0,
        host: '0.0.0.0',
        store: new InMemoryQueryStore(),
        mode: 'paper',
        dashboardCredential: 'fake-sim-token',
      }),
    ).not.toThrow();
  });
});

describe('dashboard server — request-time token verification (#1038)', () => {
  const FIXTURE_TOKEN = 'fixture-dashboard-token';

  class PoisonedStore extends InMemoryQueryStore {
    override getTickStatus(): never {
      throw new Error('PoisonedStore: buildSnapshot must not run for an unauthorized request');
    }
  }

  let poisonedServer: DashboardServer;
  let poisonedBase: string;
  let liveServer: DashboardServer;
  let liveBase: string;

  beforeAll(async () => {
    poisonedServer = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new PoisonedStore(),
      mode: 'paper',
      dashboardCredential: FIXTURE_TOKEN,
    });
    await poisonedServer.start();
    poisonedBase = poisonedServer.url;

    liveServer = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new InMemoryQueryStore(),
      mode: 'paper',
      dashboardCredential: FIXTURE_TOKEN,
    });
    await liveServer.start();
    liveBase = liveServer.url;
  });

  afterAll(async () => {
    await poisonedServer.stop();
    await liveServer.stop();
  });

  it('REFUSES /api/snapshot with no Authorization header — the acceptance-critical case', async () => {
    const r = await fetch(`${poisonedBase}/api/snapshot`);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect(await r.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses /api/snapshot bearing the wrong token', async () => {
    const r = await fetch(`${poisonedBase}/api/snapshot`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(r.status).toBe(401);
  });

  it('refuses /api/snapshot with a malformed Authorization header', async () => {
    const r = await fetch(`${poisonedBase}/api/snapshot`, {
      headers: { Authorization: `Basic ${FIXTURE_TOKEN}` },
    });
    expect(r.status).toBe(401);
  });

  it('permits /api/snapshot bearing the exact configured token', async () => {
    const r = await fetch(`${liveBase}/api/snapshot`, {
      headers: { Authorization: `Bearer ${FIXTURE_TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { mode: string }).mode).toBe('paper');
  });

  it('never sends WWW-Authenticate or a 401 on a request nothing gated', async () => {
    const r = await fetch(`${poisonedBase}/`);
    expect(r.status).toBe(404);
    expect(r.headers.get('www-authenticate')).toBeNull();
  });
});
