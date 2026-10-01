import type { Clock, Logger } from '../../shared/index.js';
import { guardedStore, openMigratedStore } from '../../shared/store/index.js';

export type HeartbeatOutcome = 'success' | 'fail';

export type Heartbeat = (outcome: HeartbeatOutcome) => Promise<void>;

type Fetch = (
  url: string,
  init: { method: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
}>;

const PING_TIMEOUT_MS = 10_000;

const PING_SCHEMA_VERSION = 82;

export type PingSink = (outcome: HeartbeatOutcome) => void;

export const NO_HEARTBEAT: Heartbeat = () => Promise.resolve();

export function heartbeatFor(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: Fetch,
  logger: Logger,
  onSent?: PingSink,
): Heartbeat {
  return argv.includes('--dry-run')
    ? NO_HEARTBEAT
    : healthchecksHeartbeat(env.HEALTHCHECKS_PING_URL, fetchImpl, logger, onSent);
}

export function pingJournal(storePath: string, clock: Clock): PingSink {
  return (outcome) => {
    const db = openMigratedStore(storePath, PING_SCHEMA_VERSION);
    try {
      guardedStore(db, 'v2')
        .prepare('INSERT INTO v2_heartbeat_pings (outcome, pinged_at) VALUES (?, ?)')
        .run(outcome, clock.now().toISOString());
    } finally {
      db.close();
    }
  };
}

export function healthchecksHeartbeat(
  pingUrl: string | undefined,
  fetchImpl: Fetch,
  logger: Logger,
  onSent?: PingSink,
): Heartbeat {
  const base = pingUrl?.trim().replace(/\/+$/, '') ?? '';
  const log = (level: 'info' | 'warn', event: string, message: string) =>
    logger.log({ trace_id: 'v2-heartbeat', stage: 'v2', level, event, message });
  if (base === '') {
    return () => {
      log('warn', 'v2_heartbeat_unset', 'HEALTHCHECKS_PING_URL is not set: no dead-man ping sent');
      return Promise.resolve();
    };
  }
  return async (outcome) => {
    const url = outcome === 'fail' ? `${base}/fail` : base;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (response.ok) {
        log('info', 'v2_heartbeat_sent', `healthchecks ${outcome} ping sent`);
        journalPing(onSent, outcome, log);
      } else log('warn', 'v2_heartbeat_failed', `healthchecks answered ${response.status}`);
    } catch {
      // The fetch error text can carry the ping URL, which is a secret
      log('warn', 'v2_heartbeat_failed', `healthchecks ${outcome} ping did not complete`);
    }
  };
}

function journalPing(
  onSent: PingSink | undefined,
  outcome: HeartbeatOutcome,
  log: (level: 'info' | 'warn', event: string, message: string) => void,
): void {
  try {
    onSent?.(outcome);
  } catch {
    log('warn', 'v2_heartbeat_unjournaled', `the ${outcome} ping was sent but not journalled`);
  }
}

export async function withHeartbeat(run: () => Promise<number>, beat: Heartbeat): Promise<number> {
  let code: number;
  try {
    code = await run();
  } catch (error) {
    await beat('fail').catch(() => undefined);
    throw error;
  }
  await beat(code === 0 ? 'success' : 'fail');
  return code;
}
