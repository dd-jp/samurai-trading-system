
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export const DASHBOARD_CREDENTIAL_ENV_VAR = 'SAMURAI_DASHBOARD_TOKEN';

export function isConfiguredCredential(credential: string | undefined): credential is string {
  return credential !== undefined && credential.trim() !== '';
}

export function isBindAllowed(host: string, credential: string | undefined): boolean {
  return isLoopbackHost(host) || isConfiguredCredential(credential);
}

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
