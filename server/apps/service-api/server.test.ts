import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryQueryStore } from './fixture-store.js';
import {
  bundleContentType,
  bundleDiagnostic,
  createDashboardServer,
  type DashboardServer,
  resolveBundlePath,
} from './server.js';

const INDEX_HTML =
  '<!doctype html><html><head><title>Samurai</title>' +
  '<script type="module" crossorigin src="./assets/index-abc123.js"></script>' +
  '<link rel="stylesheet" crossorigin href="./assets/index-abc123.css">' +
  '</head><body><div id="root"></div></body></html>';
const APP_JS = 'export const app = "bundle";\n';
const OUTSIDE_HTML = '<html>outside the bundle</html>';
const SIBLING_HTML = '<html>sibling directory that shares the root prefix</html>';

let server: DashboardServer;
let base: string;
let parent: string;
let bundleRoot: string;

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), 'samurai-dashboard-'));
  bundleRoot = join(parent, 'client');
  await mkdir(join(bundleRoot, 'assets'), { recursive: true });
  await writeFile(join(bundleRoot, 'index.html'), INDEX_HTML);
  await writeFile(join(bundleRoot, 'assets', 'index-abc123.js'), APP_JS);
  await writeFile(join(bundleRoot, 'assets', 'index-abc123.css'), ':root{color:red}');
  await writeFile(join(bundleRoot, 'assets', 'index-abc123.js.map'), '{"version":3}');
  await writeFile(join(bundleRoot, 'assets', 'chakra-petch.woff2'), 'not-really-a-font');
  await writeFile(join(bundleRoot, 'assets', 'chakra-petch.woff'), 'not-really-a-font-either');
  await writeFile(join(bundleRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(bundleRoot, 'notes.txt'), 'should never be served');

  await writeFile(join(parent, 'outside.html'), OUTSIDE_HTML);
  await mkdir(join(parent, 'client-evil'), { recursive: true });
  await writeFile(join(parent, 'client-evil', 'secret.html'), SIBLING_HTML);

  server = createDashboardServer({
    port: 0,
    host: '127.0.0.1',
    store: new InMemoryQueryStore(),
    bundleRoot,
    mode: 'paper',
  });
  await server.start();
  base = server.url;
});

afterAll(async () => {
  await server.stop();
  await rm(parent, { recursive: true, force: true });
});

describe('dashboard server — static bundle', () => {
  it('serves the built index.html at GET /', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await r.text();
    expect(html).toBe(INDEX_HTML);
    expect(html).toContain('<div id="root">');
  });

  it('serves index.html as an alias for /', async () => {
    const r = await fetch(`${base}/index.html`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(INDEX_HTML);
  });

  it('serves the hashed asset the page references, with its content type', async () => {
    const r = await fetch(`${base}/assets/index-abc123.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await r.text()).toBe(APP_JS);
  });

  it.each([
    ['/assets/index-abc123.css', 'text/css; charset=utf-8'],
    ['/assets/index-abc123.js.map', 'application/json; charset=utf-8'],
    ['/favicon.svg', 'image/svg+xml; charset=utf-8'],
    ['/assets/chakra-petch.woff2', 'font/woff2'],
    ['/assets/chakra-petch.woff', 'font/woff'],
  ])('serves %s as %s', async (path, contentType) => {
    const r = await fetch(`${base}${path}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(contentType);
  });

  it('404s a file inside the bundle whose extension is not on the allow-list', async () => {
    const r = await fetch(`${base}/notes.txt`);
    expect(r.status).toBe(404);
  });

  it('404s a path with no file behind it', async () => {
    const r = await fetch(`${base}/assets/index-deadbeef.js`);
    expect(r.status).toBe(404);
  });
});

describe('dashboard server — path traversal', () => {
  it.each([
    ['%2e%2e%2foutside.html'],
    ['..%2foutside.html'],
    ['%2e%2e%2fclient-evil%2fsecret.html'],
    ['..%2fclient-evil%2fsecret.html'],
  ])('404s the encoded escape /%s', async (path) => {
    const r = await fetch(`${base}/${path}`);
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).not.toContain('outside the bundle');
    expect(body).not.toContain('sibling directory');
  });

  it('404s a double-encoded escape, because the path is decoded exactly once', async () => {
    const r = await fetch(`${base}/%252e%252e%252foutside.html`);
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('outside the bundle');
  });

  it('400s a malformed percent-escape rather than throwing', async () => {
    const r = await fetch(`${base}/%zz.html`);
    expect(r.status).toBe(400);
  });
});

