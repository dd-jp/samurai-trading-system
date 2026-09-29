import {
  readKeepAliveState,
  readTokenFile,
  type SaxoTokenFileRecord,
  tokenFilePath,
} from '../../../pipeline/execution/index.js';

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
