/**
 * Dashboard HTTP server — a thin, read-only transport over `buildSnapshot`
 * plus a static file handler for the built Vite+React bundle (ADR-0010,
 * #539). Uses Node 22's built-in `http` and `fs`: zero new runtime
 * dependencies (`better-sqlite3` is still the only entry in `dependencies`;
 * react/vite are devDependencies that produce bytes on disk at build time).
 *
 * Two `GET` surfaces:
 *   - `GET /api/snapshot` → `buildSnapshot(store, now, mode, providers)` as JSON
 *   - everything else     → a file inside `bundleRoot` (`/` → `index.html`),
 *                           404 when it is not there or not a servable type
 *
 * No `POST`/`PUT`/`DELETE` handlers exist by construction (dashboard-spec.md
 * "Any write path ... strictly read-only") — the dashboard can never place,
 * block, or modify a trade. The server's blast radius is exactly "an operator
 * reads something," same as the CLI.
 *
 * Serving files from disk is the one genuinely new attack surface v2
 * introduces, so the containment guard (`resolveBundlePath`) is a pure,
 * separately-tested function rather than a few lines buried in the request
 * handler — see its own comment for why a `startsWith` prefix check is not
 * the same question.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { describeThrownSafely, sanitizeLogText } from '../../shared/index.js';
import type { StoreMode } from '../../shared/store/index.js';
import { assertBindAllowed } from './bind-guard.js';
import { NULL_PROVIDER_STATUS, type ProviderStatusReader } from './provider-status.js';
import { buildSnapshot } from './snapshot.js';
import type { DashboardQueryStore } from './types.js';

/**
 * Renders a caught value into an HTTP error-body string, for the two
 * responders (`/api/snapshot`'s catch, `serveStatic`'s rejection handler)
 * whose own job is to report a failure — a throw from inside either would
 * leave the response it was building incomplete (#1355).
 *
 * `describeThrownSafely` (safe-log.ts, #1262) is what guards the render
 * itself: an `Error` instance whose own `message` is a throwing getter, or
 * any other value whose rendering path throws, degrades to
 * `'[unrenderable error]'` rather than propagating.
 *
 * `sanitizeLogText` is load-bearing here, not belt-and-suspenders: dropping
 * the two literals these sites used to fall back to on a non-`Error` throw
 * (`'snapshot failed'` / `'static read failed'`) means such a throw now
 * renders the thrown *value* into a client-visible body where before it
 * always rendered a fixed string, so masking known credential syntaxes is what
 * makes that widening safe. Its `MAX_ERROR_BODY_CHARS` cap (~500 chars,
 * `http/response-errors.ts`) matters too: an operator reading a long real
 * error message would notice truncation before they'd notice masking. Same
 * posture `logCaughtFailure` already takes for a log line (safe-log.ts's own
 * doc comment: "belt and suspenders costs nothing here"), applied here to a
 * body a client can read instead.
 *
 * Scope: both call sites guard `res.headersSent` before calling this
 * function and `writeHead(500, ...)` — necessary because each site's own
 * success path already calls `writeHead(200, ...)` (setting the flag)
 * BEFORE the value that can throw is evaluated as `.end`'s argument.
 * `/api/snapshot`: `res.writeHead(200, ...).end(JSON.stringify(snapshot))`
 * — `writeHead` runs first, then `JSON.stringify` is evaluated for `.end`;
 * a value it refuses (a BigInt, a circular reference) reaches this catch
 * with `res.headersSent` already true. Without the guard, the catch's own
 * `writeHead(500, ...)` would itself throw `ERR_HTTP_HEADERS_SENT`,
 * uncaught — one `writeHead` earlier than the failure this function guards
 * against. `serveStatic`'s rejection handler carries the same guard for the
 * same reason.
 */
function renderResponderError(err: unknown): string {
  return sanitizeLogText(describeThrownSafely(err));
}

export interface DashboardServerOptions {
  port: number;
  host: string;
  store: DashboardQueryStore;
  /**
   * The dashboard's fail-closed bind guard (#887, ADR-0019, `bind-guard.ts`).
   * `undefined` reads as "not configured" — the loopback default stays
   * startable with no value here, and a non-loopback `host` refuses unless
   * this is a non-empty string. Callers resolve it from
   * `process.env[DASHBOARD_CREDENTIAL_ENV_VAR]` (`SAMURAI_DASHBOARD_TOKEN`)
   * per this repo's env-var convention — this option exists so the guard is
   * testable without touching `process.env`.
   *
   * Boot-time only: nothing here verifies this value against any request to
   * `/api/snapshot`. See `bind-guard.ts`'s `assertBindAllowed` doc comment.
   */
  dashboardCredential?: string | undefined;
  /**
   * Absolute path to the built bundle (`dist/client/`). Required and injected
   * rather than derived here: this module is loaded from `dist/` in production
   * and from source under vitest, and a module-relative default would silently
   * resolve to the repo's `client/` directory — the Vite *source* template,
   * not the build output — in the second case.
   */
  bundleRoot: string;
  /**
   * The run the operator is looking at, for the snapshot's `mode` field.
   * Resolved by the caller from `SAMURAI_MODE` (`resolveStoreMode()`), the
   * same derivation that names the database file, so the page cannot claim a
   * mode the store disagrees with. No default: see `buildSnapshot`.
   */
  mode: StoreMode;
  /**
   * Live Alpaca/Polygon tiles. Optional — omitted, the snapshot reports both
   * as `not_configured`, which keeps this server constructible in tests and in
   * a credential-less environment.
   *
   * Note the handler only ever calls `readProviderStatus()`, a synchronous
   * read of the poller's last result. No request ever awaits a third-party
   * API, so a hung provider cannot stall a page load.
   */
  providers?: ProviderStatusReader;
}

