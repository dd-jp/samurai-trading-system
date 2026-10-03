export type SaxoTradingEnvironment = 'sim' | 'live';

export const SAXO_CREDENTIAL_ENV_VARS: Readonly<
  Record<SaxoTradingEnvironment, { readonly token: string; readonly gateway: string }>
> = {
  sim: { token: 'SAXO_SIM_ACCESS_TOKEN', gateway: 'SAXO_SIM_GATEWAY' },
  live: { token: 'SAXO_LIVE_ACCESS_TOKEN', gateway: 'SAXO_LIVE_GATEWAY' },
};

export const SAXO_GATEWAY_URLS: Readonly<Record<SaxoTradingEnvironment, string>> = {
  sim: 'https://gateway.saxobank.com/sim/openapi',
  live: 'https://gateway.saxobank.com/openapi',
};

export function saxoAccountKeyEnvVar(environment: SaxoTradingEnvironment): string {
  return `SAXO_${environment.toUpperCase()}_ACCOUNT_KEY`;
}
