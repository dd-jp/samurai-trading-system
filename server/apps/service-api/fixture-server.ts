/**
 * The Playwright harness entry (#544): the REAL dashboard server — same
 * `createDashboardServer`, same static handler, same `buildSnapshot` — over a
 * fixture `DashboardQueryStore` instead of SQLite.
 *
 * **This process opens no database.** It never calls `sharedStorePath()` or
 * `openSharedStore()`, so it cannot create, migrate or touch
 * `data/samurai-*.sqlite` — including the file a live paper soak is writing.
 * The store seam is the only thing swapped; everything the browser talks to
 * (the bundle bytes, the JSON projection, the wire shape) is production code.
 *
 * **It makes no third-party calls.** `server/apps/service-api/index.ts` builds an
 * `AlpacaHttpBrokerClient` and starts `ProviderStatusPoller`, which probe
 * Alpaca and Polygon over the network; this entry passes a static
 * `ProviderStatusReader` instead, so the suite's "zero external network"
 * acceptance criterion holds at the server as well as in the browser.
 *
 * `SAMURAI_MODE` is still mandatory and still resolved by `resolveStoreMode()`
 * — the one derivation the production entry uses — so the page under test
 * reports its mode the same way the real one does.
 */
import { fileURLToPath } from 'node:url';
import type { TradingArm } from '../../shared/index.js';
import { resolveStoreMode } from '../../shared/store/index.js';
import { DASHBOARD_CREDENTIAL_ENV_VAR } from './bind-guard.js';
import { FIXTURE_NOW, InMemoryQueryStore } from './fixture-store.js';
import type { ProviderStatusPanel, ProviderStatusReader } from './provider-status.js';
import { createDashboardServer } from './server.js';
import type { VerdictAuditEntry } from './types.js';

/**
 * `PORT` is mandatory (#1298) — `playwright.config.ts` picks it once, via
 * `e2e/support/port.ts`, and passes it down through `webServer.env.PORT`.
 * There is no fallback default here on purpose: a default would be a second
 * place holding a port number that the config's value could silently drift
 * from, and validation would never catch it because a hardcoded fallback is
 * always "valid".
 *
 * Validated rather than handed to `listen()` as a `NaN`: an unparseable value
 * fails inside the socket layer with a message that names neither the
 * variable nor this process, and the Playwright output would show only
 * "webServer was not able to start".
 *
 * `0` is rejected for the same reason it is legal elsewhere. It asks the OS
 * for an ephemeral port, which is exactly right for a process that reads its
 * own bound port back — and useless here, because Playwright's config derives
 * the URL it polls (and hands this process its `PORT`) BEFORE this process
 * starts. A port this process chose only after that would be unreachable, and
 * the run would die on an opaque readiness timeout instead.
 */
function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') {
    throw new Error(
      'fixture server refuses to start: PORT is unset. playwright.config.ts must pass the ' +
        'port it derived via e2e/support/port.ts through webServer.env.PORT.',
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `fixture server refuses PORT="${raw}": it must be an integer in 1-65535 (0 would bind an ephemeral port the harness URL could never reach)`,
    );
  }
  return port;
}

/**
 * Verdict rows whose `trace_id`s are the PIPELINE fixture's trace ids.
 *
 * `InMemoryQueryStore`'s own verdict history uses a separate id space
 * (`trace-001`…), so every ledger row's `verdictsByTrace.get(entry.trace_id)`
 * misses and the gate wording, the HITL badge and the drawer's verdict line
 * are all unreachable — the three things scenario 4 exists to assert. Aligning
 * the ids is what puts them on screen.
 *
 * ETH carries `hitl_override` so the badge is rendered from the first paint,
 * without the suite having to drive a settle first.
 *
 * Timestamps are offsets from `FIXTURE_NOW` — the same fixed clock every other
 * fixture in `fixture-store.ts` is written against — so a verdict cannot drift
 * away from the pipeline row it describes. The whole fixture set is pinned to
 * one instant rather than to the wall clock, and nothing on this page renders
 * an AGE: the ledger, the drawer and the strip all print an absolute UTC time,
 * and the 15-minute pipeline window is applied by the SQLite store, not by
 * this one.
 */
function fixtureVerdictTime(secondsAgo: number): Date {
  return new Date(FIXTURE_NOW.getTime() - secondsAgo * 1_000);
}

