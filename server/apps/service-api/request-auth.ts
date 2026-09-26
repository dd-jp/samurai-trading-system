import { createHash, timingSafeEqual } from 'node:crypto';
import { isConfiguredCredential } from './bind-guard.js';

const BEARER_PREFIX = 'Bearer ';

function constantTimeStringsEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = authorizationHeader.slice(BEARER_PREFIX.length);
  return token === '' ? null : token;
}

export function isAuthorizedRequest(
  authorizationHeader: string | undefined,
  credential: string | undefined,
): boolean {
  if (!isConfiguredCredential(credential)) return true;
  const provided = extractBearerToken(authorizationHeader);
  if (provided === null) return false;
  return constantTimeStringsEqual(provided, credential);
}
