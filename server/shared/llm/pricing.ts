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

/** Dollars per million tokens, as published on the Nous portal */
export interface ModelRate {
  input: number;
  output: number;
  /**
   * Dollars per million CACHE-READ tokens, when the vendor publishes a rate
   * for them rather than a multiple of `input`.
   *
   * Optional because most rows do not need it: `priceUsage` falls back to
   * `input * CACHE_READ_MULTIPLIER` when it is absent, which is what every
   * caller got before this column existed. Populated where the fallback is
   * measurably wrong — see the grok rows, where 0.1x understates the real
   * charge by 2.5x and would have under-counted the cap on every retrieval
   * call (#969).
   */
  cache_read?: number;
  /**
   * A LARGE-PROMPT RATE OVERRIDE, applied to the WHOLE request once the
   * prompt crosses `above_prompt_tokens`.
   *
   * Server-side retrieval is what makes this reachable: search results ride
   * in the prompt, so an `x_search` call is not a small request. A measured
   * 10-result call carried 58,153 prompt tokens against the ~5,000 of a
   * 3-result one, and the ceiling is the vendor's, not ours.
   *
   * "Whole request, not just the excess" is the CAP-SAFE reading of ambiguous
   * vendor wording, chosen deliberately: an over-count trips ADR-0008's
   * ceiling early and stops trading, an under-count spends past it. When the
   * vendor clarifies, `pricing.test.ts`'s tier case is where the reading is
   * pinned.
   */
  tier?: { above_prompt_tokens: number; input: number; output: number };
}

/**
 * xAI's large-prompt tier, shared by BOTH grok rows below.
 *
 * Both, not just the alias, because `resolveMeteredModel` (`nous-chat.ts`)
 * meters against the id the provider ECHOED, and `~x-ai/grok-latest` echoes
 * `x-ai/grok-4.5`. The row that actually prices a retrieval call is therefore
 * the pinned one, so a tier on the alias alone would never fire (#969).
 */
