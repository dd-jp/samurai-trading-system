import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlpacaHttpBrokerClient } from '../../pipeline/execution/index.js';
import { DASHBOARD_CREDENTIAL_ENV_VAR, type LogEventCode } from '../../shared/index.js';
import {
  guardedStore,
  openSharedStore,
  resolveStoreMode,
  sharedStorePath,
} from '../../shared/store/index.js';
import { JsonLogger } from '../orchestrator/index.js';
import { installDashboardContinueOnFault, watchDashboardStdout } from './fault-guard.js';
import { ProviderStatusPoller } from './provider-status.js';
import { bundleDiagnostic, createDashboardServer } from './server.js';
import { SqliteQueryStore } from './sqlite-query-store.js';

watchDashboardStdout();

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
const dashboardCredential = process.env[DASHBOARD_CREDENTIAL_ENV_VAR];
const mode = resolveStoreMode();
const dbPath = sharedStorePath(mode);
const db = guardedStore(openSharedStore(dbPath), 'service-api');
bootLog('info', 'dashboard_store_resolved', `Samurai dashboard store → ${resolve(dbPath)}`, {
  store_path: resolve(dbPath),
  mode,
});

const bundleRoot = fileURLToPath(new URL('../../../client/', import.meta.url));

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

function buildAlpacaClient(): AlpacaHttpBrokerClient | undefined {
  try {
    return new AlpacaHttpBrokerClient({
      environment: mode === 'live' ? 'live' : 'paper',
    });
  } catch (error) {
    bootLog('warn', 'dashboard_balance_tile_disabled', 'Alpaca balance tile disabled', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

const providers = new ProviderStatusPoller({ alpaca: buildAlpacaClient() });

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

installDashboardContinueOnFault();

void providers.start();

bootLog('info', 'dashboard_listening', `Samurai dashboard → ${server.url}`, {
  url: server.url,
  note: 'read-only operator view; Ctrl+C to stop',
});
