/**
 * Fail-closed guard for the dashboard's bind address (#887, ADR-0019).
 *
 * `GET /api/snapshot` (`snapshot.ts`) serves open positions, P&L and LLM
 * spend, additionally verified per request against this same credential
 * (`request-auth.ts`) whenever one is configured. This module's own job is
 * narrower: it is the BOOT-time half — the only thing that ever stood
 * between "loopback" and "published to the LAN" was `process.env.HOST`
 * defaulting to `127.0.0.1` in `index.ts` and `fixture-server.ts` —
 * `HOST=0.0.0.0 yarn dashboard` bound the book wide open, silently, with no
 * error and no failing test.
 *
 * The fix decided on #887 (recorded in ADR-0019's Consequences and its
 * 2026-09-02 amendment) is **conjunctive** and fail-closed: refuse to start
 * only when the bind is non-loopback AND no credential is configured. One
 * rejected alternative is deliberately not implemented here — bind-only
 * enforcement with no credential escape hatch at all (option 3: does nothing
 * once a credential exists to justify wider reach). The other alternative
 * #887 considered, a bearer token required unconditionally on the endpoint
 * (option 2), was ruled out of THIS ticket's scope but not out of the
 * product — David's 2026-09-08 decision on #1038 shipped it, as a request-time
 * check layered on top of this boot-time one, not a replacement for it.
 *
 * The conjunction matters operationally: loopback-with-no-credential is
 * today's default and every `yarn dashboard` invocation until an operator
 * deliberately opts into wider reach. A guard that fired whenever no
 * credential exists — dropping the "AND non-loopback" half — would brick
 * that default path, and `server/apps/supervisor/supervisor.ts` stops the
 * orchestrator whenever the dashboard process dies, so that mistake would
 * halt live trading over a boot-time flag nobody set.
 *
 * `assertBindAllowed` is exported standalone — no server, no process — so
 * the condition is unit-testable directly (`bind-guard.test.ts`).
 * `createDashboardServer` (`server.ts`) calls it structurally, synchronously,
 * before it ever binds a socket (`start()` is a separate, later call), so
 * every caller is covered by construction: the production entry
 * (`index.ts`), the Playwright fixture harness (`fixture-server.ts`), and
 * every test that constructs a server through `createDashboardServer`.
 */

/**
 * The loopback allowlist — literal addresses only, per ADR-0019/#887.
 *
 * `localhost` is deliberately NOT included, and that is a decision, not an
 * oversight. `localhost` is a hostname, not an address: resolving it is a
 * DNS/hosts-file lookup, and `http.Server#listen(host)` passes a string host
 * straight to the OS to resolve rather than comparing it to a known-safe
 * value. A misconfigured resolver, an unusual `/etc/hosts`, or a container
 * whose `localhost` entry has been edited can all make that lookup answer
 * something other than a loopback address — which would make this guard's
 * safety property depend on name resolution instead of on the literal bytes
 * `HOST` carries. Trusting only the two literal addresses ADR-0019/#887 named
 * keeps the guard's meaning independent of DNS.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1']);

/** True iff `host` is one of the two literal loopback addresses above. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Name of the env var an operator sets to permit a non-loopback bind (#887).
 * Follows the repo's `SAMURAI_*` convention (`SAMURAI_MODE`,
 * `SAMURAI_SENTIMENT`). Exported so the error message and any doc that names
 * it stay in sync with the actual variable checked.
 */
export const DASHBOARD_CREDENTIAL_ENV_VAR = 'SAMURAI_DASHBOARD_TOKEN';

/**
 * A credential counts as "configured" once it is a non-empty string after
 * trimming — a blank or whitespace-only value is indistinguishable from
 * unset and must not be treated as an opt-in to wider reach.
 *
 * Exported (not just used internally) so `request-auth.ts` (#1038) applies
 * the identical "blank counts as unset" rule when deciding whether a request
 * needs a valid bearer token at all — the boot-time and request-time guards
 * must agree on what "configured" means, or a blank env var could unlock the
 * bind while still being treated as a live secret to check requests against.
 */
export function isConfiguredCredential(credential: string | undefined): credential is string {
  return credential !== undefined && credential.trim() !== '';
}

/**
 * The conjunctive predicate itself: a bind is allowed when the host is
 * loopback, OR a credential is configured. Equivalently, it is refused only
 * when BOTH are false — non-loopback AND no credential.
 *
 * Pure: no `process`, no server, no I/O. `credential` is a parameter rather
 * than a `process.env` read here, per this repo's env-var convention (an
 * option carries the env default; only entry points touch `process.env`
 * directly) — `index.ts` and `fixture-server.ts` are what resolve
 * `process.env[DASHBOARD_CREDENTIAL_ENV_VAR]` and pass it in.
 */
export function isBindAllowed(host: string, credential: string | undefined): boolean {
  return isLoopbackHost(host) || isConfiguredCredential(credential);
}

/**
 * Throws a named, operator-legible error when `host` is non-loopback AND no
 * credential is configured; otherwise returns without side effects.
 *
 * Never logs, prints or interpolates the credential's VALUE anywhere — only
 * whether one is configured is ever observable from this function.
 *
 * Note on scope (#887, amended by #1038): a configured credential unlocks
 * the BOOT-time bind here — this function alone never inspects a single
 * request. As of #1038, `GET /api/snapshot` (only that route; the static
 * bundle stays unauthenticated, see `request-auth.ts`'s header) additionally
 * verifies the SAME credential against each request's `Authorization`
 * header (`isAuthorizedRequest`, `request-auth.ts`), wired in
 * `server.ts`. The two checks read the one env var for two different
 * purposes: this one decides whether the process may bind beyond loopback at
 * all; that one decides whether an individual request is let through once it
 * has. ADR-0019's 2026-09-02 amendment recorded request-time verification as
 * an explicitly-deferred, unshipped follow-up — see its newer amendment for
 * the reconciliation now that it has shipped.
 */
export function assertBindAllowed(host: string, credential: string | undefined): void {
  if (isBindAllowed(host, credential)) return;
  throw new Error(
    `Dashboard refuses to start: HOST=${host} is not a loopback address (127.0.0.1 or ::1) and ` +
      `${DASHBOARD_CREDENTIAL_ENV_VAR} is not configured. GET /api/snapshot serves open ` +
      'positions, P&L and LLM spend — binding it beyond localhost with nothing else standing ' +
      'guard would publish the live book to whatever network HOST reaches. Fix: bind to ' +
      '127.0.0.1 (the default) or ::1, or set ' +
      `${DASHBOARD_CREDENTIAL_ENV_VAR} to a non-empty value before binding to ${host}. Once set, ` +
      'every /api/snapshot request must also carry it as `Authorization: Bearer <value>` — open ' +
      'the dashboard at /?token=<value> once to have the browser capture and send it from then on.',
  );
}
