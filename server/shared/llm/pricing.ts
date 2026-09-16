/**
 * Local price table for Nous token usage — the arithmetic half of the spend
 * meter that stands in for the credit-balance endpoint no provider
 * publishes (see migrations/0010_llm_spend.sql for why the meter exists).
 *
 * A hardcoded table is the point, not a shortcut: there is no pricing
 * endpoint to query, so any implementation is a table somewhere, and one
 * module with prices in dollars-per-million-tokens (as the Nous portal
 * publishes them) keeps rate changes greppable and diff-able.
 *
 * This table goes stale. `priceUsage` returns `null` rather than guessing
 * for a model it doesn't recognise, and that `null` survives to the
 * operator's screen as "unpriced" — a wrong number on a money surface is
 * worse than a visibly missing one.
 *
 * Lives in `shared/` because both LLM surfaces price against it (the
 * debate engine and the market-intelligence sentiment agent), and
 * `shared/llm/nous-config.ts` reads it at startup to refuse an unpriced
 * model outright.
 *
 * Unpriced means uncapped: `spend-cap.ts` sums
 * `COALESCE(SUM(cost_usd), 0)`, so an unpriced row contributes zero to the
 * total — a configured model missing from this table silently removes
 * ADR-0008's $50/14d ceiling. That is why `nousCredentials` throws at
 * startup for a model absent here, and why `pricing.test.ts` asserts every
 * key prices non-null.
 */

/** Dollars per million tokens, as published on the Nous portal */
export interface ModelRate {
  input: number;
  output: number;
  /**
   * Dollars per million cache-read tokens, when the vendor publishes a
   * rate for them rather than a multiple of `input`.
   *
   * Optional because most rows don't need it: `priceUsage` falls back to
   * `input * CACHE_READ_MULTIPLIER` when absent. Populated where the
   * fallback is measurably wrong — see the grok rows, where 0.1x
   * understates the real charge by 2.5x and would under-count the cap on
   * every retrieval call.
   */
  cache_read?: number;
  /**
   * A large-prompt rate override, applied to the whole request once the
   * prompt crosses `above_prompt_tokens`.
   *
   * Server-side retrieval is what makes this reachable: search results
   * ride in the prompt, so an `x_search` call is not a small request — a
   * measured 10-result call carried 58,153 prompt tokens against the
   * ~5,000 of a 3-result one.
   *
   * "Whole request, not just the excess" is the cap-safe reading of
   * ambiguous vendor wording: an over-count trips ADR-0008's ceiling early
   * and stops trading, an under-count spends past it.
   */
  tier?: { above_prompt_tokens: number; input: number; output: number };
}

/**
 * xAI's large-prompt tier, shared by both grok rows below.
 *
 * Both, not just the alias, because `resolveMeteredModel` (`nous-chat.ts`)
 * meters against the id the provider echoed, and `~x-ai/grok-latest`
 * echoes `x-ai/grok-4.5`. The row that actually prices a retrieval call is
 * therefore the pinned one, so a tier on the alias alone would never fire.
 */
const GROK_LARGE_PROMPT_TIER = {
  tier: { above_prompt_tokens: 200_000, input: 4, output: 12 },
} as const;

