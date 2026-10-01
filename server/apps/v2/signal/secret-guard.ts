export interface KnownSecret {
  readonly name: string;
  readonly value: string;
}

export type SecretSource = () => readonly KnownSecret[];

export interface OutgoingRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ProviderAuth {
  readonly header: string;
  readonly key: string;
}

// Real keys and tokens run 20+ characters; under 8, a value such as a port, a flag or "paper"
// would match ordinary prompt text and refuse every debate
export const MIN_SECRET_LENGTH = 8;

export const SECRET_ENV_NAMES = [
  'ALPACA_API_KEY',
  'ALPACA_API_SECRET',
  'ALPACA_LIVE_API_KEY',
  'ALPACA_LIVE_API_SECRET',
  'SAXO_SIM_ACCESS_TOKEN',
  'SAXO_LIVE_ACCESS_TOKEN',
  'SAXO_SIM_APP_KEY',
  'SAXO_SIM_APP_SECRET',
  'SAXO_LIVE_APP_KEY',
  'SAXO_LIVE_APP_SECRET',
  'SAXO_TOKEN',
  'SAXO_APP_KEY',
  'TELEGRAM_BOT_TOKEN',
  'HEALTHCHECKS_PING_URL',
  'HEALTHCHECKS_TELEGRAM_PING_URL',
  'LITESTREAM_SSE_C_KEY',
  'POLYGON_API_KEY',
  'MARKETAUX_API_TOKEN',
  'MARKETAUX_API_KEY',
  'NOUS_API_KEY',
  'NOUS_DEBATE_API_KEY',
  'NOUS_SENTIMENT_API_KEY',
  'TIINGO_API_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'SAMURAI_DASHBOARD_TOKEN',
] as const;

export function secretsFromEnv(env: NodeJS.ProcessEnv): KnownSecret[] {
  return SECRET_ENV_NAMES.map((name) => ({ name, value: env[name] ?? '' }));
}

function wireForms(value: string): string[] {
  return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
}

// The provider key is exempted by value, not by name: NOUS_API_KEY and NOUS_DEBATE_API_KEY
// often hold the same value, and a name-based exemption would refuse every real call
function surfacesOf(request: OutgoingRequest, auth: ProviderAuth): string[] {
  const headers = Object.entries(request.headers).map(([name, value]) =>
    name.toLowerCase() === auth.header.toLowerCase() ? value.split(auth.key).join('') : value,
  );
  return [request.url, request.body, ...headers];
}

export function leakedSecret(
  secrets: readonly KnownSecret[],
  request: OutgoingRequest,
  auth: ProviderAuth,
): string | undefined {
  const surfaces = surfacesOf(request, auth);
  return secrets.find(
    (secret) =>
      secret.value.length >= MIN_SECRET_LENGTH &&
      wireForms(secret.value).some((form) => surfaces.some((surface) => surface.includes(form))),
  )?.name;
}
