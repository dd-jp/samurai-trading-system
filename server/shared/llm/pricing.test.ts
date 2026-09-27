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

  it('carries the Nous catalogue rates for the v2 seats (checked 2026-09-25)', () => {
    expect(rateFor('anthropic/claude-fable-5.1')).toEqual({ input: 10, output: 50 });
    expect(rateFor('anthropic/claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(rateFor('anthropic/claude-sonnet-5')).toEqual({ input: 2, output: 10 });
    expect(rateFor('openai/gpt-5.5')).toEqual({ input: 5, output: 30 });
    expect(rateFor('deepseek/deepseek-v4-pro-0813')).toEqual({ input: 0.58, output: 1.74 });
    expect(rateFor('claude-opus-5')).toBeNull();
    expect(rateFor('claude-sonnet-5')).toBeNull();
  });

  it('returns null for a model not in the table rather than guessing', () => {
    expect(rateFor('vendor/something-7')).toBeNull();
  });

  it('does not let one model id resolve to another it is a prefix of', () => {
    expect(rateFor('openai/gpt-5.6-luna')).toEqual({ input: 0.1, output: 0.6 });
    expect(rateFor('deepseek/deepseek-v4-flash')).toEqual({ input: 0.07, output: 0.14 });
    expect(rateFor('deepseek/deepseek-v4-flash-0731')).toEqual({ input: 0.01, output: 0.02 });
  });

  it('does not match a dated snapshot of a listed model — Nous ids are exact', () => {
    expect(rateFor('openai/gpt-5.6-luna-2026-01-01')).toBeNull();
  });

  it('inherits nothing from an unqualified vendor id', () => {
    expect(rateFor('claude-haiku-4-5-20251001')).toBeNull();
  });
});

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
    const cost = priceUsage('openai/gpt-5.6-luna', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.7, 10);
  });

  it('applies the cache multipliers against the INPUT rate, not the output rate', () => {
    const cost = priceUsage('openai/gpt-5.6-luna', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(CACHE_READ_MULTIPLIER * 0.1 + CACHE_WRITE_MULTIPLIER * 0.1, 10);
  });

  it('treats absent cache fields as zero, not as unknown', () => {
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
    expect(priceUsage('tencent/hy3:free', { input_tokens: 1_000, output_tokens: 1_000 })).toBe(0);
  });

  it('returns null — never 0 — for a model missing from the table', () => {
    expect(
      priceUsage('vendor/unreleased-9', { input_tokens: 500_000, output_tokens: 500_000 }),
    ).toBeNull();
  });
});

describe('priceServerToolCalls (#476)', () => {
  it('prices each invocation, because a tool-running provider bills on top of tokens', () => {
    expect(priceServerToolCalls(1)).toBeCloseTo(SERVER_TOOL_USD_PER_CALL, 10);
    expect(priceServerToolCalls(200)).toBeCloseTo(0.8, 10);
  });

  it('is the measured retrieval probe, decomposed', () => {
    const usage = {
      input_tokens: 58_153 - 19_584,
      output_tokens: 4_007,
      cache_read_input_tokens: 19_584,
    };

    expect(priceUsage('x-ai/grok-4.5', usage)).toBeCloseTo(0.088_778, 6);
    expect(priceUsage('~x-ai/grok-latest', usage)).toBeCloseTo(0.088_778, 6);
  });

  it('applies the large-prompt tier to the whole request once crossed', () => {
    const under = { input_tokens: 200_000, output_tokens: 1_000 };
    const over = { input_tokens: 200_001, output_tokens: 1_000 };

    expect(priceUsage('x-ai/grok-4.5', under)).toBeCloseTo(0.3248, 6);
    expect(priceUsage('x-ai/grok-4.5', over)).toBeCloseTo(0.812_004, 6);

    expect(crossesPromptTier('x-ai/grok-4.5', under)).toBe(false);
    expect(crossesPromptTier('x-ai/grok-4.5', over)).toBe(true);
  });

  it('counts cached tokens toward the tier threshold', () => {
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
    expect(crossesPromptTier('not/a-real-model', huge)).toBe(false);
  });

  it('falls back to the multiplier for rows with no published cache rate', () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000 };
    expect(priceUsage('anthropic/claude-haiku-4.5', usage)).toBeCloseTo(0.000_08, 8);
  });

  it('never returns null, unlike priceUsage', () => {
    expect(priceServerToolCalls(0)).toBe(0);
  });

  it('treats a nonsense count as zero rather than poisoning cost_usd', () => {
    expect(priceServerToolCalls(Number.NaN)).toBe(0);
    expect(priceServerToolCalls(-3)).toBe(0);
    expect(priceServerToolCalls(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
