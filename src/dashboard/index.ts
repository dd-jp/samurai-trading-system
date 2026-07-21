/**
 * Dashboard entry point — `npm run dashboard`. Wires the in-memory fixture
 * `QueryStore` (the same one the real SQLite-backed store will later replace)
 * into the read-only HTTP server. Mirrors `src/orchestrator/index.ts` as a
 * secondary entry point.
 *
 * The fixture store makes the dashboard demoable today, before the shared
 * SQLite store exists anywhere in the codebase. Swapping to the real store is
 * a one-line change here (the `DashboardQueryStore` port is unchanged).
 */
import { InMemoryQueryStore } from './fixture-store.js';
import { createDashboardServer } from './server.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const server = createDashboardServer({ port, host, store: new InMemoryQueryStore() });

await server.start();
console.log(`Samurai dashboard → ${server.url}`);
console.log('Read-only operator view. Ctrl+C to stop.');
