/**
 * Which Nous model and key each LLM surface runs on.
 *
 * Two roles call an LLM: the debate engine and the market-intelligence
 * sentiment agent. Each resolves its own model and its own key, falling back
 * to a shared default — the per-model-key shape David asked for, and the shape
 * the repo already runs in CI (`.github/workflows/ai-review.yml` gives DeepSeek
 * `NOUS_API_KEY` and Kimi `KIMI_NOUS_API_KEY` against one `NOUS_BASE_URL`).
 *
 * ## Why a model can be refused at startup
 *
 * `spend-cap.ts` sums `COALESCE(SUM(cost_usd), 0)`, and `priceUsage` returns
 * `null` for a model absent from `MODEL_RATES`. A null lands in the row
 * unpriced, an unpriced row contributes zero, and ADR-0008's $50/14d ceiling
 * quietly stops existing — with no throw and no failing test. The cap already
 * fails CLOSED when it cannot read the spend table (`spend-cap.ts:163-179`); a
 * cap that silently un-caps on an unrecognised model string is the same class
 * of fault pointing the other way. So `nousCredentials` refuses to build a
 * client for a model this system cannot price. Loud at boot beats null at
 * write time.
 *
 * Adding a model is therefore a two-line change: the id here (or in the env)
 * and its rate in `pricing.ts`. `pricing.test.ts` pins that the defaults below
 * are priceable.
 */

import { pricedModels, rateFor } from './pricing.js';

export const NOUS_ROLES = ['debate', 'sentiment'] as const;
export type NousRole = (typeof NOUS_ROLES)[number];

export const NOUS_BASE_URL_ENV_VAR = 'NOUS_BASE_URL';
export const NOUS_API_KEY_ENV_VAR = 'NOUS_API_KEY';
export const NOUS_MODEL_ENV_VAR = 'NOUS_MODEL';

/**
 * Defaults, chosen against the constraints each role actually has.
 *
 * `debate` — `openai/gpt-5.6-luna`. The binding constraint is the 15s crypto
 * latency budget (`debate-engine/latency-budget.ts`) spread across three
 * SEQUENTIAL persona calls, roughly 5s each, which rules out every reasoning
 * and `-pro` tier; the repo proved that failure mode with kimi-k3 in CI. The
 * work itself is short strict JSON under 1024 tokens — instruction-following,
 * not deep reasoning. Cost stops discriminating once the system leaves
 * Anthropic list rates (ADR-0008's ~$42 of a $50/14d cap drops to roughly $5),
 * so luna is the accuracy-leaning end of the cheap band rather than the
 * cheapest point on it. `anthropic/claude-haiku-4.5` is the documented
 * fallback and is one env var away.
 *
 * `sentiment` — `deepseek/deepseek-v4-flash`. Off the tick's critical path
 * behind a 4-hour cache bucket, so latency barely matters and cheap is the
 * only sensible axis.
 */
export const DEFAULT_NOUS_MODELS = {
  debate: 'openai/gpt-5.6-luna',
  sentiment: 'deepseek/deepseek-v4-flash',
} as const satisfies Record<NousRole, string>;

export interface NousCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** The role-specific env vars, exported so the startup pre-flight can name them without duplicating the convention. */
export function nousEnvVars(role: NousRole): { model: string; apiKey: string } {
  const prefix = `NOUS_${role.toUpperCase()}`;
  return { model: `${prefix}_MODEL`, apiKey: `${prefix}_API_KEY` };
}

/**
 * Empty and whitespace-only count as absent — `--env-file` turns an unset-but-
 * declared variable into `''`, which is the same "not configured" state.
 * `missingCredentialEnvVars` (orchestrator/index.ts) and
 * `alert-transport.ts`'s `requireEnv` already take this line; if this one did
 * not, a quoted-empty value would pass here and throw one layer deeper.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Resolves one role's model, key and base URL, or throws naming the variable
 * that would fix it.
 *
 * No default base URL. The portal's address lives in configuration
 * (`NOUS_BASE_URL`, already a repository variable for CI), not in source —
 * a hardcoded fallback is how a run silently points at the wrong endpoint
 * after the real one changes.
 */
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

/**
 * `nousCredentials`, but `undefined` instead of a throw when the role is
 * simply not configured.
 *
 * For the market-intelligence agent, which the composition root builds only
 * when it can — with no key it degrades to no-agent and the analysts report
 * `NO_DATA_MARKER`, exactly as they did when `XAI_API_KEY` was the switch. The
 * startup warn is what makes that visible; a throw would take the whole
 * orchestrator down over an optional stage.
 *
 * An UNPRICED MODEL STILL THROWS. That one is not a configuration gap, it is
 * a hole in the spend cap — a run must not quietly proceed with a stage whose
 * calls cannot be counted.
 */
export function tryNousCredentials(role: NousRole): NousCredentials | undefined {
  const vars = nousEnvVars(role);
  const configured =
    readEnv(NOUS_BASE_URL_ENV_VAR) !== undefined &&
    (readEnv(vars.apiKey) ?? readEnv(NOUS_API_KEY_ENV_VAR)) !== undefined;
  return configured ? nousCredentials(role) : undefined;
}
