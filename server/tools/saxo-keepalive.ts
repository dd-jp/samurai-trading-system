import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Alerts } from '../apps/v2/alerts.js';
import { alertsFor } from '../apps/v2/alerts.js';
import type { SaxoKeepAliveState } from '../pipeline/execution/adapters/saxo-keepalive-state.js';
import {
  clearKeepAliveState,
  readKeepAliveState,
  writeKeepAliveState,
} from '../pipeline/execution/adapters/saxo-keepalive-state.js';
import type { FetchLike } from '../pipeline/execution/adapters/saxo-oauth.js';
import { resolveSaxoOAuthConfig } from '../pipeline/execution/adapters/saxo-oauth.js';
import { tokenFilePath } from '../pipeline/execution/adapters/saxo-token-file.js';
import type { SaxoSessionState } from '../pipeline/execution/adapters/saxo-token-source.js';
import { SaxoTokenRefresher } from '../pipeline/execution/adapters/saxo-token-source.js';
import type { Clock, LogEntry, Logger } from '../shared/index.js';
import { maskCredentials, SystemClock } from '../shared/index.js';

export const WARN_WHEN_REFRESH_REMAINING_MS = 20 * 60_000;

const TRACE_ID = 'saxo-keepalive';

export interface SaxoKeepAliveDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly tokenPath: string;
  readonly clock: Clock;
  readonly alerts: Pick<Alerts, 'logger' | 'flush'>;
  readonly journal: Logger;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
}

type Outcome =
  | { readonly kind: 'refreshed'; readonly state: SaxoSessionState & { status: 'active' } }
  | { readonly kind: 'failing'; readonly state: SaxoSessionState & { status: 'active' } }
  | { readonly kind: 'lost'; readonly reason: string };

function messageOf(error: unknown): string {
  return maskCredentials(error instanceof Error ? error.message : String(error));
}

async function renew(deps: SaxoKeepAliveDeps): Promise<Outcome> {
  let refresher: SaxoTokenRefresher;
  try {
    refresher = new SaxoTokenRefresher({
      environment: 'live',
      config: resolveSaxoOAuthConfig('live', deps.env),
      tokenPath: deps.tokenPath,
      logger: deps.journal,
      clock: deps.clock,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  } catch (cause) {
    return { kind: 'lost', reason: messageOf(cause) };
  }
  const state = await refresher.renewNow();
  await refresher.stop();
  if (state.status !== 'active') {
    return { kind: 'lost', reason: state.status === 'lost' ? state.reason : 'unrefreshable' };
  }
  return { kind: state.failedAttempts === 0 ? 'refreshed' : 'failing', state };
}

function journalRun(deps: SaxoKeepAliveDeps, outcome: Outcome): void {
  const payload =
    outcome.kind === 'lost'
      ? { outcome: outcome.kind, reason: outcome.reason }
      : {
          outcome: outcome.kind,
          access_token_expires_at: outcome.state.accessTokenExpiresAt,
          refresh_token_expires_at: outcome.state.refreshTokenExpiresAt,
          failed_attempts: outcome.state.failedAttempts,
        };
  deps.journal.log({
    trace_id: TRACE_ID,
    stage: 'orchestrator',
    level: outcome.kind === 'refreshed' ? 'info' : 'warn',
    event: 'saxo_keepalive_run',
    message: `Saxo live keep-alive ${outcome.kind}`,
    payload,
  });
}

function reportLost(deps: SaxoKeepAliveDeps, prior: SaxoKeepAliveState, reason: string): void {
  if (prior.lostAt !== undefined) return;
  writeKeepAliveState(deps.tokenPath, {
    ...prior,
    lostAt: deps.clock.now().toISOString(),
    lostReason: reason,
  });
  deps.alerts.logger.log({
    trace_id: TRACE_ID,
    stage: 'orchestrator',
    level: 'error',
    event: 'saxo_keepalive_session_lost',
    message: `Saxo live session lost: ${reason}. Run \`npm run saxo:login\`. The LSE leg is refused until then.`,
  });
}

function reportFailing(
  deps: SaxoKeepAliveDeps,
  prior: SaxoKeepAliveState,
  refreshExpiresAt: string,
): void {
  const remaining = Date.parse(refreshExpiresAt) - deps.clock.now().getTime();
  if (prior.warnedAt !== undefined || remaining > WARN_WHEN_REFRESH_REMAINING_MS) return;
  writeKeepAliveState(deps.tokenPath, { ...prior, warnedAt: deps.clock.now().toISOString() });
  deps.alerts.logger.log({
    trace_id: TRACE_ID,
    stage: 'orchestrator',
    level: 'warn',
    event: 'saxo_keepalive_refresh_failing',
    message: `Saxo live refresh keeps failing; the session dies at ${refreshExpiresAt} unless a refresh succeeds first`,
  });
}

function reportRecovered(deps: SaxoKeepAliveDeps, prior: SaxoKeepAliveState): void {
  if (prior.lostAt === undefined && prior.warnedAt === undefined) return;
  clearKeepAliveState(deps.tokenPath);
  deps.journal.log({
    trace_id: TRACE_ID,
    stage: 'orchestrator',
    level: 'info',
    event: 'saxo_keepalive_recovered',
    message: 'Saxo live session is refreshing again',
  });
}

function settle(deps: SaxoKeepAliveDeps, outcome: Outcome): number {
  const prior = readKeepAliveState(deps.tokenPath);
  if (outcome.kind === 'lost') reportLost(deps, prior, outcome.reason);
  else if (outcome.kind === 'failing') {
    reportFailing(deps, prior, outcome.state.refreshTokenExpiresAt);
  } else reportRecovered(deps, prior);
  return outcome.kind === 'refreshed' ? 0 : 1;
}

export async function runSaxoKeepAlive(deps: SaxoKeepAliveDeps): Promise<number> {
  try {
    const outcome = await renew(deps);
    journalRun(deps, outcome);
    return settle(deps, outcome);
  } finally {
    await deps.alerts.flush().catch(() => undefined);
  }
}

export function jsonlFileLogger(path: string, now: () => Date): Logger {
  return {
    log(entry: LogEntry): void {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const line = JSON.stringify({ ts: now().toISOString(), ...entry });
        appendFileSync(path, `${maskCredentials(line)}\n`);
      } catch {}
    },
  };
}

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${maskCredentials(JSON.stringify(entry))}\n`);
  },
};

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const clock = new SystemClock();
  const tokenPath = tokenFilePath('live');
  const journal = jsonlFileLogger(
    resolve(dirname(tokenPath), '..', 'logs', 'saxo-keepalive.jsonl'),
    () => clock.now(),
  );
  return runSaxoKeepAlive({
    env,
    tokenPath,
    clock,
    journal,
    alerts: alertsFor(argv, env, fetch, STDERR_LOGGER),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${messageOf(error)}\n`);
      process.exit(1);
    });
}
