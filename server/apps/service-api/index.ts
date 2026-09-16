/**
 * Dashboard entry point — `npm run dashboard`. Wires the real SQLite-backed
 * `QueryStore` (#161) into the read-only HTTP server. Mirrors
 * `server/apps/orchestrator/index.ts` as a secondary entry point.
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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlpacaHttpBrokerClient } from '../../pipeline/execution/index.js';
import type { LogEventCode } from '../../shared/index.js';
import {
  guardedStore,
  openSharedStore,
  resolveStoreMode,
  sharedStorePath,
} from '../../shared/store/index.js';
import { JsonLogger } from '../orchestrator/logger.js';
import { DASHBOARD_CREDENTIAL_ENV_VAR } from './bind-guard.js';
import { installDashboardContinueOnFault, watchDashboardStdout } from './fault-guard.js';
import { ProviderStatusPoller } from './provider-status.js';
import { bundleDiagnostic, createDashboardServer } from './server.js';
import { SqliteQueryStore } from './sqlite-query-store.js';

// #764: installed before anything else in this file writes a line — the
// bundle-diagnostic warn below is the earliest `console.*` call, and
// `console.log`/`console.error` write through `process.stdout`/`process.stderr`
// the same way a raw write does. See `fault-guard.ts` for the measurement and
// why the arbitrary-fault handler (installed further down, after boot) is a
// separate call installed at a separate time
watchDashboardStdout();

/**
 * The dashboard's structured logger (#1035).
 *
 * Before this, both shipped non-orchestrator entrypoints wrote bare
 * `console.*`, so their lines carried no `trace_id`, no `stage` and no level —
 * unparseable next to every other line the system emits, and invisible to any
 * reader that filters the log by stage.
 *
 * Stdout-only, and deliberately NOT `buildEntrypointLogger`: that opens a
 * `RotatingFileSink` on `SAMURAI_LOG_FILE`, and this process runs ALONGSIDE
 * the orchestrator under `npm run serve`. Two processes rotating the same file
 * race each other's renames, which is a way to lose the durable trace the file
 * exists to hold — a worse outcome than the one being fixed. The supervisor
 * captures this process's stdout, so these lines still land on disk; they just
 * arrive there as captured output rather than through a second rotator.
 *
 * `trace_id: 'startup'` matches the sentinel `logger.ts` already uses for
 * lines that belong to the process rather than to a tick.
 */
const logger = new JsonLogger();
const bootLog = (
  level: 'info' | 'warn' | 'error',
  event: LogEventCode,
  message: string,
  payload?: unknown,
) => {
  logger.log({ trace_id: 'startup', stage: 'dashboard', event, level, message, payload });
};

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
// #887/ADR-0019: the ONLY thing that made a non-loopback HOST here safe was
// this variable being unset. `createDashboardServer` (`server.ts`) now
// refuses to start when `host` resolves outside the loopback allowlist and
// this is absent — see `bind-guard.ts` for the conjunctive condition. Reading
// `process.env` here (an entry point) rather than inside `server.ts` follows
// this repo's env-var convention: composition code takes a config field, not
// a mid-wiring env read
const dashboardCredential = process.env[DASHBOARD_CREDENTIAL_ENV_VAR];
// Same resolver the orchestrator uses: the dashboard reads the file the
// orchestrator writes, so the two must not derive its name independently
//
// #330's open question was how the READER derives a mode it is never told
// The answer is that it does not derive one: `sharedStorePath` reads
// `SAMURAI_MODE` itself, through `resolveStoreMode`, so both sides resolve the
// same file from the same variable. A dashboard started without that variable
// refuses rather than showing a healthy, empty system from the wrong file
//
// Resolved ONCE here and threaded through everything below (#539): the store
// path, the Alpaca environment, and the snapshot's `mode` field are three
// consequences of one variable, and the previous code derived the second of
// them independently (`process.env.SAMURAI_MODE === 'live'`). One derivation
// means the page cannot report a mode the database file disagrees with
const mode = resolveStoreMode();
const dbPath = sharedStorePath(mode);
// #837 M9: the dashboard process is a READER. `'service-api'` declares an empty
// write set, so any INSERT/REPLACE/UPDATE/DELETE issued in this process — to
// any table at all — throws in dev/CI, which turns the spec's "service-api is
// a reader only" from a review convention into an assertion
//
// DML only, and the guard says so itself (write-guard.ts, limit 4): `CREATE`,
// `DROP` and `ALTER` are not scanned, so this declaration does not prove the
// process cannot touch the schema. Detection where it plausibly goes wrong,
// not a sandbox
const db = guardedStore(openSharedStore(dbPath), 'service-api');
// #940: `sharedStorePath` returns a path RELATIVE to the process's working
// directory (see file header), so two processes started from different
// directories can silently open two different files — a trade lands in one
// and the dashboard reads the other, with no error and no visible trace
// anywhere. Naming the resolved absolute path at boot is the one thing that
// would have made that mismatch visible instead of merely fixable in
// hindsight
bootLog('info', 'dashboard_store_resolved', `Samurai dashboard store → ${resolve(dbPath)}`, {
  store_path: resolve(dbPath),
  mode,
});