/**
 * Newest first, matching `SqliteQueryStore.getVerdictHistory` — which is also
 * what makes the inherited `slice(0, limit)` keep the RECENT rows rather than
 * the oldest ones. Consumers join by `trace_id`, but a fixture whose order
 * contradicted the real store would be a lie the day one of them reads
 * `verdicts[0]`.
 */
const E2E_VERDICTS: VerdictAuditEntry[] = [
  {
    trace_id: 'trace-p-eth',
    instrument: 'ETH-USD',
    status: 'no_go',
    reason: 'risk_correlation',
    hitl_override: true,
    // The ETH lane's Verdict row, to the second.
    timestamp: fixtureVerdictTime(112),
  },
  {
    trace_id: 'trace-p-btc',
    instrument: 'BTC-USD',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    // The BTC lane's Execution row is 170s old; its verdict is the row before it.
    timestamp: fixtureVerdictTime(172),
  },
];

/** The fixture store, with its verdict history joined to the pipeline fixtures. */
class E2eFixtureStore extends InMemoryQueryStore {
  override getVerdictHistory(limit: number, _asOf: Date, _arm: TradingArm): VerdictAuditEntry[] {
    return E2E_VERDICTS.slice(0, limit);
  }
}

/**
 * A polled panel, frozen. `ok` with a balance rather than `NULL_PROVIDER_STATUS`
 * so the Alpaca tile renders numbers and the metrics sparkline receives a
 * sample — the not-configured rendering is a different (also real) state, and
 * the suite asserts the populated one.
 */
const FIXTURE_PROVIDERS: ProviderStatusPanel = {
  alpaca: {
    provider: 'alpaca',
    state: 'ok',
    detail: '',
    observed_at: '2026-07-19T14:29:00.000Z',
    balance: { cash: 24_180.55, equity: 101_402.31, buying_power: 48_361.1 },
  },
  polygon: {
    provider: 'polygon',
    state: 'ok',
    detail: 'free tier · 5 req/min',
    observed_at: '2026-07-19T14:29:00.000Z',
  },
};

const providers: ProviderStatusReader = {
  readProviderStatus: () => FIXTURE_PROVIDERS,
};

/**
 * Resolved the way the production entry resolves it — and then PINNED.
 *
 * `resolveStoreMode()` reads whatever `SAMURAI_MODE` the shell holds, so a
 * developer with `live` exported who runs this file directly would get a page
 * labelled LIVE over fabricated positions, verdicts and a fabricated broker
 * balance. That is the one mislabelling this codebase treats as unacceptable
 * (see the `mode` field's docblock in `types.ts`), and it costs nothing to
 * refuse: the harness sets the variable explicitly in `playwright.config.ts`.
 */
const mode = resolveStoreMode();
if (mode !== 'paper') {
  throw new Error(
    `fixture server refuses SAMURAI_MODE=${mode}: it serves fabricated data and must never be labelled anything but paper`,
  );
}

const server = createDashboardServer({
  port: resolvePort(),
  // #887/ADR-0019: same `HOST` pattern as `index.ts`, and deliberately NOT
  // excluded from the bind guard even though this process serves fabricated
  // data rather than a real book. `createDashboardServer` enforces the guard
  // structurally (`bind-guard.ts`), so this harness inherits the identical
  // fail-closed behaviour for free rather than needing its own copy — there
  // is no reason a Playwright run should be able to publish a fake book to
  // the LAN unauthenticated when the real dashboard cannot.
  host: process.env.HOST ?? '127.0.0.1',
  store: new E2eFixtureStore(),
  // Same module-relative resolution as `index.ts`: this file is
  // `dist/server/apps/service-api/fixture-server.js` in the only form
  // Playwright runs it, so three levels up is `dist/` and the built bundle is
  // `dist/client/`. Must stay in step with `index.ts` — they resolve the same
  // directory from the same depth, and only the e2e run exercises this one.
  bundleRoot: fileURLToPath(new URL('../../../client/', import.meta.url)),
  mode,
  providers,
  dashboardCredential: process.env[DASHBOARD_CREDENTIAL_ENV_VAR],
});

await server.start();
console.log(`Samurai dashboard e2e fixture server → ${server.url}`);
