/**
 * Dashboard server acceptance: real HTTP round-trip against a server bound
 * to an ephemeral port (127.0.0.1:0), fed by the in-memory fixture store and
 * a temp directory standing in for `dist/dashboard-web/`.
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

/** Distinguishable bodies, so a wrong-file response is visible in the diff. */
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
/** The temp parent; `bundleRoot` and its evil sibling both live inside it. */
let parent: string;
let bundleRoot: string;

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), 'samurai-dashboard-'));
  bundleRoot = join(parent, 'dashboard-web');
  await mkdir(join(bundleRoot, 'assets'), { recursive: true });
  await writeFile(join(bundleRoot, 'index.html'), INDEX_HTML);
  await writeFile(join(bundleRoot, 'assets', 'index-abc123.js'), APP_JS);
  await writeFile(join(bundleRoot, 'assets', 'index-abc123.css'), ':root{color:red}');
  await writeFile(join(bundleRoot, 'assets', 'index-abc123.js.map'), '{"version":3}');
  await writeFile(join(bundleRoot, 'assets', 'chakra-petch.woff2'), 'not-really-a-font');
  // `@fontsource` emits a `.woff` fallback beside every `.woff2`, and the
  // built CSS references both — see BUNDLE_CONTENT_TYPES.
  await writeFile(join(bundleRoot, 'assets', 'chakra-petch.woff'), 'not-really-a-font-either');
  await writeFile(join(bundleRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // Inside the bundle but not a servable type — the allow-list's negative case.
  await writeFile(join(bundleRoot, 'notes.txt'), 'should never be served');

  // The two escape targets. Both have a servable extension and real content,
  // so a broken guard returns 200 with a body rather than a 404 that would
  // pass for the right reason by accident.
  await writeFile(join(parent, 'outside.html'), OUTSIDE_HTML);
  await mkdir(join(parent, 'dashboard-web-evil'), { recursive: true });
  await writeFile(join(parent, 'dashboard-web-evil', 'secret.html'), SIBLING_HTML);

  server = createDashboardServer({
    port: 0,
    host: '127.0.0.1',
    store: new InMemoryQueryStore(),
    bundleRoot,
    mode: 'paper',
  });
  await server.start();
  // Node assigns the real port when listening on :0; pull it off the address.
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
    // The React entry point, not a hand-rolled template literal.
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
    // Binary: no charset parameter.
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
  // Percent-encoded `..` survives URL normalisation, so these reach the guard.
  it.each([
    ['%2e%2e%2foutside.html'],
    ['..%2foutside.html'],
    ['%2e%2e%2fdashboard-web-evil%2fsecret.html'],
    ['..%2fdashboard-web-evil%2fsecret.html'],
  ])('404s the encoded escape /%s', async (path) => {
    const r = await fetch(`${base}/${path}`);
    expect(r.status).toBe(404);
    // Not merely "not 200": the escape targets have real bodies, so assert
    // neither one leaked.
    const body = await r.text();
    expect(body).not.toContain('outside the bundle');
    expect(body).not.toContain('sibling directory');
  });

  it('404s a double-encoded escape, because the path is decoded exactly once', async () => {
    // `%252e%252e%252f` decodes ONCE to the literal characters `%2e%2e%2f`,
    // which is a filename inside the bundle rather than a traversal. 404 is
    // the correct answer; a second decode here is how double-decoding bugs
    // are born.
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
  const root = '/srv/app/dist/dashboard-web';

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
    // no `..` remains after normalisation, and the string prefix matches.
    expect(resolveBundlePath(root, '/../dashboard-web-evil/secret.html')).toBeNull();
    expect(
      resolveBundlePath('/srv/app/dist/dashboard-web', '/../dashboard-web.bak/x.js'),
    ).toBeNull();
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
    expect(message).toContain('yarn build');
  });

  it('catches the Vite SOURCE template, which an existence check passes (PR #597)', async () => {
    // The reviewer's scenario: `tsx src/dashboard/index.ts` resolves
    // `bundleRoot` to `src/dashboard-web/`, which HAS an index.html — the dev
    // template, whose only script tag is `/src/main.tsx`. A "does the file
    // exist" check is green here and the served page still loads nothing.
    const sourceTree = join(parent, 'dashboard-web-src');
    await mkdir(sourceTree, { recursive: true });
    await writeFile(
      join(sourceTree, 'index.html'),
      '<!doctype html><html><body><div id="root"></div>' +
        '<script type="module" src="/src/main.tsx"></script></body></html>',
    );

    const message = bundleDiagnostic(sourceTree);
    expect(message).toContain('Vite SOURCE template');
    expect(message).toContain('/src/main.tsx');
    expect(message).toContain('dist/dashboard-web/');
    // Distinguishable from case 1 — the two have different fixes.
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
    // has no other honest source for it.
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
    expect(body).toContain('yarn build');
  });

  it('still serves GET /api/snapshot — a missing page must not take the JSON down', async () => {
    const r = await fetch(`${unbuiltBase}/api/snapshot`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { mode: string }).mode).toBe('live');
  });
});
