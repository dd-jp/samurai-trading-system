/**
 * Dashboard HTTP server — a thin, read-only transport over `buildSnapshot`.
 * Uses Node 22's built-in `http` module: zero new runtime dependencies (the
 * project currently has none; ADR-0001's TS core has no express/fastify).
 *
 * Two handlers, both `GET`:
 *   - `GET /`            → the single-page dashboard HTML (src/dashboard/html.ts)
 *   - `GET /api/snapshot` → `buildSnapshot(store, now)` as JSON
 *   - everything else     → 404
 *
 * No `POST`/`PUT`/`DELETE` handlers exist by construction (dashboard-spec.md "Any
 * write path ... strictly read-only") — the dashboard can never place, block,
 * or modify a trade. The server's blast radius is exactly "an operator reads
 * something," same as the CLI.
 */
import { createServer, type Server } from 'node:http';
import { DASHBOARD_HTML } from './html.js';
import { buildSnapshot } from './snapshot.js';
import type { DashboardQueryStore } from './types.js';

export interface DashboardServerOptions {
  port: number;
  host: string;
  store: DashboardQueryStore;
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
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' } as const;

export function createDashboardServer(opts: DashboardServerOptions): DashboardServer {
  const { host, store } = opts;
  const requestedPort = opts.port;

  const server: Server = createServer((req, res) => {
    // Every handler below is GET-only. A non-GET method to a known path is a
    // 405 (not a silent 404) so a misuse is obvious in dev tools.
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    const path = req.url ?? '/';

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, HTML_HEADERS).end(DASHBOARD_HTML);
      return;
    }

    if (path === '/api/snapshot') {
      try {
        const snapshot = buildSnapshot(store, new Date());
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify(snapshot));
      } catch (err) {
        res
          .writeHead(500, JSON_HEADERS)
          .end(JSON.stringify({ error: err instanceof Error ? err.message : 'snapshot failed' }));
      }
      return;
    }

    res.writeHead(404, JSON_HEADERS).end(JSON.stringify({ error: 'not found' }));
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
