import { pricedModels, rateFor } from './pricing.js';

const NOUS_ROLES = ['debate', 'sentiment'] as const;
export type NousRole = (typeof NOUS_ROLES)[number];

const NOUS_BASE_URL_ENV_VAR = 'NOUS_BASE_URL';
const NOUS_API_KEY_ENV_VAR = 'NOUS_API_KEY';
const NOUS_MODEL_ENV_VAR = 'NOUS_MODEL';

export const DEFAULT_NOUS_MODELS = {
  debate: 'anthropic/claude-haiku-4.5',
  sentiment: 'x-ai/grok-4.5',
} as const satisfies Record<NousRole, string>;

export interface NousEndpoint {
  apiKey: string;
  baseUrl: string;
}

export interface NousCredentials extends NousEndpoint {
  model: string;
}

function nousEnvVars(role: NousRole): { model: string; apiKey: string } {
  const prefix = `NOUS_${role.toUpperCase()}`;
  return { model: `${prefix}_MODEL`, apiKey: `${prefix}_API_KEY` };
}

function readEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function nousEndpoint(role: NousRole, env: NodeJS.ProcessEnv = process.env): NousEndpoint {
  const vars = nousEnvVars(role);

  const baseUrl = readEnv(NOUS_BASE_URL_ENV_VAR, env);
  if (baseUrl === undefined) {
    throw new Error(
      `Nous: ${NOUS_BASE_URL_ENV_VAR} is not set. Provide it via the environment (.env.local) — ` +
        'there is deliberately no default, so that a run cannot silently point at a stale endpoint.',
    );
  }

  const apiKey = readEnv(vars.apiKey, env) ?? readEnv(NOUS_API_KEY_ENV_VAR, env);
  if (apiKey === undefined) {
    throw new Error(
      `Nous: no API key for the "${role}" role. Set ${vars.apiKey} for a key specific to this ` +
        `role's model, or ${NOUS_API_KEY_ENV_VAR} as the shared default.`,
    );
  }

  return { apiKey, baseUrl };
}

export function tryNousEndpoint(
  role: NousRole,
  env: NodeJS.ProcessEnv = process.env,
): NousEndpoint | undefined {
  const vars = nousEnvVars(role);
  const configured =
    readEnv(NOUS_BASE_URL_ENV_VAR, env) !== undefined &&
    (readEnv(vars.apiKey, env) ?? readEnv(NOUS_API_KEY_ENV_VAR, env)) !== undefined;
  return configured ? nousEndpoint(role, env) : undefined;
}

export function nousCredentials(
  role: NousRole,
  env: NodeJS.ProcessEnv = process.env,
): NousCredentials {
  const vars = nousEnvVars(role);
  const endpoint = nousEndpoint(role, env);
  const model =
    readEnv(vars.model, env) ?? readEnv(NOUS_MODEL_ENV_VAR, env) ?? DEFAULT_NOUS_MODELS[role];
  if (rateFor(model) === null) {
    throw new Error(
      `Nous: model "${model}" (from ${vars.model}/${NOUS_MODEL_ENV_VAR}) has no rate in ` +
        'MODEL_RATES, so its calls would be recorded unpriced — and an unpriced row contributes ' +
        "zero to the spend cap's sum, silently removing ADR-0008's $50/14d ceiling. Add its rate " +
        `to shared/llm/pricing.ts, or use one of: ${pricedModels().join(', ')}.`,
    );
  }

  return { ...endpoint, model };
}

export function tryNousCredentials(
  role: NousRole,
  env: NodeJS.ProcessEnv = process.env,
): NousCredentials | undefined {
  return tryNousEndpoint(role, env) === undefined ? undefined : nousCredentials(role, env);
}
