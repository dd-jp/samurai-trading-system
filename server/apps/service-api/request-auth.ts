/**
 * Request-time verification of `SAMURAI_DASHBOARD_TOKEN` against
 * `GET /api/snapshot` (#1038, David's 2026-09-08 decision on #887's option
 * 2). `bind-guard.ts` decides whether the PROCESS may bind beyond loopback;
 * this module decides whether an individual REQUEST may read the book once
 * it has. Both read the same credential, for different questions — see
 * `bind-guard.ts`'s `assertBindAllowed` doc comment for how they compose.
 *
 * **Scope: `/api/snapshot` only, not the static bundle.** The dashboard's
 * HTML shell and its Vite-built JS/CSS/font assets carry no book data — every
 * number on the page arrives solely through the polled `GET /api/snapshot`
 * (`client/src/hooks/useSnapshot.ts` is the client's one network primitive;
 * see that file's header). Gating the shell too would break the client
 * outright: a plain browser navigation and the `<script>`/`<link>` requests
 * it triggers carry no custom header, so an authenticated shell 401s before
 * any JS runs to attach one. Serving the shell unauthenticated and gating
 * only the data is the deliberate, recorded answer — wired at exactly one
 * call site in `server.ts`, immediately before that route's `buildSnapshot`
 * call.
 *
 * **Enforced whenever a credential is configured, regardless of host** — the
 * same unconditional posture `isBindAllowed` takes, and simpler than
 * conditioning on loopback-vs-not: an operator who set the token to unlock a
 * non-loopback bind gets the same protection on loopback too, and nothing
 * about "you're on 127.0.0.1" is a reason a configured secret should stop
 * mattering.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isConfiguredCredential } from './bind-guard.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * SHA-256 both sides before `timingSafeEqual` rather than comparing the raw
 * strings' buffers directly. `timingSafeEqual` throws on a length mismatch,
 * and the obvious workaround — compare a buffer to itself and return `false`
 * — still leaks the compared-or-not branch and requires trusting every
 * caller to take it. Hashing first makes both inputs a fixed 32 bytes, so
 * there is no length branch to get wrong and no on-the-wire token length to
 * infer from timing either.
 */
function constantTimeStringsEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Pulls the token out of an `Authorization` header, or `null` if the header
 * is absent, not the `Bearer` scheme, or carries no token after the scheme.
 * Never throws — every malformed shape is just "no credential offered".
 */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = authorizationHeader.slice(BEARER_PREFIX.length);
  return token === '' ? null : token;
}

/**
 * True iff the request may proceed: no credential is configured (today's
 * default — the localhost-only path stays open with no header required), or
 * the request's `Authorization: Bearer <token>` matches it exactly.
 *
 * Never logs, prints, or otherwise observes `authorizationHeader` or
 * `credential` beyond this comparison — the boolean result is the only thing
 * a caller ever sees.
 */
export function isAuthorizedRequest(
  authorizationHeader: string | undefined,
  credential: string | undefined,
): boolean {
  if (!isConfiguredCredential(credential)) return true;
  const provided = extractBearerToken(authorizationHeader);
  if (provided === null) return false;
  // isConfiguredCredential(credential) is true here, so credential is a
  // defined, non-blank string — the `as string` reflects that, not a guess.
  return constantTimeStringsEqual(provided, credential as string);
}
