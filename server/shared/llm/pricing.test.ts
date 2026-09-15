/**
 * `pricing.ts` — the rate table behind the local Nous spend meter.
 *
 * The cases that matter are the ones that silently produce wrong money: an
 * unknown model priced at 0 instead of `null` (would understate the total
 * while looking identical to a free call), a `-pro` tier resolving to its
 * cheaper base tier, and — the one with teeth — a model this system can be
 * CONFIGURED with having no rate at all, which does not fail anywhere. It
 * records a null `cost_usd`, `spend-cap.ts` sums nulls as zero, and ADR-0008's
 * $50/14d ceiling stops existing.
 */
import { DEFAULT_NOUS_MODELS, nousCredentials } from './nous-config.js';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  crossesPromptTier,
  MODEL_RATES,
  pricedModels,
  priceServerToolCalls,
  priceUsage,
  promptTokensOf,
  rateFor,
  SERVER_TOOL_USD_PER_CALL,
} from './pricing.js';

describe('rateFor', () => {
  it('matches an exact Nous model id', () => {
    expect(rateFor('anthropic/claude-haiku-4.5')).toEqual({ input: 0.8, output: 4 });
  });

  it('returns null for a model not in the table rather than guessing', () => {
    expect(rateFor('vendor/something-7')).toBeNull();
  });

  /**
   * The reason this is an exact match and no longer a longest-prefix one.
   * `openai/gpt-5.6-luna` is a literal prefix of `openai/gpt-5.6-luna-pro`, and
   * `deepseek/deepseek-v4-flash` of `deepseek/deepseek-v4-flash-0731` — under
   * prefix matching each would have billed at whichever entry happened to be
   * shorter, silently and in the cheap direction.
   */
  it('does not let one model id resolve to another it is a prefix of', () => {
    expect(rateFor('openai/gpt-5.6-luna')).toEqual({ input: 0.1, output: 0.6 });
    expect(rateFor('deepseek/deepseek-v4-flash')).toEqual({ input: 0.07, output: 0.14 });
    expect(rateFor('deepseek/deepseek-v4-flash-0731')).toEqual({ input: 0.01, output: 0.02 });
  });

  it('does not match a dated snapshot of a listed model — Nous ids are exact', () => {
    // Deliberate, and the reason `nousCredentials` refuses an unpriced model
    // at startup rather than letting one reach the meter.
    expect(rateFor('openai/gpt-5.6-luna-2026-01-01')).toBeNull();
  });

  it('inherits nothing from an unqualified vendor id', () => {
    // The old table was keyed on bare `claude-haiku-4-5`; those keys are gone,
    // so an upstream id echoed back through the proxy cannot price at some
    // other vendor's list rate.
    expect(rateFor('claude-haiku-4-5-20251001')).toBeNull();
  });
});

/**
 * The invariant that keeps the spend cap real.
 *
 * Derived from the table and the role defaults rather than written out by
 * hand, so it cannot drift from what the system can actually be configured
 * with.
 */
