import { fileURLToPath } from 'node:url';
import { DASHBOARD_CREDENTIAL_ENV_VAR, type TradingArm } from '../../shared/index.js';
import { resolveStoreMode } from '../../shared/store/index.js';
import { FIXTURE_NOW, InMemoryQueryStore } from './fixture-store.js';
import type { ProviderStatusPanel, ProviderStatusReader } from './provider-status.js';
import { createDashboardServer } from './server.js';
import type { VerdictAuditEntry } from './types.js';

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') {
    throw new Error(
      'fixture server refuses to start: PORT is unset. playwright.config.ts must pass the ' +
        'port it derived via e2e/support/port.ts through webServer.env.PORT.',
    );
  }
  const port = Number(raw);
  if (!isValidPort(port)) {
    throw new Error(
      `fixture server refuses PORT="${raw}": it must be an integer in 1-65535 (0 would bind an ephemeral port the harness URL could never reach)`,
    );
  }
  return port;
}

function fixtureVerdictTime(secondsAgo: number): Date {
  return new Date(FIXTURE_NOW.getTime() - secondsAgo * 1_000);
}

const E2E_VERDICTS: VerdictAuditEntry[] = [
  {
    trace_id: 'trace-p-eth',
    instrument: 'ETH-USD',
    status: 'no_go',
    reason: 'risk_correlation',
    hitl_override: true,
    timestamp: fixtureVerdictTime(112),
  },
  {
    trace_id: 'trace-p-btc',
    instrument: 'BTC-USD',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: fixtureVerdictTime(172),
  },
];

class E2eFixtureStore extends InMemoryQueryStore {
  override getVerdictHistory(limit: number, _asOf: Date, _arm: TradingArm): VerdictAuditEntry[] {
    return E2E_VERDICTS.slice(0, limit);
  }
}

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

const mode = resolveStoreMode();
if (mode !== 'paper') {
  throw new Error(
    `fixture server refuses SAMURAI_MODE=${mode}: it serves fabricated data and must never be labelled anything but paper`,
  );
}

const server = createDashboardServer({
  port: resolvePort(),
  host: process.env.HOST ?? '127.0.0.1',
  store: new E2eFixtureStore(),
  bundleRoot: fileURLToPath(new URL('../../../client/', import.meta.url)),
  mode,
  providers,
  dashboardCredential: process.env[DASHBOARD_CREDENTIAL_ENV_VAR],
});

await server.start();
console.log(`Samurai dashboard e2e fixture server → ${server.url}`);