export interface DashboardServer {
  /** Actual bound port (OS-assigned when constructed with port 0). */
  readonly port: number;
  readonly host: string;
  /** `http://host:port` using the actual bound port. */
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
} as const;

/**
 * The extensions this server will serve, and nothing else. An allow-list
 * rather than a lookup with an `application/octet-stream` fallback: an
 * unknown extension inside the bundle is either a Vite output nobody
 * anticipated or a file that has no business being fetched, and 404 is the
 * honest answer to both. Everything Vite emits for this app is here
 * (`.js`/`.css`/`.svg`/`.woff2`/`.woff` assets, `.map` sourcemaps,
 * `index.html`) — verified against a real `yarn build:web` output, not
 * assumed: `@fontsource` emits a `.woff` fallback beside every `.woff2` and
 * the built CSS references it 36 times, so the ticket's five-entry map would
 * have 404'd every font on a browser without woff2 support.
 */
export const BUNDLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Sourcemaps are JSON. Served so a stack trace in an operator's dev tools
  // points at real source rather than at a minified column number.
  '.map': 'application/json; charset=utf-8',
  // Binary — no charset. A `charset` on a font is meaningless at best.
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** `Content-Type` for a resolved bundle path, or `undefined` if not servable. */
export function bundleContentType(filePath: string): string | undefined {
  return BUNDLE_CONTENT_TYPES[extname(filePath).toLowerCase()];
}

/**
 * Maps a DECODED url path to an absolute path inside `root`, or `null` if it
 * escapes. Pure and exported so the containment rule can be tested directly:
 * over HTTP, both `new URL()` and `fetch()` normalise `..` segments away
 * before a request is ever sent, so an HTTP-level test of a literal `../`
 * escape asserts nothing about this guard (dashboard-spec.md "Testing
 * Decisions" makes the same point).
 *
 * **Containment, not string prefix.** `resolved.startsWith(root)` is NOT the
 * check: it accepts any sibling directory whose name merely begins with the
 * root's, so a `dist/client-evil/` next to `dist/client/`
 * escapes the bundle without using a single `..` segment. `path.relative`
 * asks about directory containment rather than about characters.
 *
 * The caller must decode percent-escapes EXACTLY ONCE before calling this. A
 * second decode would turn a legitimate filename containing a literal `%2e`
 * into a traversal, which is how double-decoding bugs are born; a
 * double-encoded `%252e%252e%252f` therefore names a file that does not exist
 * inside the bundle and gets a 404, which is correct.
 */