describe('no reachable model is unpriced', () => {
  it.each(pricedModels())('prices %s', (model) => {
    expect(priceUsage(model, { input_tokens: 1_000, output_tokens: 1_000 })).not.toBeNull();
  });

  it.each(Object.entries(DEFAULT_NOUS_MODELS))(
    'has a rate for the %s role default',
    (_role, model) => {
      expect(rateFor(model)).not.toBeNull();
    },
  );

  it('refuses to build credentials for a model it cannot price', () => {
    const previous = { ...process.env };
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
    process.env.NOUS_DEBATE_MODEL = 'vendor/not-in-the-table';
    try {
      expect(() => nousCredentials('debate')).toThrow(/MODEL_RATES/);
    } finally {
      process.env = previous;
    }
  });

  it('states every rate in dollars per million tokens, never a negative', () => {
    for (const [model, rate] of Object.entries(MODEL_RATES)) {
      expect(rate.input, model).toBeGreaterThanOrEqual(0);
      expect(rate.output, model).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('priceUsage', () => {
  it('prices plain input and output tokens against the per-million rate', () => {
    // 1M input @ $0.10 + 1M output @ $0.60 on the debate default.
    const cost = priceUsage('openai/gpt-5.6-luna', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.7, 10);
  });

  it('applies the cache multipliers against the INPUT rate, not the output rate', () => {
    // A cache read billed at the output rate would overstate spend ~6x on the
    // debate default.
    const cost = priceUsage('openai/gpt-5.6-luna', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(CACHE_READ_MULTIPLIER * 0.1 + CACHE_WRITE_MULTIPLIER * 0.1, 10);
  });

  it('treats absent cache fields as zero, not as unknown', () => {
    // The API omits them entirely when nothing was cached.
    const withAbsent = priceUsage('openai/gpt-5.6-luna', {
      input_tokens: 1_000,
      output_tokens: 1_000,
    });
    const withExplicitZero = priceUsage('openai/gpt-5.6-luna', {
      input_tokens: 1_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(withAbsent).toEqual(withExplicitZero);
  });

  it('prices a :free tier at a real zero, not at null', () => {
    // Absent from the table would ALSO produce a zero contribution to the cap,
    // by the null route — but "free" and "unpriced" must stay distinguishable
    // on the operator's screen.
    expect(priceUsage('tencent/hy3:free', { input_tokens: 1_000, output_tokens: 1_000 })).toBe(0);
  });

  it('returns null — never 0 — for a model missing from the table', () => {
    // This is the whole reason `llm_spend.cost_usd` is nullable: a 0 here
    // would be indistinguishable from a genuinely free call and would silently
    // understate the dashboard total.
    expect(
      priceUsage('vendor/unreleased-9', { input_tokens: 500_000, output_tokens: 500_000 }),
    ).toBeNull();
  });
});

describe('priceServerToolCalls (#476)', () => {
  // Inert under ADR-0009 — Nous proxies `chat/completions`, which runs no
  // server-side tool, so every call reports zero. Tested anyway because the
  // arithmetic, the `server_tool_calls` column (migration 0018) and the sink's
  // INSERT are one unit, and an untested half is how the unit comes apart.

  it('prices each invocation, because a tool-running provider bills on top of tokens', () => {
    // "Tool requests are priced based on two components: token usage and tool
    // invocations." A meter that priced only tokens under-counted every such
    // call, and ADR-0008's ceiling quietly stopped being a ceiling.
    expect(priceServerToolCalls(1)).toBeCloseTo(SERVER_TOOL_USD_PER_CALL, 10);
    // 200 calls at the Nous-published $4.00/1,000. This literal is pinned
    // rather than derived from the constant on purpose — it is the assertion
    // that notices if the rate is edited without the edit being intended.
    // It read $1.00 while the constant was the unconfirmable third-party
    // $5.00/1,000 figure; #969 re-sourced it to the rate Nous actually bills.
    expect(priceServerToolCalls(200)).toBeCloseTo(0.8, 10);
  });

  it('is the measured retrieval probe, decomposed', () => {
    // THE GOLDEN CASE (#969). Not a synthetic example: this is the usage
    // block a live `x_search` call returned on 2026-09-03, at
    // `max_search_results: 10`, through `~x-ai/grok-latest` (which echoed
    // `x-ai/grok-4.5`, so the pinned row is what prices it).
    //
    //   58,153 prompt tokens, of which 19,584 cached
    //    4,007 output tokens, of which 2,009 reasoning
    //
    // The arithmetic below is what CONFIRMS the OpenAI-inclusive reading of
    // that block: 38,569 fresh @ $1.60/M + 19,584 cached @ $0.40/M + 4,007
    // out @ $4.80/M = $0.088778. Reading `cached` as a sibling of `prompt`
    // instead of a subset gives $0.10012 — 13% high — and pricing the cache
    // line at `CACHE_READ_MULTIPLIER` (0.1x = $0.16/M) instead of the
    // published $0.40/M gives $0.084102. Only one reading lands here, which
    // is why this test is the evidence and not just a regression guard.
    const usage = {
      input_tokens: 58_153 - 19_584,
      output_tokens: 4_007,
      cache_read_input_tokens: 19_584,
    };

    expect(priceUsage('x-ai/grok-4.5', usage)).toBeCloseTo(0.088_778, 6);
    // The alias must agree with the id it resolves to, or the meter's answer
    // would depend on whether the provider happened to echo.
    expect(priceUsage('~x-ai/grok-latest', usage)).toBeCloseTo(0.088_778, 6);
  });

  it('applies the large-prompt tier to the whole request once crossed', () => {
    // The cap-safe reading: at 200,001 prompt tokens EVERY token prices at
    // the tier rate, not just the one over the line. Under-counting here
    // spends past ADR-0008's ceiling; over-counting stops trading early.
    const under = { input_tokens: 200_000, output_tokens: 1_000 };
    const over = { input_tokens: 200_001, output_tokens: 1_000 };

    // 200,000 @ $1.60/M + 1,000 @ $4.80/M
    expect(priceUsage('x-ai/grok-4.5', under)).toBeCloseTo(0.3248, 6);
    // 200,001 @ $4.00/M + 1,000 @ $12.00/M — a 2.5x step, not a marginal one.
    expect(priceUsage('x-ai/grok-4.5', over)).toBeCloseTo(0.812_004, 6);

    expect(crossesPromptTier('x-ai/grok-4.5', under)).toBe(false);
    expect(crossesPromptTier('x-ai/grok-4.5', over)).toBe(true);
  });

  it('counts cached tokens toward the tier threshold', () => {
    // A cached token still occupied the context window, which is what the
    // vendor's threshold measures. Summing only `input_tokens` — which is
    // EXCLUSIVE of cache by this repo's convention — would let a
    // heavily-cached 300k-token prompt price at the base rate.
    const usage = {
      input_tokens: 100_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 150_000,
    };

    expect(promptTokensOf(usage)).toBe(250_000);
    expect(crossesPromptTier('x-ai/grok-4.5', usage)).toBe(true);
  });

  it('has no tier for models the vendor does not publish one for', () => {
    const huge = { input_tokens: 5_000_000, output_tokens: 1 };
    expect(crossesPromptTier('anthropic/claude-haiku-4.5', huge)).toBe(false);
    // An unpriced model cannot cross a tier it has no row for.
    expect(crossesPromptTier('not/a-real-model', huge)).toBe(false);
  });

  it('falls back to the multiplier for rows with no published cache rate', () => {
    // Unchanged behaviour for every row that did not need a `cache_read`
    // column: 1,000 cached @ 0.1 x $0.80/M input.
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000 };
    expect(priceUsage('anthropic/claude-haiku-4.5', usage)).toBeCloseTo(0.000_08, 8);
  });

  it('never returns null, unlike priceUsage', () => {
    // There is no rate table to miss: the charge is per invocation, so it is
    // knowable for ANY model. That is what lets an unpriced model still record
    // the tool dollars it definitely cost.
    expect(priceServerToolCalls(0)).toBe(0);
  });

  it('treats a nonsense count as zero rather than poisoning cost_usd', () => {
    // A NaN or negative reaching `cost_usd` would make `SpendCap` read the row
    // as corrupt and refuse to compare — an accounting slip would become a
    // halted cap.
    expect(priceServerToolCalls(Number.NaN)).toBe(0);
    expect(priceServerToolCalls(-3)).toBe(0);
    expect(priceServerToolCalls(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
