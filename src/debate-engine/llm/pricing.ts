/**
 * Local price table for Anthropic token usage — the arithmetic half of the
 * spend meter that stands in for the credit-balance endpoint Anthropic does
 * not publish (see migrations/0010_llm_spend.sql for why the meter exists).
 *
 * A HARDCODED TABLE IS THE POINT, not a shortcut. There is no pricing endpoint
 * to query, so any implementation is a table somewhere; putting it here — one
 * module, one exported constant, prices in dollars-per-million-tokens exactly
 * as Anthropic publishes them — makes it greppable and diff-able when rates
 * change, instead of scattering magic numbers through the reader.
 *
 * The corollary is that this table goes stale. `priceUsage` returns `null`
 * rather than guessing for a model it does not recognise, and that `null`
 * survives all the way to the operator's screen as "unpriced" (the
 * `cost_usd REAL` column is nullable for this reason). A wrong number on a
 * money surface is worse than a visibly missing one.
 */

/** Dollars per million tokens, as published. */
export interface ModelRate {
  input: number;
  output: number;
}

/**
 * Keys are model-id PREFIXES, matched longest-first by `rateFor`, because the
 * wire carries dated snapshot ids (`claude-haiku-4-5-20251001`) while the
 * published rates are quoted against the undated alias (`claude-haiku-4-5`).
 * Matching on prefix means a new dated snapshot of an existing model prices
 * correctly without a code change; a genuinely new model still falls through
 * to `null`, which is the intended behaviour.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = Object.freeze({
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  /**
   * xAI, for the Grok market-intelligence agent (#464). Present so that
   * ADR-0008's cap is CROSS-PROVIDER rather than Anthropic-only: the cap sums
   * `cost_usd`, `priceUsage` returns null for an unrecognised model, and a
   * null lands in the table unpriced — so without a rate here the cap would
   * sum straight past every xAI call and the ceiling would be a fiction.
   *
   * CORRECTED 2026-08-06 (post-hoc review of #469). The previous entries were
   * `grok-4` and `grok-3` at 3/15, with a comment claiming they were published
   * rates retrieved from x.ai/api. **Neither model exists in xAI's lineup**,
   * and the rate matched nothing real. Verified against docs.x.ai/docs/models.
   *
   * The prefix matching made that actively harmful rather than merely dead:
   * `'grok-4.5'.startsWith('grok-4')` is true, so every real model would have
   * priced against the phantom entry — grok-4.3 at 3/15 instead of 1.25/2.50,
   * a 2.4x-6x OVER-estimate. Over-pricing trips ADR-0008's cap early, which
   * looks like an outage: Grok stops refreshing mid-soak and the debate's own
   * budget is crowded out by spend that never happened.
   *
   * Figures below are the <200k-token tier, which is the only one these calls
   * reach (one instrument's sentiment, capped at 10 themes). The >=200k tier is
   * exactly double on both sides for every model; if a caller ever sends a long
   * context, these under-price by 2x and the cap runs late.
   */
  'grok-4.5': { input: 2, output: 6 },
  'grok-4.3': { input: 1.25, output: 2.5 },
  'grok-4.20': { input: 1.25, output: 2.5 },
  'grok-build-0.1': { input: 1, output: 2 },
});

/**
 * Cache multipliers, applied against the model's INPUT rate.
 *
 * These are uniform across models — a cache read is a tenth of input and a
 * 5-minute cache write is 1.25x input on every current model — so they live as
 * two constants rather than two more columns per row in `MODEL_RATES`, which
 * would invite them drifting apart per-model for no reason.
 *
 * The 1-hour-TTL write multiplier (2x) is deliberately absent: nothing in this
 * system requests a 1h TTL, and carrying a rate for a code path that does not
 * exist would be a second thing to keep in sync with no caller. If a 1h
 * breakpoint is ever introduced, the usage block does not distinguish the two
 * TTLs anyway — that change needs a wire-level discriminator first, not just a
 * constant here.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

const TOKENS_PER_MILLION = 1_000_000;

/** The `usage` block Anthropic returns on every Messages API response. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  /** Absent when nothing was cached — absent means zero here, a real zero rather than an unknown. */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Longest-prefix match, so `claude-opus-4-5` cannot shadow a hypothetical
 * `claude-opus-4-5-turbo` entry added later. Exported for the test that pins
 * the dated-snapshot behaviour.
 */
export function rateFor(model: string): ModelRate | null {
  let best: { prefix: string; rate: ModelRate } | null = null;
  for (const [prefix, rate] of Object.entries(MODEL_RATES)) {
    if (!model.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.prefix.length) {
      best = { prefix, rate };
    }
  }
  return best?.rate ?? null;
}

/**
 * Cost in USD for one call, or `null` when the model is not in the table.
 *
 * Note the asymmetry with the token counts the caller records alongside this:
 * those are exact and always available, this is an estimate against a table
 * that can go stale. It is a spend indicator for an operator watching a paper
 * run, not a billing reconciliation — Anthropic's own invoice is authoritative
 * and this will differ from it (it cannot see Console usage, other machines on
 * the same key, or long-context/priority-tier rate variants).
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