export function resolveBundlePath(root: string, urlPath: string): string | null {
  // A NUL byte truncates the path at the syscall boundary on some platforms,
  // so `/index.html\0.png` could pass an extension check and open something
  // else. Refuse rather than reason about it.
  if (urlPath.includes('\0')) return null;

  const requested = urlPath.replace(/^\/+/, '');
  const target = requested === '' ? 'index.html' : requested;
  const resolvedRoot = resolvePath(root);
  const resolved = resolvePath(resolvedRoot, target);

  const rel = relative(resolvedRoot, resolved);
  // `rel === ''` is the root directory itself — a directory, not a file, and
  // only `/` maps to `index.html`.
  if (rel === '') return null;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Whether `bundleRoot` holds a usable build, and if not, why — the diagnostic
 * text, or `null` when the bundle is fine. Synchronous so the entry point can
 * call it at boot (see `server/apps/service-api/index.ts`); the request path
 * calls it too, so a page load and the startup log say the same thing.
 *
 * Two distinct failures, because they have different fixes and only one of
 * them is visible as a missing file:
 *
 *  1. **No `index.html`.** Nobody ran `yarn build:web`. A bare 404 is the most
 *     confusing outcome the v2 changeover can produce — the process boots,
 *     `/api/snapshot` works, the page is blank — so this names the path and
 *     the command.
 *  2. **`index.html` is the Vite SOURCE template, not a build** (PR #597
 *     review). Running the server from source
 *     (`tsx server/apps/service-api/index.ts`) puts `bundleRoot` at the repo's
 *     `client/` directory, which DOES contain an
 *     `index.html` — the dev template, whose only script tag is
 *     `/src/main.tsx`. An existence check passes and the server then serves a
 *     page whose module 404s, which looks like a broken app rather than a
 *     wrong directory. The built file references `./assets/…` instead, so the
 *     dev-only reference is the thing to look for.
 */
export function bundleDiagnostic(root: string): string | null {
  const resolvedRoot = resolvePath(root);
  const indexPath = join(resolvedRoot, 'index.html');
  let html: string;
  try {
    html = readFileSync(indexPath, 'utf8');
  } catch {
    return (
      `Dashboard bundle not found: ${indexPath} does not exist.\n` +
      'The React client is built ahead of time and served from disk (ADR-0010).\n' +
      'Run `yarn build` (or `yarn build:web`) and reload. `GET /api/snapshot` is\n' +
      'unaffected and still serving JSON.\n'
    );
  }
  if (html.includes('/src/main.tsx')) {
    return (
      `Dashboard bundle not built: ${indexPath} is the Vite SOURCE template, not a\n` +
      'build — its only script tag is `/src/main.tsx`, which this server does not\n' +
      'compile and will never serve. This is what a server started from source\n' +
      '(`tsx server/apps/service-api/index.ts`) points at; the built bundle lives\n' +
      'in `dist/client/` and is what `node dist/server/apps/service-api/index.js`\n' +
      'resolves.\n' +
      'Run `yarn build` and start from `dist/`. `GET /api/snapshot` is unaffected.\n'
    );
  }
  return null;
}

export function createDashboardServer(opts: DashboardServerOptions): DashboardServer {
  // Runs first, synchronously, before anything below constructs a socket or
  // even resolves the bundle path: a refused bind must never get as far as
  // `server.listen()` (called later, from `start()`). Structural here rather
  // than only in `index.ts` — every caller of `createDashboardServer`
  // (`index.ts`, `fixture-server.ts`, and every test in this module) gets the
  // same guard with no separate call to remember. See `bind-guard.ts`.
  assertBindAllowed(opts.host, opts.dashboardCredential);

  const { host, store, mode } = opts;
  const bundleRoot = resolvePath(opts.bundleRoot);
  const providers = opts.providers ?? NULL_PROVIDER_STATUS;
  const requestedPort = opts.port;

  async function serveStatic(urlPath: string, res: ServerResponse) {
    const filePath = resolveBundlePath(bundleRoot, urlPath);
    const contentType = filePath === null ? undefined : bundleContentType(filePath);
    if (filePath === null || contentType === undefined) {
      await respondNotFound(res);
      return;
    }
    try {
      const body = await readFile(filePath);
      res
        .writeHead(200, {
          'Content-Type': contentType,
          // The bundle's asset filenames are content-hashed by Vite, but
          // `index.html` is not — and it is the file that names the current
          // hashes. Revalidating everything keeps a redeployed dashboard from
          // serving an operator a stale page; the cost is one conditional
          // request against localhost.
          'Cache-Control': 'no-cache',
        })
        .end(body);
    } catch {
      // ENOENT, EISDIR, EACCES — all of them mean "no file to serve here".
      await respondNotFound(res);
    }
  }

  /**
   * 404, unless the bundle itself is the problem — then say which problem.
   *
   * Re-checked per request rather than resolved once at construction: the
   * supervisor (`server/apps/supervisor/supervisor.ts`) must still boot a dashboard whose
   * bundle is absent — `/api/snapshot` is worth serving on its own — and a
   * build that lands after startup must start working without a restart.
   */
  async function respondNotFound(res: ServerResponse) {
    const diagnostic = bundleDiagnostic(bundleRoot);
    if (diagnostic !== null) {
      res
        .writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end(diagnostic);
      return;
    }
    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'not found' }));
  }

  const server: Server = createServer((req, res) => {
    // Every handler below is GET-only. A non-GET method is a 405 (not a
    // silent 404) so a misuse is obvious in dev tools.
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    // Parsed rather than string-compared so a query string cannot change
    // which handler runs, and so the static path is the URL's `pathname` and
    // nothing else.
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      // Malformed percent-escapes (`%zz`) — `decodeURIComponent` throws.
      res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'bad request' }));
      return;
    }

    if (urlPath === '/api/snapshot') {
      try {
        const snapshot = buildSnapshot(store, new Date(), mode, providers);
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify(snapshot));
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: renderResponderError(err) }));
      }
      return;
    }

    void serveStatic(urlPath, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: renderResponderError(err) }));
    });
  });

  let actualPort = requestedPort;

  return {
    get port() {
      return actualPort;
    },
    get host() {
      return host;
    },
    get url() {
      return `http://${host}:${actualPort}`;
    },
    start() {
      return new Promise((resolve) =>
        server.listen(requestedPort, host, () => {
          const addr = server.address();
          actualPort = typeof addr === 'object' && addr !== null ? addr.port : requestedPort;
          resolve();
        }),
      );
    },
    stop() {
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
