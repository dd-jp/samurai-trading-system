/**
 * Local price table for Nous token usage — the arithmetic half of the spend
 * meter that stands in for the credit-balance endpoint no provider publishes
 * (see migrations/0010_llm_spend.sql for why the meter exists).
 *
 * A HARDCODED TABLE IS THE POINT, not a shortcut. There is no pricing endpoint
 * to query, so any implementation is a table somewhere; putting it here — one
 * module, one exported constant, prices in dollars-per-million-tokens exactly
 * as the Nous portal publishes them — makes it greppable and diff-able when
 * rates change, instead of scattering magic numbers through the reader.
 *
 * The corollary is that this table goes stale. `priceUsage` returns `null`
 * rather than guessing for a model it does not recognise, and that `null`
 * survives all the way to the operator's screen as "unpriced" (the
 * `cost_usd REAL` column is nullable for this reason). A wrong number on a
 * money surface is worse than a visibly missing one.
 *
 * ## Why this lives in `shared/`
 *
 * Both LLM surfaces price against it — the debate engine
 * (`debate-engine/llm/spend-sink.ts`) and the market-intelligence sentiment
 * agent — and `shared/llm/nous-config.ts` reads it at startup to refuse an
 * unpriced model outright. `shared/` is the one place all three can import
 * without inverting the dependency between components.
 *
 * ## Unpriced means UNCAPPED — read this before adding a model
 *
 * `spend-cap.ts` sums `COALESCE(SUM(cost_usd), 0)`, so an unpriced row
 * contributes ZERO to the total. A configured model missing from this table
 * does not fail, it silently removes ADR-0008's $50/14d ceiling. That is why
 * `nousCredentials` (shared/llm/nous-config.ts) throws at startup for a model
 * absent here, and why `pricing.test.ts` asserts every key prices non-null.
 */

/** Dollars per million tokens, as published on the Nous portal. */
export interface ModelRate {
  input: number;
  output: number;
}

/**
 * Keys are EXACT Nous model ids — `vendor/model`, matched literally by
 * `rateFor`.
 *
 * This was a longest-prefix match while the system talked to Anthropic
 * directly, because the wire carried dated snapshot ids
 * (`claude-haiku-4-5-20251001`) while the published rates were quoted against
 * the undated alias (`claude-haiku-4-5`). Nous ids are stable and already
 * fully qualified, so that justification is gone — and prefix matching would
 * now actively MISPRICE: `openai/gpt-5.6-luna` is a prefix of
 * `openai/gpt-5.6-luna-pro`, and `deepseek/deepseek-v4-flash` a prefix of
 * `deepseek/deepseek-v4-flash-0731`. Under prefix matching a `-pro` tier would
 * silently bill at the base tier's rate. Every model gets its own row instead.
 *
 * Rates are the Nous portal's, NOT the underlying vendor's list price — Nous
 * discounts (e.g. `anthropic/claude-haiku-4.5` is $0.80/$4.00 here against
 * Anthropic's own $1.00/$5.00). Pricing a Nous call at vendor list rates would
 * over-count the cap by the discount.
 *
 * Retrieved from the Nous portal 2026-08-06. Promotional rates (the `-90%`
 * tiers) are recorded as the price actually charged today; when a promotion
 * ends this table is what has to change.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = Object.freeze({
  // Anthropic, via Nous.
  'anthropic/claude-fable-5': { input: 8, output: 40 },
  'anthropic/claude-opus-5': { input: 4, output: 20 },
  'anthropic/claude-opus-4.8': { input: 4, output: 20 },
  'anthropic/claude-sonnet-5': { input: 1.6, output: 8 },
  'anthropic/claude-haiku-4.5': { input: 0.8, output: 4 },
  // OpenAI, via Nous.
  'openai/gpt-5.6-sol': { input: 4, output: 24 },
  'openai/gpt-5.6-sol-pro': { input: 4, output: 24 },
  'openai/gpt-5.6-terra': { input: 1, output: 6 },
  'openai/gpt-5.6-terra-pro': { input: 1, output: 6 },
  'openai/gpt-5.6-luna': { input: 0.1, output: 0.6 },
  'openai/gpt-5.6-luna-pro': { input: 0.1, output: 0.6 },
  'openai/gpt-5.5': { input: 4, output: 24 },
  'openai/gpt-5.5-pro': { input: 24, output: 144 },
  'openai/gpt-5.4-mini': { input: 0.6, output: 3.6 },
  // Google, via Nous.
  'google/gemini-3.1-pro-preview': { input: 1.6, output: 9.6 },
  'google/gemini-3.6-flash': { input: 1.2, output: 6 },
  // xAI, via Nous — the sentiment role's model. Grok is the defensible pick
  // for X/Twitter sentiment because it is the model trained on that discourse,
  // even though nothing here retrieves from X live (see ADR-0009).
  'x-ai/grok-4.5': { input: 1.6, output: 4.8 },
  /**
   * A FLOATING ALIAS, and the only one in this table. Every other key names a
   * fixed model whose price changes only when the portal republishes it; this
   * one silently becomes a different model, at a different price, whenever xAI
   * ships a new Grok.
   *
   * Priced at `x-ai/grok-4.5`'s published rate — what the alias resolves to
   * today. The exposure is that a costlier successor would be metered at the
   * old rate and the cap would UNDER-count, which is the direction that
   * matters: ADR-0008's ceiling would let more spend through than it thinks.
   * Bounded and small at this stage's volume (~36 calls/day behind a 4h
   * bucket), and stated rather than smoothed over.
   *
   * `x-ai/grok-4.5` above is the pinned alternative — one env var
   * (`NOUS_SENTIMENT_MODEL`) if the drift ever matters more than the currency.
   */
  'x-ai/grok-latest': { input: 1.6, output: 4.8 },
  // DeepSeek, via Nous.
  'deepseek/deepseek-v4-pro': { input: 0.35, output: 0.7 },
  'deepseek/deepseek-v4-flash': { input: 0.07, output: 0.14 },
  'deepseek/deepseek-v4-flash-0731': { input: 0.01, output: 0.02 },
  // Everyone else, via Nous.
  'qwen/qwen3.8-max': { input: 1.6, output: 4.8 },
  'moonshotai/kimi-k3': { input: 2.4, output: 12 },
  'minimax/minimax-m3': { input: 0.24, output: 0.96 },
  'z-ai/glm-5.2': { input: 0.72, output: 2.26 },
  'z-ai/glm-5.1': { input: 0.76, output: 2.39 },
  'xiaomi/mimo-v2.5-pro': { input: 0.35, output: 0.7 },
  'tencent/hy3': { input: 0.11, output: 0.42 },
  'stepfun/step-3.7-flash': { input: 0.16, output: 0.92 },
  'nvidia/nemotron-3-super-120b-a12b': { input: 0.07, output: 0.32 },
  'sakana/fugu-ultra': { input: 4, output: 24 },
  // Free tiers. A real zero, not an unknown — these must be present rather
  // than absent, because absent means unpriced means uncapped (see the module
  // doc comment), and "this call was free" is a fact the meter can state.
  'tencent/hy3:free': { input: 0, output: 0 },
  'stepfun/step-3.7-flash:free': { input: 0, output: 0 },
  'poolside/laguna-s-2.1:free': { input: 0, output: 0 },
  'poolside/laguna-xs-2.1:free': { input: 0, output: 0 },
  'inclusionai/ling-3.0-flash:free': { input: 0, output: 0 },
});

