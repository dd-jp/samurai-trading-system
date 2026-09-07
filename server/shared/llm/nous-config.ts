/**
 * Which Nous model and key each LLM surface runs on.
 *
 * Two roles call an LLM: the debate engine and the market-intelligence
 * sentiment agent. Each resolves its own model and its own key, falling back
 * to a shared default — the per-model-key shape David asked for: a per-surface
 * key where one is set, one shared `NOUS_BASE_URL` for all of them.
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
 * `debate` — `anthropic/claude-haiku-4.5`, chosen on MEASURED latency against
 * the live portal, not on the price list.
 *
 * The binding constraint is the 15s crypto budget
 * (`debate-engine/latency-budget.ts`) covering the whole debate: the
 * once-per-debate disagreement call plus three SEQUENTIAL persona calls, so
 * four calls have to fit. What decides that is not median latency but the
 * TAIL — one slow call cancels the debate.
 *
 * Interleaved sampling against the real detector prompt (8 rounds, candidates
 * rotated so portal load hit each equally, 2026-08-06):
 *
 * | model                      | p50    | max    | 4 x max | fits 15s |
 * |----------------------------|--------|--------|---------|----------|
 * | anthropic/claude-haiku-4.5 | 2902ms | 2962ms | 11.8s   | yes      |
 * | openai/gpt-5.4-mini        | 3521ms | 7531ms | 30.1s   | no       |
 * | openai/gpt-5.6-luna        | 3709ms | 5551ms | 22.2s   | no       |
 * | deepseek/deepseek-v4-flash | 4874ms | 5866ms | 23.5s   | no       |
 *
 * All four returned valid JSON on every sample (8/8 semantic), so correctness
 * did not separate them; the tail did, and haiku's is almost flat while every
 * other candidate's is 1.5-2x its own median. `openai/gpt-5.6-luna` was the
 * pre-measurement pick on price and did not survive the measurement — the
 * cheap tiers are cheap partly because they are queued.
 *
 * The cost is real and accepted: ~$34 per 14 days against ADR-0008's $50 cap,
 * versus roughly $5 for luna. Buying latency headroom with two thirds of the
 * budget is the right trade when the alternative is debates that cancel.
 * Every candidate above is one env var away (`NOUS_DEBATE_MODEL`) if a future
 * measurement disagrees.
 *
 * `sentiment` — `x-ai/grok-4.5`, PINNED. The stage reads X/Twitter sentiment
 * and Grok is the model trained on that discourse, so it is the one most likely
 * to have seen the conversation being asked about. Nothing here retrieves from
 * X live (ADR-0009), which makes the training corpus the whole of the edge.
 * Latency is irrelevant — the stage sits off the tick's critical path behind a
 * 4-hour bucket — and so is cost: measured ~$0.001/call, ~$0.50 across a 14-day
 * soak against a $50 cap.
 *
 * MEASURED 2026-08-06: this stage returns `{"items":[]}` on every call, and
 * that is CORRECT, not a defect. Holding the production system prompt verbatim
 * and varying only the user message, the result was empty with today's date,
 * with no date at all, and with a date well inside the training corpus — so it
 * is not a cutoff effect. The driver is the prompt's own anti-fabrication
 * clause; remove it and the same model fluently invents plausible sentiment.
 * Asked directly, it confirms it has no live X access in this API call. Empty
 * is the honest answer available without retrieval, so empty intelligence rows
 * during the soak are expected. See ADR-0009 for the full table.
 *
 * `~x-ai/grok-latest` (the `~` is the portal's floating-alias marker; the bare
 * id 404s) was the first pick, justified on corpus recency. The measurement
 * kills that justification — a fresher corpus is worth nothing while the answer
 * is empty — and leaves only the downside: a future model behind the alias
 * could start returning INVENTED sentiment into a live-money analyst path, and
 * no test would catch it, because empty is currently correct and nothing
 * asserts on content. Hence the pin. Both ids stay priced, so the alias remains
 * one env var away if retrieval ever makes recency pay again.
 */
export const DEFAULT_NOUS_MODELS = {
  debate: 'anthropic/claude-haiku-4.5',
  sentiment: 'x-ai/grok-4.5',
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
