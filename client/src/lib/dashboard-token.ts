/**
 * Resolves the dashboard's bearer credential (#1038) client-side. The
 * dashboard is the only consumer of `SAMURAI_DASHBOARD_TOKEN` at request
 * time (`useSnapshot.ts`'s `authToken` option), and it has no login form —
 * an operator who set the env var shares a link carrying `?token=<value>`
 * once, and every reload after that must keep working without the link.
 *
 * **Capture-and-scrub, not a persistent URL.** A token sitting in
 * `location.search` is the single easiest way to leak it: it lands in
 * browser history, referrer headers to any third-party resource the page
 * ever loads, and screen-share/screenshot of the address bar. So the token
 * is read out of the URL once, written to `sessionStorage`, and the query
 * param is stripped from the address bar immediately — `resolveDashboardToken`
 * and `stripTokenParam` are the two pure halves of that; `App.tsx` is what
 * calls `history.replaceState` with `stripTokenParam`'s result.
 *
 * `sessionStorage`, not `localStorage`: a bearer credential for the live
 * book should not silently outlive the tab that captured it just because the
 * browser profile is shared across tabs or persists across restarts.
 */

/** Query param an operator's link carries the token in. */
export const DASHBOARD_TOKEN_QUERY_PARAM = 'token';

/** `sessionStorage` key the token is persisted under after capture. */
export const DASHBOARD_TOKEN_STORAGE_KEY = 'samurai-dashboard-token';

/** The `sessionStorage` surface this module needs — narrowed for testability without a DOM. */
export type TokenStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Resolves the token to send, in priority order: a fresh `?token=` on
 * `search` (also persisted to `storage` so a same-tab reload after the URL
 * is scrubbed still has it), else whatever `storage` already holds, else
 * `null` — the default, no-credential dashboard's exact starting state.
 *
 * A blank `?token=` (`?token=`) is treated as absent, not as "clear the
 * stored token": matches `isConfiguredCredential`'s server-side rule that a
 * blank value means unset, and a stray empty param must not silently log an
 * operator out of a token `sessionStorage` still holds.
 */
export function resolveDashboardToken(search: string, storage: TokenStorage): string | null {
  const fromUrl = new URLSearchParams(search).get(DASHBOARD_TOKEN_QUERY_PARAM);
  if (fromUrl !== null && fromUrl !== '') {
    storage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return storage.getItem(DASHBOARD_TOKEN_STORAGE_KEY);
}

/**
 * `search` with the token param removed and every other param preserved, in
 * the `?a=b&c=d` shape `history.replaceState` expects (or `''` when nothing
 * is left). Pure — the caller decides what to do with the result and how to
 * combine it with `pathname`/`hash`.
 */
export function stripTokenParam(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(DASHBOARD_TOKEN_QUERY_PARAM)) return search;
  params.delete(DASHBOARD_TOKEN_QUERY_PARAM);
  const rest = params.toString();
  return rest === '' ? '' : `?${rest}`;
}