describe('resolveBundlePath', () => {
  const root = '/srv/app/dist/client';

  it('maps / and an empty path to index.html', () => {
    expect(resolveBundlePath(root, '/')).toBe(`${root}/index.html`);
    expect(resolveBundlePath(root, '')).toBe(`${root}/index.html`);
  });

  it('maps a nested asset path inside the root', () => {
    expect(resolveBundlePath(root, '/assets/index-abc123.js')).toBe(
      `${root}/assets/index-abc123.js`,
    );
  });

  it('rejects `..` traversal out of the root', () => {
    expect(resolveBundlePath(root, '/../outside.html')).toBeNull();
    expect(resolveBundlePath(root, '/assets/../../outside.html')).toBeNull();
    expect(resolveBundlePath(root, '/..')).toBeNull();
  });

  it('rejects a SIBLING directory that merely shares the root prefix', () => {
    expect(resolveBundlePath(root, '/../client-evil/secret.html')).toBeNull();
    expect(resolveBundlePath('/srv/app/dist/client', '/../client.bak/x.js')).toBeNull();
  });

  it('rejects the root directory itself', () => {
    expect(resolveBundlePath(root, '/.')).toBeNull();
  });

  it('rejects a NUL byte', () => {
    expect(resolveBundlePath(root, '/index.html\0.png')).toBeNull();
  });

  it('keeps a leading-slash-collapsed path inside the root', () => {
    expect(resolveBundlePath(root, '//etc/passwd')).toBe(`${root}/etc/passwd`);
  });
});

describe('bundleDiagnostic', () => {
  it('is silent when the bundle is a real build', () => {
    expect(bundleDiagnostic(bundleRoot)).toBeNull();
  });

  it('names the missing file and the build command when nothing was built', () => {
    const message = bundleDiagnostic(join(parent, 'never-built'));
    expect(message).toContain('Dashboard bundle not found');
    expect(message).toContain(join(parent, 'never-built', 'index.html'));
    expect(message).toContain('npm run build');
  });

  it('catches the Vite SOURCE template, which an existence check passes (PR #597)', async () => {
    const sourceTree = join(parent, 'client-src');
    await mkdir(sourceTree, { recursive: true });
    await writeFile(
      join(sourceTree, 'index.html'),
      '<!doctype html><html><body><div id="root"></div>' +
        '<script type="module" src="/src/main.tsx"></script></body></html>',
    );

    const message = bundleDiagnostic(sourceTree);
    expect(message).toContain('Vite SOURCE template');
    expect(message).toContain('/src/main.tsx');
    expect(message).toContain('dist/client/');
    expect(message).not.toContain('Dashboard bundle not found');
  });
});

describe('bundleContentType', () => {
  it('returns undefined for anything off the allow-list', () => {
    expect(bundleContentType('/x/notes.txt')).toBeUndefined();
    expect(bundleContentType('/x/data.sqlite')).toBeUndefined();
    expect(bundleContentType('/x/noextension')).toBeUndefined();
  });

  it('is case-insensitive on the extension', () => {
    expect(bundleContentType('/x/INDEX.HTML')).toBe('text/html; charset=utf-8');
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
      bundleRoot,
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
      bundleRoot,
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
      bundleRoot,
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

describe('dashboard server — bundle not built', () => {
  let unbuilt: DashboardServer;
  let unbuiltBase: string;

  beforeAll(async () => {
    unbuilt = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new InMemoryQueryStore(),
      bundleRoot: join(parent, 'never-built'),
      mode: 'live',
    });
    await unbuilt.start();
    unbuiltBase = unbuilt.url;
  });

  afterAll(async () => {
    await unbuilt.stop();
  });

  it('answers GET / with a diagnostic naming the missing file and the build command', async () => {
    const r = await fetch(`${unbuiltBase}/`);
    expect(r.status).toBe(503);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await r.text();
    expect(body).toContain('Dashboard bundle not found');
    expect(body).toContain(join(parent, 'never-built', 'index.html'));
    expect(body).toContain('npm run build');
  });

  it('still serves GET /api/snapshot — a missing page must not take the JSON down', async () => {
    const r = await fetch(`${unbuiltBase}/api/snapshot`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { mode: string }).mode).toBe('live');
  });
});

describe('dashboard server — bind guard (#887, ADR-0019)', () => {
  it('refuses a non-loopback HOST with no credential configured', () => {
    expect(() =>
      createDashboardServer({
        port: 0,
        host: '0.0.0.0',
        store: new InMemoryQueryStore(),
        bundleRoot,
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
        bundleRoot,
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
        bundleRoot,
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
      bundleRoot,
      mode: 'paper',
      dashboardCredential: FIXTURE_TOKEN,
    });
    await poisonedServer.start();
    poisonedBase = poisonedServer.url;

    liveServer = createDashboardServer({
      port: 0,
      host: '127.0.0.1',
      store: new InMemoryQueryStore(),
      bundleRoot,
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

  it('never sends WWW-Authenticate or a 401 on a request nothing gated — the static bundle stays open', async () => {
    const r = await fetch(`${poisonedBase}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('www-authenticate')).toBeNull();
  });
});
