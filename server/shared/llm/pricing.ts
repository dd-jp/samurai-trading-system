export interface ModelRate {
  input: number;
  output: number;
  cache_read?: number;
  tier?: { above_prompt_tokens: number; input: number; output: number };
}

const GROK_LARGE_PROMPT_TIER = {
  tier: { above_prompt_tokens: 200_000, input: 4, output: 12 },
} as const;

// First-party Claude API list rates (claude-api skill, shared/model-migration.md: Opus 5 $5/$25,
// Sonnet 5 $2/$10 per MTok); the 'anthropic/' keys below are the Nous-discounted rates
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = Object.freeze({
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'anthropic/claude-fable-5': { input: 8, output: 40 },
  'anthropic/claude-opus-5': { input: 4, output: 20 },
  'anthropic/claude-opus-4.8': { input: 4, output: 20 },
  'anthropic/claude-sonnet-5': { input: 1.6, output: 8 },
  'anthropic/claude-haiku-4.5': { input: 0.8, output: 4 },
  'openai/gpt-5.6-sol': { input: 4, output: 24 },
  'openai/gpt-5.6-sol-pro': { input: 4, output: 24 },
  'openai/gpt-5.6-terra': { input: 1, output: 6 },
  'openai/gpt-5.6-terra-pro': { input: 1, output: 6 },
  'openai/gpt-5.6-luna': { input: 0.1, output: 0.6 },
  'openai/gpt-5.6-luna-pro': { input: 0.1, output: 0.6 },
  'openai/gpt-5.5': { input: 4, output: 24 },
  'openai/gpt-5.5-pro': { input: 24, output: 144 },
  'openai/gpt-5.4-mini': { input: 0.6, output: 3.6 },
  'google/gemini-3.1-pro-preview': { input: 1.6, output: 9.6 },
  'google/gemini-3.6-flash': { input: 1.2, output: 6 },
  'x-ai/grok-4.5': { input: 1.6, output: 4.8, cache_read: 0.4, ...GROK_LARGE_PROMPT_TIER },
  '~x-ai/grok-latest': { input: 1.6, output: 4.8, cache_read: 0.4, ...GROK_LARGE_PROMPT_TIER },
  'deepseek/deepseek-v4-pro': { input: 0.35, output: 0.7 },
  'deepseek/deepseek-v4-flash': { input: 0.07, output: 0.14 },
  'deepseek/deepseek-v4-flash-0731': { input: 0.01, output: 0.02 },
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
  'tencent/hy3:free': { input: 0, output: 0 },
  'stepfun/step-3.7-flash:free': { input: 0, output: 0 },
  'poolside/laguna-s-2.1:free': { input: 0, output: 0 },
  'poolside/laguna-xs-2.1:free': { input: 0, output: 0 },
  'inclusionai/ling-3.0-flash:free': { input: 0, output: 0 },
});

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export const SERVER_TOOL_USD_PER_CALL = 0.004;

export function priceServerToolCalls(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count * SERVER_TOOL_USD_PER_CALL;
}

const TOKENS_PER_MILLION = 1_000_000;

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function rateFor(model: string): ModelRate | null {
  return Object.hasOwn(MODEL_RATES, model) ? (MODEL_RATES[model] ?? null) : null;
}

export function pricedModels(): readonly string[] {
  return Object.keys(MODEL_RATES);
}

export function priceUsage(model: string, usage: AnthropicUsage): number | null {
  const rate = rateFor(model);
  if (rate === null) return null;

  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const tier =
    rate.tier !== undefined && promptTokensOf(usage) > rate.tier.above_prompt_tokens
      ? rate.tier
      : null;
  const inputRate = tier?.input ?? rate.input;
  const outputRate = tier?.output ?? rate.output;

  const cacheReadRate = rate.cache_read ?? rate.input * CACHE_READ_MULTIPLIER;

  const inputCost =
    (usage.input_tokens * inputRate +
      cacheWrite * inputRate * CACHE_WRITE_MULTIPLIER +
      cacheRead * cacheReadRate) /
    TOKENS_PER_MILLION;
  const outputCost = (usage.output_tokens * outputRate) / TOKENS_PER_MILLION;

  return inputCost + outputCost;
}

export function promptTokensOf(usage: AnthropicUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export function crossesPromptTier(model: string, usage: AnthropicUsage): boolean {
  const tier = rateFor(model)?.tier;
  return tier !== undefined && promptTokensOf(usage) > tier.above_prompt_tokens;
}