/**
 * Cache multipliers, applied against the model's INPUT rate.
 *
 * NOTHING IN THIS SYSTEM REQUESTS CACHING — `cache_control` appears nowhere in
 * the repo — so these always multiply zero and the numbers below are currently
 * inert. That matters, because they are no longer uniformly correct.
 *
 * They were uniform across Anthropic's line-up (a cache read is a tenth of
 * input on every Claude model). Across the Nous portal's vendors they are not:
 * `openai/gpt-5.6-luna` reads at $0.01 against $0.10 input (0.1x, as below),
 * but `deepseek/deepseek-v4-pro` reads at $0.0029 against $0.35 (≈0.008x) and
 * the `:free` tiers read at zero. A single constant would misprice most of the
 * table.
 *
 * So: before anything sets a cache breakpoint, `ModelRate` needs a per-model
 * `cache_read` column and these constants have to go. Deliberately NOT built
 * now — a column no caller populates is a second thing to keep in sync for no
 * behavioural gain. This comment is the flag.
 *
 * The 1-hour-TTL write multiplier (2x) is absent for the same reason it always
 * was: nothing requests a 1h TTL, and the usage block does not distinguish the
 * two TTLs anyway — that change needs a wire-level discriminator first.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

const TOKENS_PER_MILLION = 1_000_000;

/**
 * The token counts a completion reports back.
 *
 * Named for Anthropic's Messages API `usage` block, whose field names this
 * keeps: the shape is what `AnthropicLlmClient` and `SqliteLlmSpendStore`
 * already read, and the Nous wire client normalises OpenAI's
 * `prompt_tokens`/`completion_tokens` into it. The name is now misleading —
 * see the follow-up rename noted in `nous-messages-client.ts`.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  /** Absent when nothing was cached — absent means zero here, a real zero rather than an unknown. */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Exact lookup — see `MODEL_RATES` for why this is no longer a prefix match.
 *
 * Exported so `nous-config.ts` can refuse an unpriced model at startup, and so
 * the wire client can decide whether a provider-echoed model id is one this
 * table can price.
 */
export function rateFor(model: string): ModelRate | null {
  return Object.hasOwn(MODEL_RATES, model) ? (MODEL_RATES[model] ?? null) : null;
}

/** Every model id this table can price. Exported for the test that pins the "no unpriced model is reachable" invariant. */
export function pricedModels(): readonly string[] {
  return Object.keys(MODEL_RATES);
}

/**
 * Cost in USD for one call, or `null` when the model is not in the table.
 *
 * Note the asymmetry with the token counts the caller records alongside this:
 * those are exact and always available, this is an estimate against a table
 * that can go stale. It is a spend indicator for an operator watching a paper
 * run, not a billing reconciliation — the Nous portal's own invoice is
 * authoritative and this will differ from it (it cannot see other machines on
 * the same key, or promotional rates that lapsed since this table was written).
 */
export function priceUsage(model: string, usage: AnthropicUsage): number | null {
  const rate = rateFor(model);
  if (rate === null) return null;

  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const inputCost =
    (usage.input_tokens * rate.input +
      cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * rate.input * CACHE_READ_MULTIPLIER) /
    TOKENS_PER_MILLION;
  const outputCost = (usage.output_tokens * rate.output) / TOKENS_PER_MILLION;

  return inputCost + outputCost;
}