const GROK_LARGE_PROMPT_TIER = {
  tier: { above_prompt_tokens: 200_000, input: 4, output: 12 },
} as const;

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
   * A FLOATING ALIAS, and the only one in this table. The leading `~` is the
   * portal's own marker for one — `x-ai/grok-latest` without it is a 404,
   * confirmed against the live `/models` endpoint (2026-08-06).
   *
   * The rate here is a FALLBACK that should never be reached. Nous echoes the
   * concrete model it resolved to in the response's `model` field —
   * `~x-ai/grok-latest` came back as `x-ai/grok-4.5` on a live probe — and
   * `nousChat` meters against that echo whenever this table can price it. So a
   * call through the alias prices at whatever it actually ran on, and follows
   * xAI's next release without a code change.
   *
   * This entry exists for two narrower jobs: satisfying the startup guard in
   * `nous-config.ts`, which checks the model as CONFIGURED, and pricing the
   * call if the portal ever stops echoing a concrete id. In that second case
   * the number below goes stale silently, so it is set to the rate the alias
   * resolves to today.
   *
   * The alias is NOT the sentiment default — `DEFAULT_NOUS_MODELS.sentiment`
   * pins `x-ai/grok-4.5` above (ADR-0009, after the 2026-08-06 measurement).
   * This entry stays priced so the alias remains one env var away if live
   * retrieval ever makes corpus recency pay again.
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
 * That flag has since been acted on for the rows that needed it: `ModelRate`
 * now carries an optional per-model `cache_read`, and `CACHE_READ_MULTIPLIER`
 * is the FALLBACK for rows without one rather than the universal rule. The
 * grok rows are populated because retrieval made their cache line load-bearing
 * — a measured `x_search` call reported 19,584 cached of 58,153 prompt tokens,
 * and pricing those at 0.1x rather than the published 0.4/M under-counted the
 * cap (#969). The remaining rows keep the fallback: nothing requests caching
 * on them, so the multiplier still multiplies zero there.
 *
 * `CACHE_WRITE_MULTIPLIER` is untouched and genuinely inert — nothing in this
 * system writes a cache entry, on any vendor.
 *
 * #1010 measured whether "nothing requests caching" was itself worth fixing
 * and found it moot for the pinned debate model (Claude Haiku 4.5) on token
 * size alone — every debate-stage request measures well under the model's
 * cache minimum. Full figures and the production measurement live in
 * `server/pipeline/debate-engine/llm/prompt-caching.test.ts`, the canonical
 * home for this finding; this multiplier stays inert for that reason too,
 * not only the per-vendor pricing gap above.
 *
 * The 1-hour-TTL write multiplier (2x) is absent for the same reason it always
 * was: nothing requests a 1h TTL, and the usage block does not distinguish the
 * two TTLs anyway — that change needs a wire-level discriminator first.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Dollars per server-side tool invocation (#476).
 *
 * A provider that runs a tool for you bills the request in two parts. xAI's
 * tools documentation states it directly: "Tool requests are priced based on
 * two components: token usage and tool invocations." A meter that prices only
 * tokens under-counts every such call.
 *
 * NO LONGER INERT, as of 2026-09-03 (#969). This was documented as
 * unreachable on the reasoning that "Nous proxies `chat/completions` only, so
 * server-side tools live on an endpoint ADR-0009 gave up". That premise was
 * false on both halves: Nous serves `POST /responses`, and `x_search` runs
 * there on the OpenRouter-routed alias `~x-ai/grok-latest`. The comment kept
 * the arithmetic alive for "the day a provider grows a server-side tool"; that
 * day arrived, and `nous-responses.ts` now populates the count this prices.
 *
 * PROVENANCE, RE-SOURCED: the two-component billing MODEL was always confirmed
 * against xAI's own documentation. The FIGURE was previously $5.00/1,000 calls
 * taken from third-party summaries and explicitly flagged as unconfirmable.
 * It is now the rate Nous publishes for the search tool on its own pricing
 * block — $4.00 per 1,000 calls — which is the rate this system is actually
 * billed at, and is 20% under xAI's list in exactly the way every token line
 * in `MODEL_RATES` is. Metering a Nous call at the upstream figure would
 * over-count the cap by the discount, the same error the table header warns
 * about for tokens.
 *
 * WHAT IS STILL UNCONFIRMED is whether this fee bills as a separate line or is
 * already folded into the token charge. `nous-responses.ts` counts invocations
 * conservatively (upper bound) and the V3 reconciliation against the portal
 * invoice is what settles it. If it turns out to be folded in, this constant
 * goes to zero — the wiring stays.
 *
 * Independent of `MODEL_RATES` on purpose: the charge is per invocation, not
 * per token, so it applies whether or not the model itself is in the rate
 * table. That is what lets an unpriced model still record the tool dollars it
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

  // The tier is keyed on the WHOLE prompt, cached tokens included: they
  // occupied the context window whatever they were charged at, which is what
  // the vendor's threshold counts. `promptTokensOf` is the one definition of
  // that sum, shared with `crossesPromptTier` so a caller's warning and this
  // arithmetic can never disagree
  const tier =
    rate.tier !== undefined && promptTokensOf(usage) > rate.tier.above_prompt_tokens
      ? rate.tier
      : null;
  const inputRate = tier?.input ?? rate.input;
  const outputRate = tier?.output ?? rate.output;

  // A published per-million cache-read rate wins over the multiplier. Note it
  // scales off the row's BASE input rate, not the tier's: no vendor publishes
  // a tiered cache-read multiple, so inventing one would be a guess in the
  // under-counting direction for rows using the fallback
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
 * Total prompt tokens a usage record represents — fresh input plus everything
 * that was read from or written to cache.
 *
 * `AnthropicUsage.input_tokens` is EXCLUSIVE of cached tokens by this repo's
 * convention (the Nous wire clients subtract, because Nous reports the
 * OpenAI-style inclusive count where `cached_tokens` is a subset of
 * `prompt_tokens`). So the prompt total has to be re-summed here rather than
 * read off one field, and this function is the only place that knows it.
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
 * Exists so a caller can WARN on a crossing rather than have a 2.5x unit-cost
 * change happen silently inside the meter. Returns false for a model with no
 * tier and for an unpriced one — neither can cross something it does not have.
 */
export function crossesPromptTier(model: string, usage: AnthropicUsage): boolean {
  const tier = rateFor(model)?.tier;
  return tier !== undefined && promptTokensOf(usage) > tier.above_prompt_tokens;
}
