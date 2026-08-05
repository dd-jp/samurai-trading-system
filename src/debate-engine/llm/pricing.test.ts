/**
 * `pricing.ts` — the rate table behind the local Anthropic spend meter.
 *
 * The cases that matter are the two that silently produce wrong money: a dated
 * snapshot id failing to match its undated rate (would price a real call at
 * $0), and an unknown model being priced at 0 instead of `null` (would
 * understate the total while looking identical to a free call).
 */
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, priceUsage, rateFor } from './pricing.js';

describe('rateFor', () => {
  it('matches a dated snapshot id against its undated rate', () => {
    // The wire carries `claude-haiku-4-5-20251001`; the published rate is
    // quoted against `claude-haiku-4-5`. A miss here prices a live call at $0.
    expect(rateFor('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
  });

  it('matches an exact undated alias', () => {
    expect(rateFor('claude-opus-5')).toEqual({ input: 5, output: 25 });
  });

  it('returns null for a model not in the table rather than guessing', () => {
    expect(rateFor('claude-something-7')).toBeNull();
  });

  it('prefers the longest matching prefix so a shorter id cannot shadow a longer one', () => {
    // `claude-opus-4-8` and `claude-opus-4-6` both start with `claude-opus-4-`;
    // the longest-prefix rule is what keeps them from resolving to each other.
    expect(rateFor('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(rateFor('claude-sonnet-5')).toEqual({ input: 3, output: 15 });
  });
});

describe('priceUsage', () => {
  it('prices plain input and output tokens against the per-million rate', () => {
    // 1M input @ $1 + 1M output @ $5 on Haiku 4.5.
    const cost = priceUsage('claude-haiku-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6, 10);
  });

  it('applies the cache multipliers against the INPUT rate, not the output rate', () => {
    // A cache read billed at the output rate would overstate spend ~5x on
    // Haiku, and cache reads dominate a debate loop's token mix.
    const cost = priceUsage('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(CACHE_READ_MULTIPLIER * 1 + CACHE_WRITE_MULTIPLIER * 1, 10);
  });

  it('treats absent cache fields as zero, not as unknown', () => {
    // The API omits them entirely when nothing was cached.
    const withAbsent = priceUsage('claude-haiku-4-5', {
      input_tokens: 1_000,
      output_tokens: 1_000,
    });
    const withExplicitZero = priceUsage('claude-haiku-4-5', {
      input_tokens: 1_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(withAbsent).toEqual(withExplicitZero);
  });

  it('returns null — never 0 — for a model missing from the table', () => {
    // This is the whole reason `llm_spend.cost_usd` is nullable: a 0 here
    // would be indistinguishable from a genuinely free call and would silently
    // understate the dashboard total.
    expect(
      priceUsage('claude-unreleased-9', { input_tokens: 500_000, output_tokens: 500_000 }),
    ).toBeNull();
  });
});
