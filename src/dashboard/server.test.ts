/**
 * Dashboard server acceptance: real HTTP round-trip against a server bound
 * to an ephemeral port (127.0.0.1:0), fed by the in-memory fixture store.
 * Asserts the read-only contract by construction: only `GET` is served,
 * every other method to a known path is 405, unknown paths 404.
 *
 * Uses Node's built-in `fetch` (available in Node 22 / vitest's environment)
 * rather than pulling an HTTP client dependency — the dashboard has zero
 * runtime deps and the tests add none.
 */
import { InMemoryQueryStore } from './fixture-store.js';
import { createDashboardServer, type DashboardServer } from './server.js';

let server: DashboardServer;
let base: string;

beforeAll(async () => {
  server = createDashboardServer({ port: 0, host: '127.0.0.1', store: new InMemoryQueryStore() });
  await server.start();
  // Node assigns the real port when listening on :0; pull it off the address.
  base = server.url;
});

afterAll(async () => {
  await server.stop();
});

describe('dashboard server', () => {
  it('serves the single-page dashboard HTML at GET /', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<title>Samurai — Operator Dashboard</title>');
    expect(html).toContain('/api/snapshot');
  });

  it('serves a JSON snapshot at GET /api/snapshot with the four CLI views', async () => {
    const r = await fetch(`${base}/api/snapshot`, { cache: 'no-store' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const snap = (await r.json()) as {
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
  });

  it('returns 405 for non-GET methods to a known path (read-only by construction)', async () => {
    const r = await fetch(`${base}/api/snapshot`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });

  it('returns 404 for unknown paths', async () => {
    const r = await fetch(`${base}/api/trades`);
    expect(r.status).toBe(404);
  });

  it('serves index.html as an alias for /', async () => {
    const r = await fetch(`${base}/index.html`);
    expect(r.status).toBe(200);
    expect((await r.text()).length).toBeGreaterThan(0);
  });
});