/**
 * Keys are exact Nous model ids — `vendor/model`, matched literally by
 * `rateFor`.
 *
 * Not a prefix match: `openai/gpt-5.6-luna` is a prefix of
 * `openai/gpt-5.6-luna-pro`, and `deepseek/deepseek-v4-flash` a prefix of
 * `deepseek/deepseek-v4-flash-0731`. Under prefix matching a `-pro` tier
 * would silently bill at the base tier's rate. Every model gets its own
 * row instead.
 *
 * Rates are the Nous portal's, not the underlying vendor's list price —
 * Nous discounts (e.g. `anthropic/claude-haiku-4.5` is $0.80/$4.00 here
 * against Anthropic's own $1.00/$5.00). Pricing a Nous call at vendor list
 * rates would over-count the cap by the discount.
 *
 * Promotional rates (the `-90%` tiers) are recorded as the price actually
 * charged today; when a promotion ends this table is what has to change.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = Object.freeze({
  // Anthropic, via Nous
  'anthropic/claude-fable-5': { input: 8, output: 40 },
  'anthropic/claude-opus-5': { input: 4, output: 20 },
  'anthropic/claude-opus-4.8': { input: 4, output: 20 },
  'anthropic/claude-sonnet-5': { input: 1.6, output: 8 },
  'anthropic/claude-haiku-4.5': { input: 0.8, output: 4 },
  // OpenAI, via Nous
  'openai/gpt-5.6-sol': { input: 4, output: 24 },
  'openai/gpt-5.6-sol-pro': { input: 4, output: 24 },
  'openai/gpt-5.6-terra': { input: 1, output: 6 },
  'openai/gpt-5.6-terra-pro': { input: 1, output: 6 },
  'openai/gpt-5.6-luna': { input: 0.1, output: 0.6 },
  'openai/gpt-5.6-luna-pro': { input: 0.1, output: 0.6 },
  'openai/gpt-5.5': { input: 4, output: 24 },
  'openai/gpt-5.5-pro': { input: 24, output: 144 },
  'openai/gpt-5.4-mini': { input: 0.6, output: 3.6 },
  // Google, via Nous
  'google/gemini-3.1-pro-preview': { input: 1.6, output: 9.6 },
  'google/gemini-3.6-flash': { input: 1.2, output: 6 },
  // xAI, via Nous — the sentiment role's model. Grok is the defensible pick
  // for X/Twitter sentiment because it is the model trained on that discourse,
  // even though nothing here retrieves from X live (see ADR-0009)
  'x-ai/grok-4.5': { input: 1.6, output: 4.8, cache_read: 0.4, ...GROK_LARGE_PROMPT_TIER },
  /**
   * A floating alias, and the only one in this table. The leading `~` is
   * the portal's own marker for one — `x-ai/grok-latest` without it is a
   * 404.
   *
   * The rate here is a fallback that should never be reached: Nous echoes
   * the concrete model it resolved to in the response's `model` field, and
   * `nousChat` meters against that echo whenever this table can price it.
   * So a call through the alias prices at whatever it actually ran on, and
   * follows xAI's next release without a code change.
   *
   * This entry exists for two narrower jobs: satisfying the startup guard
   * in `nous-config.ts`, which checks the model as configured, and pricing
   * the call if the portal ever stops echoing a concrete id — in which
   * case the number below goes stale silently, so it's set to the rate the
   * alias resolves to today.
   *
   * The alias is not the sentiment default — `DEFAULT_NOUS_MODELS.sentiment`
   * pins `x-ai/grok-4.5` above (ADR-0009). This entry stays priced so the
   * alias remains one env var away if live retrieval ever makes corpus
   * recency pay again.
   */
  '~x-ai/grok-latest': { input: 1.6, output: 4.8, cache_read: 0.4, ...GROK_LARGE_PROMPT_TIER },
  // DeepSeek, via Nous
  'deepseek/deepseek-v4-pro': { input: 0.35, output: 0.7 },
  'deepseek/deepseek-v4-flash': { input: 0.07, output: 0.14 },
  'deepseek/deepseek-v4-flash-0731': { input: 0.01, output: 0.02 },
  // Everyone else, via Nous
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
  // doc comment), and "this call was free" is a fact the meter can state
  'tencent/hy3:free': { input: 0, output: 0 },
  'stepfun/step-3.7-flash:free': { input: 0, output: 0 },
  'poolside/laguna-s-2.1:free': { input: 0, output: 0 },
  'poolside/laguna-xs-2.1:free': { input: 0, output: 0 },
  'inclusionai/ling-3.0-flash:free': { input: 0, output: 0 },
});

