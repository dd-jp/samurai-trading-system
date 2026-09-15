/**
 * Dashboard server acceptance: real HTTP round-trip against a server bound
 * to an ephemeral port (127.0.0.1:0), fed by the in-memory fixture store and
 * a temp directory standing in for `dist/client/`.
 *
 * Asserts the read-only contract by construction: only `GET` is served,
 * every other method is 405, unknown paths 404 — and, since #539, that the
 * static handler cannot be walked out of the bundle.
 *
 * **Why the containment guard is tested twice, at two levels.** Both `new
 * URL()` and `fetch()` normalise literal `..` segments away before a request
 * leaves the client, so `fetch(base + '/../outside.html')` asks the server
 * for `/outside.html` and proves nothing about containment. So the escape
 * cases are tested directly against the pure `resolveBundlePath`, and the
 * encoded forms — which do survive normalisation — are tested over HTTP.
 * Both escapes the spec names are covered: `..` traversal AND a sibling
 * directory whose name shares the bundle root's prefix, which is the one a
 * naive `resolved.startsWith(root)` check lets through.
 *
 * Uses Node's built-in `fetch` rather than pulling an HTTP client
 * dependency — the dashboard has zero runtime deps and the tests add none.
 */
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

/** Distinguishable bodies, so a wrong-file response is visible in the diff */
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
/** The temp parent; `bundleRoot` and its evil sibling both live inside it */
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
  // `@fontsource` emits a `.woff` fallback beside every `.woff2`, and the
  // built CSS references both — see BUNDLE_CONTENT_TYPES
  await writeFile(join(bundleRoot, 'assets', 'chakra-petch.woff'), 'not-really-a-font-either');
  await writeFile(join(bundleRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // Inside the bundle but not a servable type — the allow-list's negative case
  await writeFile(join(bundleRoot, 'notes.txt'), 'should never be served');

  // The two escape targets. Both have a servable extension and real content,
  // so a broken guard returns 200 with a body rather than a 404 that would
  // pass for the right reason by accident
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
  // Node assigns the real port when listening on :0; pull it off the address
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
    // The React entry point, not a hand-rolled template literal
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
    // Binary: no charset parameter
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
  // Percent-encoded `..` survives URL normalisation, so these reach the guard
  it.each([
    ['%2e%2e%2foutside.html'],
    ['..%2foutside.html'],
    ['%2e%2e%2fclient-evil%2fsecret.html'],
    ['..%2fclient-evil%2fsecret.html'],
  ])('404s the encoded escape /%s', async (path) => {
    const r = await fetch(`${base}/${path}`);
    expect(r.status).toBe(404);
    // Not merely "not 200": the escape targets have real bodies, so assert
    // neither one leaked
    const body = await r.text();
    expect(body).not.toContain('outside the bundle');
    expect(body).not.toContain('sibling directory');
  });

  it('404s a double-encoded escape, because the path is decoded exactly once', async () => {
    // `%252e%252e%252f` decodes ONCE to the literal characters `%2e%2e%2f`,
    // which is a filename inside the bundle rather than a traversal. 404 is
    // the correct answer; a second decode here is how double-decoding bugs
    // are born
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
    // The case `resolved.startsWith(root)` passes and containment does not:
    // no `..` remains after normalisation, and the string prefix matches
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
    // The reviewer's scenario: `tsx server/apps/service-api/index.ts` resolves
    // `bundleRoot` to the repo's `client/`, which HAS an index.html — the dev
    // template, whose only script tag is `/src/main.tsx`. A "does the file
    // exist" check is green here and the served page still loads nothing
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
    // Distinguishable from case 1 — the two have different fixes
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

/**
 * #1592: a store whose `getOpenPositions`/`getRecentClosedTrades` actually
 * differ by arm — `InMemoryQueryStore`'s fixture data does not vary by arm,
 * so it cannot prove the HTTP layer threads `?arm=` through to the store
 */
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
    // #539: the run mode the entry point resolved, on the wire — the browser
    // has no other honest source for it
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

/**
 * #1355: the `/api/snapshot` catch renders the caught value with
 * `err instanceof Error ? err.message : '…'` inside the very `catch` whose
 * job is to WRITE the error response. `res.writeHead(500, …).end(JSON.stringify(…))`
 * evaluates `writeHead` first — so a hostile `err.message` that throws during
 * the `.end()` argument's evaluation leaves the 500 headers sent and the
 * body never written: the request hangs rather than failing cleanly, since
 * `.end()` is never reached to close it out.
 */
describe('dashboard server — /api/snapshot error responder guard (#1355)', () => {
  /**
   * An instance-level `message` getter, not a class-level one: `Error`'s own
   * constructor assigns `this.message = …` as an OWN data property, which
   * would shadow a getter declared on the subclass prototype (confirmed —
   * the class-getter version of this test passed the constructor argument
   * straight through, never reaching the getter at all). Matches
   * `telegram-bot-api-client.test.ts`'s `escalationError` hostile fixture
   * (#1351) for the identical reason.
   */
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
    // A short abort, not the test's own timeout: before the fix this
    // request never completes at all (headers sent, `.end()` never
    // reached), so the fetch itself must settle on its own bound and hand
    // control to a real assertion below — an unbounded fetch racing the
    // harness's own default timeout would fail as a bare "Test timed out"
    // with no assertion diff
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
      // The literal fallback is dropped in favor of `describeThrownSafely`'s
      // placeholder for a value that could not be rendered at all — see
      // `renderResponderError`'s doc comment in server.ts
      expect(result.body.error).toBe('[unrenderable error]');
    }
  }, 10_000);
});

/**
 * #1355 round-1 review — the render is guarded, but the `/api/snapshot`
 * catch still OPENS by calling `res.writeHead(500, ...)` itself. The
 * success path's own `res.writeHead(200, ...)` runs first and sets
 * `res.headersSent` BEFORE `JSON.stringify(snapshot)` is evaluated as
 * `.end`'s argument — so a snapshot value `JSON.stringify` refuses (a
 * BigInt survives `buildSnapshot`'s field types, which are compile-time
 * only) reaches the catch with headers already sent. Without a guard there
 * too, the catch's own `writeHead(500, ...)` throws `ERR_HTTP_HEADERS_SENT`,
 * uncaught — one `writeHead` earlier than the failure `renderResponderError`
 * guards against. The catch now checks `res.headersSent` first, mirroring
 * the guard `serveStatic`'s rejection handler already carried.
 */
describe('dashboard server — /api/snapshot headersSent guard (#1355 round 1)', () => {
  class BigIntPoisonedStore extends InMemoryQueryStore {
    override getOpenPositions(asOf: Date) {
      const [first, ...rest] = super.getOpenPositions(asOf, 'live');
      if (first === undefined) {
        throw new Error('fixture store returned no positions to poison');
      }
      // `stop` flows straight into `PositionRow.stop` with no arithmetic in
      // buildSnapshot — unlike `filled_size`, which `unrealizedPnl`
      // multiplies against a `number`: poisoning THAT throws inside
      // `buildSnapshot` itself, before `writeHead(200)` ever runs, and never
      // reaches this bug at all
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
    // Status/body are whatever the already-committed `writeHead(200, ...)`
    // left behind — the guard's job is only to stop the catch's own
    // `writeHead(500)` from throwing, not to make the response say 500
    // That is the same contract the sibling `serveStatic` guard already
    // has (`server.ts`'s `if (res.headersSent) { res.end(); return; }`)
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

/**
 * #887/ADR-0019: `createDashboardServer` must itself enforce the conjunctive
 * bind guard (`bind-guard.ts`), not merely offer it as a function nothing
 * calls — the composition, not the pure predicate, is what actually protects
 * a real `npm run dashboard`. `bind-guard.test.ts` covers the predicate's own
 * truth table directly; these three cases prove the wiring at the boundary
 * every caller (`index.ts`, `fixture-server.ts`) actually goes through.
 *
 * Construction only, no `.start()`: the refusal (and the permission) happen
 * synchronously inside `createDashboardServer`, before any socket binds, so
 * asserting on the constructor call is the precise claim — actually binding
 * `0.0.0.0` would additionally depend on the test sandbox's own network
 * policy, which is not what this guard is about.
 */
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

/**
 * #1038 (David's 2026-09-08 decision on #887's option 2): a configured
 * `SAMURAI_DASHBOARD_TOKEN` must additionally be verified against each
 * request to `GET /api/snapshot`, not just at boot. Bound on loopback
 * (127.0.0.1) rather than 0.0.0.0 — same reason the bind-guard describe
 * block above only asserts on construction for the non-loopback case: this
 * repo's test sandbox does not reliably support binding 0.0.0.0 (see that
 * block's own comment), and loopback + a configured credential is sufficient
 * to exercise every branch of `isAuthorizedRequest` over a real socket.
 */
describe('dashboard server — request-time token verification (#1038)', () => {
  const FIXTURE_TOKEN = 'fixture-dashboard-token';

  /** Throws if ever called — proves an unauthorized request never reaches buildSnapshot */
  class PoisonedStore extends InMemoryQueryStore {
    override getTickStatus(): never {
      throw new Error('PoisonedStore: buildSnapshot must not run for an unauthorized request');
    }
  }

  let poisonedServer: DashboardServer;
  let poisonedBase: string;
  /** A normal store, for the cases that must actually reach buildSnapshot */
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
    // A test that only asserted the valid-token case would still pass
    // against pre-#1038 behaviour, which never checks this header at all
    // Uses the poisoned store: the store must never be touched here
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
    // Deliberate scope decision (request-auth.ts's header): the shell and its
    // assets carry no book data, and a browser's plain navigation/subresource
    // requests send no custom header, so gating them would break the client
    // outright. This proves the decision is actually wired, not just stated.
    // Uses the poisoned store too: an ungated route must never reach it either
    const r = await fetch(`${poisonedBase}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('www-authenticate')).toBeNull();
  });
});
