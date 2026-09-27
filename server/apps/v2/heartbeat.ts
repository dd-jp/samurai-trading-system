import type { Logger } from '../../shared/index.js';

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

export const NO_HEARTBEAT: Heartbeat = () => Promise.resolve();

export function healthchecksHeartbeat(
  pingUrl: string | undefined,
  fetchImpl: Fetch,
  logger: Logger,
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
      if (response.ok) log('info', 'v2_heartbeat_sent', `healthchecks ${outcome} ping sent`);
      else log('warn', 'v2_heartbeat_failed', `healthchecks answered ${response.status}`);
    } catch {
      // The fetch error text can carry the ping URL, which is a secret
      log('warn', 'v2_heartbeat_failed', `healthchecks ${outcome} ping did not complete`);
    }
  };
}

export async function withHeartbeat(run: () => Promise<number>, beat: Heartbeat): Promise<number> {
  let code: number;
  try {
    code = await run();
  } catch (error) {
    await beat('fail');
    throw error;
  }
  await beat(code === 0 ? 'success' : 'fail');
  return code;
}
