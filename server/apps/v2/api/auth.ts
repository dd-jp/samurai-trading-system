import { createHash, timingSafeEqual } from 'node:crypto';

export const DASHBOARD_TOKEN_ENV_VAR = 'SAMURAI_DASHBOARD_TOKEN';
const BEARER_PREFIX = 'Bearer ';

export function isConfiguredToken(token: string | undefined): token is string {
  return token !== undefined && token.trim() !== '';
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function carriesToken(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined || !authorization.startsWith(BEARER_PREFIX)) return false;
  return timingSafeEqual(digest(authorization.slice(BEARER_PREFIX.length)), digest(token));
}
