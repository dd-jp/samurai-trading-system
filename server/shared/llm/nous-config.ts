
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

export interface NousCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function nousEnvVars(role: NousRole): { model: string; apiKey: string } {
  const prefix = `NOUS_${role.toUpperCase()}`;
  return { model: `${prefix}_MODEL`, apiKey: `${prefix}_API_KEY` };
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function nousCredentials(role: NousRole): NousCredentials {
  const vars = nousEnvVars(role);

  const baseUrl = readEnv(NOUS_BASE_URL_ENV_VAR);
  if (baseUrl === undefined) {
    throw new Error(
      `Nous: ${NOUS_BASE_URL_ENV_VAR} is not set. Provide it via the environment (.env.local) — ` +
        'there is deliberately no default, so that a run cannot silently point at a stale endpoint.',
    );
  }

  const apiKey = readEnv(vars.apiKey) ?? readEnv(NOUS_API_KEY_ENV_VAR);
  if (apiKey === undefined) {
    throw new Error(
      `Nous: no API key for the "${role}" role. Set ${vars.apiKey} for a key specific to this ` +
        `role's model, or ${NOUS_API_KEY_ENV_VAR} as the shared default.`,
    );
  }

  const model = readEnv(vars.model) ?? readEnv(NOUS_MODEL_ENV_VAR) ?? DEFAULT_NOUS_MODELS[role];
  if (rateFor(model) === null) {
    throw new Error(
      `Nous: model "${model}" (from ${vars.model}/${NOUS_MODEL_ENV_VAR}) has no rate in ` +
        'MODEL_RATES, so its calls would be recorded unpriced — and an unpriced row contributes ' +
        "zero to the spend cap's sum, silently removing ADR-0008's $50/14d ceiling. Add its rate " +
        `to shared/llm/pricing.ts, or use one of: ${pricedModels().join(', ')}.`,
    );
  }

  return { apiKey, baseUrl, model };
}

export function tryNousCredentials(role: NousRole): NousCredentials | undefined {
  const vars = nousEnvVars(role);
  const configured =
    readEnv(NOUS_BASE_URL_ENV_VAR) !== undefined &&
    (readEnv(vars.apiKey) ?? readEnv(NOUS_API_KEY_ENV_VAR)) !== undefined;
  return configured ? nousCredentials(role) : undefined;
}
