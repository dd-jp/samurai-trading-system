/**
 * Dashboard entry point — `npm run dashboard`. Wires the real SQLite-backed
 * `QueryStore` (#161) into the read-only HTTP server. Mirrors
 * `src/orchestrator/index.ts` as a secondary entry point.
 *
 * File-path convention matches every other component's shared-store wiring
 * (shared-sqlite-store-spec.md): `data/samurai-{env}.sqlite` at repo root,
 * selected via `NODE_ENV` (defaults to `development`).
 */
import { openSharedStore } from '../shared/store/open-shared-store.js';
import { createDashboardServer } from './server.js';
import { SqliteQueryStore } from './sqlite-query-store.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const env = process.env.NODE_ENV ?? 'development';

const db = openSharedStore(`data/samurai-${env}.sqlite`);
const server = createDashboardServer({ port, host, store: new SqliteQueryStore(db) });

await server.start();
console.log(`Samurai dashboard → ${server.url}`);
console.log('Read-only operator view. Ctrl+C to stop.');