/**
 * The built Vite+React bundle (ADR-0010), resolved relative to THIS MODULE
 * rather than to `process.cwd()`: in production this file is
 * `dist/server/apps/service-api/index.js`, so three levels up is `dist/` and
 * the bundle is `dist/client/`. That stays true whatever directory the
 * supervisor or an operator started the process from.
 *
 * The depth is load-bearing and `tsc` cannot check it — this is a runtime URL,
 * not an import. `bundleDiagnostic` below is what catches a wrong answer.
 */
const bundleRoot = fileURLToPath(new URL('../../../client/', import.meta.url));

/**
 * Loud at boot, but NOT fatal (PR #597 review).
 *
 * The check exists because the failure is otherwise invisible until someone
 * opens a browser: started from source (`tsx server/apps/service-api/index.ts`)
 * this resolves to the repo's `client/` directory, which contains the Vite dev
 * template rather than a build, so even a "does index.html exist" test passes
 * while the page it serves loads nothing. `bundleDiagnostic` distinguishes the
 * two cases and names the fix.
 *
 * Not fatal because the dashboard is a READ-ONLY OBSERVABILITY SURFACE and
 * `/api/snapshot` is its machine-readable half. Refusing to start would take
 * away the operator's view of an live trading system to punish a missing UI
 * build — and would take the supervisor's whole process group down with it
 * (`server/apps/supervisor/supervisor.ts` stops the orchestrator when the dashboard dies),
 * so a forgotten `npm run build:web` would halt trading. That is the same
 * priority ordering the Alpaca tile below already follows: a degraded view
 * beats no view. The 503 on the page and this log say the same words.
 */