/**
 * Cache multipliers, applied against the model's input rate.
 *
 * Nothing in this system requests caching — `cache_control` appears
 * nowhere in the repo — so these always multiply zero and are currently
 * inert. They are also no longer uniformly correct: they were uniform
 * across Anthropic's line-up, but across the Nous portal's vendors they
 * are not (`openai/gpt-5.6-luna` reads at 0.1x input, `deepseek/deepseek-
 * v4-pro` at ≈0.008x, and the `:free` tiers at zero). A single constant
 * would misprice most of the table.
 *
 * `ModelRate` carries an optional per-model `cache_read` for the rows that
 * needed it (the grok rows: retrieval made their cache line load-bearing —
 * a measured `x_search` call reported 19,584 cached of 58,153 prompt
 * tokens, and 0.1x would have under-counted the cap against the published
 * 0.4/M rate). `CACHE_READ_MULTIPLIER` is the fallback for rows without one.
 *
 * #1010 measured whether "nothing requests caching" was itself worth
 * fixing and found it moot for the pinned debate model on token size alone
 * — every debate-stage request measures well under the model's cache
 * minimum (`prompt-caching.test.ts` has the figures).
 *
 * The 1-hour-TTL write multiplier is absent for the same reason: nothing
 * requests a 1h TTL, and the usage block doesn't distinguish the two TTLs
 * anyway — that needs a wire-level discriminator first.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Dollars per server-side tool invocation.
 *
 * A provider that runs a tool for you bills the request in two parts —
 * xAI's tools documentation states it directly: "Tool requests are priced
 * based on two components: token usage and tool invocations." A meter
 * that prices only tokens under-counts every such call.
 *
 * The rate is the one Nous publishes for the search tool on its own
 * pricing block ($4.00 per 1,000 calls) — the rate this system is
 * actually billed at, 20% under xAI's list in the same way every token
 * line in `MODEL_RATES` is. Metering at the upstream figure would
 * over-count the cap by the discount.
 *
 * Still unconfirmed: whether this fee bills as a separate line or is
 * already folded into the token charge. `nous-responses.ts` counts
 * invocations conservatively (upper bound); a portal invoice
 * reconciliation is what settles it. If it turns out to be folded in,
 * this constant goes to zero — the wiring stays.
 *
 * Independent of `MODEL_RATES` on purpose: the charge is per invocation,
 * not per token, so it applies whether or not the model itself is in the
 * rate table — an unpriced model still records the tool dollars it
 * definitely cost.
 */
export const SERVER_TOOL_USD_PER_CALL = 0.004;

/**
 * Cost of `count` server-side tool invocations.
 *
 * Never null, unlike `priceUsage`: there is no rate table to miss, so this is
 * either a known charge or zero. A negative or non-finite count is treated as
 * zero rather than propagating a bad number into `cost_usd`, which `SpendCap`
 * would then read as a corrupt row and refuse to compare.
 */
export function priceServerToolCalls(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count * SERVER_TOOL_USD_PER_CALL;
}

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
  /** Absent when nothing was cached — absent means zero here, a real zero rather than an unknown */
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

  // The tier is keyed on the whole prompt, cached tokens included: they
  // occupied the context window whatever they were charged at, which is
  // what the vendor's threshold counts. `promptTokensOf` is the one
  // definition of that sum, shared with `crossesPromptTier`
  const tier =
    rate.tier !== undefined && promptTokensOf(usage) > rate.tier.above_prompt_tokens
      ? rate.tier
      : null;
  const inputRate = tier?.input ?? rate.input;
  const outputRate = tier?.output ?? rate.output;

  // A published per-million cache-read rate wins over the multiplier. It
  // scales off the row's base input rate, not the tier's: no vendor
  // publishes a tiered cache-read multiple
  const cacheReadRate = rate.cache_read ?? rate.input * CACHE_READ_MULTIPLIER;

  const inputCost =
    (usage.input_tokens * inputRate +
      cacheWrite * inputRate * CACHE_WRITE_MULTIPLIER +
      cacheRead * cacheReadRate) /
    TOKENS_PER_MILLION;
  const outputCost = (usage.output_tokens * outputRate) / TOKENS_PER_MILLION;

  return inputCost + outputCost;
}

/**
 * Total prompt tokens a usage record represents — fresh input plus
 * everything read from or written to cache.
 *
 * `AnthropicUsage.input_tokens` is exclusive of cached tokens by this
 * repo's convention (the Nous wire clients subtract, since Nous reports
 * the OpenAI-style inclusive count where `cached_tokens` is a subset of
 * `prompt_tokens`). So the prompt total has to be re-summed here rather
 * than read off one field.
 */
export function promptTokensOf(usage: AnthropicUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

/**
 * Whether this call priced at a model's large-prompt tier.
 *
 * Exists so a caller can warn on a crossing rather than have a 2.5x
 * unit-cost change happen silently inside the meter. Returns false for a
 * model with no tier and for an unpriced one — neither can cross something
 * it does not have.
 */
export function crossesPromptTier(model: string, usage: AnthropicUsage): boolean {
  const tier = rateFor(model)?.tier;
  return tier !== undefined && promptTokensOf(usage) > tier.above_prompt_tokens;
}
