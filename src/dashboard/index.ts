/**
 * Dashboard entry point — `npm run dashboard`. Wires the real SQLite-backed
 * `QueryStore` (#161) into the read-only HTTP server. Mirrors
 * `src/orchestrator/index.ts` as a secondary entry point.
 *
 * File-path convention follows shared-sqlite-store-spec.md's "one file per
 * MODE": `data/samurai-{mode}.sqlite`, relative to the process's working
 * directory, selected via `SAMURAI_MODE` — which `resolveStoreMode` refuses to
 * default (#330). The path being relative is why the dashboard must be started
 * from the repo root: elsewhere `openSharedStore` creates and migrates an empty
 * database and the page renders healthy and blank. See README, "Running it
 * locally against real orchestrator data".
 *
 * Also starts the provider-status poller (provider-status.ts) for the Alpaca
 * balance and Polygon health tiles. Those are live third-party reads rather
 * than store reads, deliberately — see that module's header. Credentials are
 * OPTIONAL here: a missing key degrades the affected tile to `not_configured`
 * and never blocks startup, because the rest of the dashboard is still worth
 * serving without it.
 */
import { fileURLToPath } from 'node:url';
import { AlpacaHttpBrokerClient } from '../execution/index.js';
import { openSharedStore, resolveStoreMode, sharedStorePath } from '../shared/store/index.js';
import { ProviderStatusPoller } from './provider-status.js';
import { bundleDiagnostic, createDashboardServer } from './server.js';
import { SqliteQueryStore } from './sqlite-query-store.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
// Same resolver the orchestrator uses: the dashboard reads the file the
// orchestrator writes, so the two must not derive its name independently.
//
// #330's open question was how the READER derives a mode it is never told.
// The answer is that it does not derive one: `sharedStorePath` reads
// `SAMURAI_MODE` itself, through `resolveStoreMode`, so both sides resolve the
// same file from the same variable. A dashboard started without that variable
// refuses rather than showing a healthy, empty system from the wrong file.
//
// Resolved ONCE here and threaded through everything below (#539): the store
// path, the Alpaca environment, and the snapshot's `mode` field are three
// consequences of one variable, and the previous code derived the second of
// them independently (`process.env.SAMURAI_MODE === 'live'`). One derivation
// means the page cannot report a mode the database file disagrees with.
const mode = resolveStoreMode();
const db = openSharedStore(sharedStorePath(mode));

/**
 * The built Vite+React bundle (ADR-0010), resolved relative to THIS MODULE
 * rather than to `process.cwd()`: in production this file is
 * `dist/dashboard/index.js`, so its sibling is `dist/dashboard-web/`, and
 * that stays true whatever directory the supervisor or an operator started
 * the process from.
 */
const bundleRoot = fileURLToPath(new URL('../dashboard-web/', import.meta.url));

/**
 * Loud at boot, but NOT fatal (PR #597 review).
 *
 * The check exists because the failure is otherwise invisible until someone
 * opens a browser: started from source (`tsx src/dashboard/index.ts`) this
 * resolves to `src/dashboard-web/`, which contains the Vite dev template
 * rather than a build, so even a "does index.html exist" test passes while
 * the page it serves loads nothing. `bundleDiagnostic` distinguishes the two
 * cases and names the fix.
 *
 * Not fatal because the dashboard is a READ-ONLY OBSERVABILITY SURFACE and
 * `/api/snapshot` is its machine-readable half. Refusing to start would take
 * away the operator's view of an live trading system to punish a missing UI
 * build — and would take the supervisor's whole process group down with it
 * (`src/serve/supervisor.ts` stops the orchestrator when the dashboard dies),
 * so a forgotten `yarn build:web` would halt trading. That is the same
 * priority ordering the Alpaca tile below already follows: a degraded view
 * beats no view. The 503 on the page and this log say the same words.
 */
const bundleProblem = bundleDiagnostic(bundleRoot);
if (bundleProblem !== null) {
  console.error(`\n*** DASHBOARD UI NOT SERVABLE — /api/snapshot still up ***\n${bundleProblem}`);
}

/**
 * Paper unless `SAMURAI_MODE=live`, matching `buildDefaultBrokerClient`'s rule
 * (#293) rather than `AlpacaHttpBrokerClient`'s own default: live is reached
 * only by naming it. This client is used for exactly one read
 * (`GET /v2/account`) and never places an order — but it is still pointed at
 * the same environment the orchestrator trades in, because a paper balance
 * displayed while live positions are open would be worse than no balance.
 */
function buildAlpacaClient(): AlpacaHttpBrokerClient | undefined {
  try {
    return new AlpacaHttpBrokerClient({
      environment: mode === 'live' ? 'live' : 'paper',
    });
  } catch (error) {
    // The constructor throws when the keys are absent. That is fatal for the
    // orchestrator and merely a missing tile here, so it is caught rather than
    // propagated — the operator still gets positions, verdicts and metrics off
    // the store.
    console.warn(
      `Alpaca balance tile disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

const providers = new ProviderStatusPoller({ alpaca: buildAlpacaClient() });

const server = createDashboardServer({
  port,
  host,
  store: new SqliteQueryStore(db),
  bundleRoot,
  mode,
  providers,
});

await server.start();
// Started after the server is listening, and not awaited: the first poll makes
// two network calls, and holding the page hostage to a slow third party would
// invert the priority — the store-backed views need no provider at all.
void providers.start();

console.log(`Samurai dashboard → ${server.url}`);
console.log('Read-only operator view. Ctrl+C to stop.');
