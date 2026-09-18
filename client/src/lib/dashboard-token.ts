
const DASHBOARD_TOKEN_QUERY_PARAM = 'token';

export const DASHBOARD_TOKEN_STORAGE_KEY = 'samurai-dashboard-token';

export type TokenStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function resolveDashboardToken(search: string, storage: TokenStorage): string | null {
  const fromUrl = new URLSearchParams(search).get(DASHBOARD_TOKEN_QUERY_PARAM);
  if (fromUrl !== null && fromUrl !== '') {
    storage.setItem(DASHBOARD_TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return storage.getItem(DASHBOARD_TOKEN_STORAGE_KEY);
}

export function stripTokenParam(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(DASHBOARD_TOKEN_QUERY_PARAM)) return search;
  params.delete(DASHBOARD_TOKEN_QUERY_PARAM);
  const rest = params.toString();
  return rest === '' ? '' : `?${rest}`;
}