const bundleProblem = bundleDiagnostic(bundleRoot);
if (bundleProblem !== null) {
  bootLog(
    'error',
    'dashboard_bundle_unservable',
    'dashboard UI not servable — /api/snapshot is still up',
    {
      bundle_problem: bundleProblem,
    },
  );
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
    // the store
    bootLog('warn', 'dashboard_balance_tile_disabled', 'Alpaca balance tile disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

const providers = new ProviderStatusPoller({ alpaca: buildAlpacaClient() });

/**
 * The escalation chat the `alert_delivery_failures` tile (#1108) scopes its
 * count to — read here, not inside `SqliteQueryStore`, per this repo's
 * env-var convention (composition code takes a config field; see
 * `docs/coding-standards.md`, "Environment variables"). Normalized the same
 * way `alert-transport.ts`'s `requireEnv` normalizes it for the orchestrator
 * (trimmed, empty-as-unset) so the two processes — which load the same
 * `.env.local` under `npm run serve`/`npm run dashboard` — agree on what counts as
 * "configured".
 *
 * Absent is a real, common state: it is exactly what `SAMURAI_ALERTS=log-only`
 * leaves it at, and under that mode the orchestrator never constructs a
 * `TelegramBotApiClient` either, so no real row ever lands in
 * `alert_delivery_failures`. The tile then correctly reads 0 — but named at
 * boot below rather than reached silently, so an operator who expected
 * `telegram` mode and sees this warning knows the tile cannot tell them
 * anything, rather than reading a healthy 0.
 *
 * A set-but-WRONG value is NOT warned on, and #1130 turns that from a
 * hypothetical into a live gap: the tile is now the sole channel-down
 * surface, so filtering on a chat nothing ever wrote to returns 0, renders
 * no tile, and reads exactly like a healthy channel. It is not warned on
 * because this process never sees the orchestrator's value (separate
 * process, no shared handshake) — but "no local signal exists" would be
 * false, and #1130 review round 3 was right to say so. `chat_id` is stored
 * per row (migration 0043), and the only path that writes rows is
 * `alert-transport.ts`'s telegram branch — the one place in the tree that
 * supplies a `TelegramBotApiClient` with an `alertDeliveryLog` at all — so
 * at most two ids appear in this table per configuration: `sendMessage` is
 * the only caller of `#recordDeliveryFailure`,
 * posting to a chat that branch fixes from env (`TELEGRAM_CHAT_ID`, or
 * `TELEGRAM_HEARTBEAT_CHAT_ID` for the beat when it builds the heartbeat
 * itself), and `alert-transport.ts` refuses to start when those two are
 * equal (#342). A caller-injected `ProductionConfig.heartbeatChannel`
 * subtracts rather than adds — the beat then never crosses this client, and
 * no heartbeat chat id is read (see the second bullet below) — and smoke,
 * which injects every `ALERT_CHANNEL_FIELDS` member, leaves
 * `resolveAlertsMode` returning `undefined`, so no `TelegramBotApiClient` is
 * constructed there and its log-only heartbeat writes nothing. The
 * table is also durable across runs, so rotating `TELEGRAM_CHAT_ID` leaves a
 * third, historical id behind rather than clearing it — so the two-id
 * scoping above understates the signal's false-fire surface, which
 * strengthens the decline below rather than undermining it. So "rows exist
 * whose `chat_id` is neither of those two" would fire on a chat mismatch or
 * a stale id from a prior configuration, and NOT on an ordinary heartbeat
 * hiccup — the beat's rows are excluded by name, not by the alert-chat
 * filter. It is declined anyway, on three grounds and not on the false one:
 *
 *  - It is post-hoc. It can only fire once a send has already failed, i.e.
 *    after the tile has already failed to warn, while the boot warning it
 *    would sit beside runs when the table is typically empty. It annotates
 *    the gap late rather than closing it.
 *  - It is not free of false fires. A caller-supplied
 *    `ProductionConfig.heartbeatChannel` (`production/config.ts`) opts out of
 *    `TELEGRAM_HEARTBEAT_CHAT_ID` entirely, so a beat routed to some third
 *    chat over a client sharing this store would look like a mismatch; no
 *    in-tree caller does that today (smoke injects the log-only heartbeat),
 *    which is why this is a hedge, not a measurement. A service-api env wrong
 *    on BOTH vars is not a false fire — the tile is genuinely misconfigured
 *    then, and firing is correct.
 *  - It is a mechanism change regardless: a new store query, a second env var
 *    read here, and a check on the poll path — outside #1130's docs-only
 *    remit, and it would not remove the need for the real fix.
 *
 * The real fix is that handshake (the orchestrator publishing the chat it
 * alerts on, this process comparing against it). Documented instead at both
 * read sites:
 * `types.ts`'s `getAlertDeliveryFailureCount` and
 * `client/src/components/Rail.tsx`'s `AlertDeliveryBlock`.
 */
const alertChatId = ((): string | undefined => {
  const raw = (process.env.TELEGRAM_CHAT_ID ?? '').trim();
  return raw.length === 0 ? undefined : raw;
})();
if (alertChatId === undefined) {
  bootLog(
    'warn',
    'dashboard_alert_tile_disabled',
    'alert-channel-failure tile disabled: TELEGRAM_CHAT_ID is not set',
    {
      note:
        'expected under SAMURAI_ALERTS=log-only; alert_delivery_failures will read 0 rather ' +
        'than filter on an unknown chat',
    },
  );
}

const server = createDashboardServer({
  port,
  host,
  store: new SqliteQueryStore(db, 30, alertChatId),
  bundleRoot,
  mode,
  providers,
  dashboardCredential,
});

await server.start();

// #764: installed only after boot succeeds — `resolveStoreMode()` (#330) and
// `openSharedStore` above refuse on purpose, and a continue-posture handler
// installed before they run would risk swallowing exactly the refusal they
// exist to surface. A fault during boot still stops the process; only a
// fault while serving continues from here on. See `fault-guard.ts`.
installDashboardContinueOnFault();

// Started after the server is listening, and not awaited: the first poll makes
// two network calls, and holding the page hostage to a slow third party would
// invert the priority — the store-backed views need no provider at all
void providers.start();

bootLog('info', 'dashboard_listening', `Samurai dashboard → ${server.url}`, {
  url: server.url,
  note: 'read-only operator view; Ctrl+C to stop',
});
