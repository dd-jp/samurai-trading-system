import type { LlmSpendRecord, LlmSpendSink } from '../../../pipeline/debate-engine/index.js';
import type { Logger } from '../../../shared/index.js';

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
  'SAXO_SIM_ACCOUNT_KEY',
  'SAXO_LIVE_ACCOUNT_KEY',
  'SAXO_SIM_APP_KEY',
  'SAXO_SIM_APP_SECRET',
  'SAXO_LIVE_APP_KEY',
  'SAXO_LIVE_APP_SECRET',
  'SAXO_TOKEN',
  'SAXO_APP_KEY',
  'TELEGRAM_BOT_TOKEN',
  'HEALTHCHECKS_PING_URL',
  'HEALTHCHECKS_TELEGRAM_PING_URL',
  'HEALTHCHECKS_SIGNALS_PING_URL',
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

export function secretWireForms(value: string): string[] {
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
      secretWireForms(secret.value).some((form) =>
        surfaces.some((surface) => surface.includes(form)),
      ),
  )?.name;
}

export const SECRET_WITHHELD = 'secret_withheld';

function loggedTextsOf(entry: LlmSpendRecord): string[] {
  return [
    entry.prompt,
    entry.response,
    entry.error_message,
    entry.stop_reason,
    entry.error_class,
  ].filter((text): text is string => text !== undefined);
}

function carriedSecret(secrets: readonly KnownSecret[], texts: readonly string[]) {
  return secrets.find(
    (secret) =>
      secret.value.length >= MIN_SECRET_LENGTH &&
      secretWireForms(secret.value).some((form) => texts.some((text) => text.includes(form))),
  )?.name;
}

// A request the egress guard refused is still logged as a failed call; without this its prompt,
// which carries the secret, would land in llm_call_log verbatim
export function secretGuardedSink(
  inner: LlmSpendSink,
  secrets: SecretSource,
  logger?: Logger | undefined,
): LlmSpendSink {
  return {
    record: (entry) => {
      const leaked = carriedSecret(secrets(), loggedTextsOf(entry));
      if (leaked === undefined) {
        inner.record(entry);
        return;
      }
      logger?.log({
        trace_id: entry.trace_id,
        stage: entry.stage,
        level: 'error',
        event: 'v2_llm_log_secret_withheld',
        message: `llm call text withheld from the journal: it carries the value of ${leaked}`,
        payload: { model: entry.model, secret: leaked },
      });
      inner.record({
        ...entry,
        prompt: undefined,
        response: undefined,
        error_message: undefined,
        stop_reason: undefined,
        error_class: SECRET_WITHHELD,
      });
    },
  };
}
