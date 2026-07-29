/**
 * Dashboard entry point — `npm run dashboard`. Wires the real SQLite-backed
 * `QueryStore` (#161) into the read-only HTTP server. Mirrors
 * `src/orchestrator/index.ts` as a secondary entry point.
 *
 * File-path convention follows shared-sqlite-store-spec.md's "one file per
 * environment": `data/samurai-{env}.sqlite` at repo root, selected via
 * `NODE_ENV` (defaults to `development`).
 */
import { openSharedStore, sharedStorePath } from '../shared/store/open-shared-store.js';
import { createDashboardServer } from './server.js';
import { SqliteQueryStore } from './sqlite-query-store.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
// Same resolver the orchestrator uses: the dashboard reads the file the
// orchestrator writes, so the two must not derive its name independently.
const db = openSharedStore(sharedStorePath());
const server = createDashboardServer({ port, host, store: new SqliteQueryStore(db) });

await server.start();
console.log(`Samurai dashboard → ${server.url}`);
console.log('Read-only operator view. Ctrl+C to stop.');
