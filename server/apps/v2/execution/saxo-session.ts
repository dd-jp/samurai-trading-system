import { readKeepAliveState, writeKeepAliveState } from './saxo/saxo-keepalive-state.js';
import { readTokenFile, type SaxoTokenFileRecord, tokenFilePath } from './saxo/saxo-token-file.js';
import { SaxoSessionLostError } from './saxo/saxo-token-source.js';

const LOGIN = 'run `npm run saxo:login`';

function readSession(tokenPath: string): SaxoTokenFileRecord | string {
  try {
    return readTokenFile(tokenPath) ?? `no saved Saxo live session: ${LOGIN}`;
  } catch {
    return `the Saxo live token file is unreadable: ${LOGIN}`;
  }
}

function lostSinceIssue(tokenPath: string, session: SaxoTokenFileRecord): string | undefined {
  const { lostAt, lostReason } = readKeepAliveState(tokenPath);
  if (lostAt === undefined || Date.parse(lostAt) < Date.parse(session.obtainedAt)) return undefined;
  return `the Saxo live session was lost (${lostReason ?? 'reason not recorded'}): ${LOGIN}`;
}

export function sessionLossOf(error: unknown): string | undefined {
  return error instanceof SaxoSessionLostError ? error.message : undefined;
}

export function recordedSessionLoss(tokenPath: string = tokenFilePath('live')): string | undefined {
  const session = readSession(tokenPath);
  return typeof session === 'string' ? undefined : lostSinceIssue(tokenPath, session);
}

// The keep-alive alerts only while no lostAt is recorded, so recording a loss here keeps the
// outage at one alert; a lostAt older than the current session is stale and is overwritten
export function recordSessionLoss(
  reason: string,
  now: Date,
  tokenPath: string = tokenFilePath('live'),
): void {
  if (recordedSessionLoss(tokenPath) !== undefined) return;
  writeKeepAliveState(tokenPath, {
    ...readKeepAliveState(tokenPath),
    lostAt: now.toISOString(),
    lostReason: reason,
  });
}

export function saxoSessionRefusal(
  now: Date,
  tokenPath: string = tokenFilePath('live'),
): string | undefined {
  const session = readSession(tokenPath);
  if (typeof session === 'string') return session;
  if (session.environment !== 'live') {
    return `the saved Saxo session is for the ${session.environment} gateway, not live: ${LOGIN}`;
  }
  if (Date.parse(session.refreshTokenExpiresAt) <= now.getTime()) {
    return `the Saxo live refresh token expired at ${session.refreshTokenExpiresAt}: ${LOGIN}`;
  }
  return lostSinceIssue(tokenPath, session);
}
