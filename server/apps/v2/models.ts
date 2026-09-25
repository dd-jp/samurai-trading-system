export type ModelProvider = 'anthropic' | 'openrouter';

export type DebaterSeat = 'sonnet' | 'gpt' | 'deepseek';

export interface ModelPin {
  readonly seat: DebaterSeat | 'judge';
  readonly provider: ModelProvider;
  readonly wire: string;
  readonly priced: string;
}

export const ANTHROPIC_API_VERSION = '2023-06-01';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const OPENROUTER_PROVIDER_ROUTING = {
  allow_fallbacks: false,
  data_collection: 'deny',
} as const;

// OpenRouter listing checked 2026-09-25 (docs/specs/debate-sleeve-spec.md §4) carries no dated
// GPT-5.5 slug, so that pin is the bare slug plus this date; DeepSeek's dated slug is -0813
export const SONNET_5_PIN: ModelPin = {
  seat: 'sonnet',
  provider: 'anthropic',
  wire: 'claude-sonnet-5',
  priced: 'anthropic/claude-sonnet-5',
};

const GPT_5_5_PIN: ModelPin = {
  seat: 'gpt',
  provider: 'openrouter',
  wire: 'openai/gpt-5.5',
  priced: 'openai/gpt-5.5',
};

export const DEEPSEEK_V4_PRO_PIN: ModelPin = {
  seat: 'deepseek',
  provider: 'openrouter',
  wire: 'deepseek/deepseek-v4-pro-0813',
  priced: 'deepseek/deepseek-v4-pro',
};

export const JUDGE_PIN: ModelPin = {
  seat: 'judge',
  provider: 'anthropic',
  wire: 'claude-opus-5',
  priced: 'anthropic/claude-opus-5',
};

export const DEBATER_PINS: readonly ModelPin[] = [SONNET_5_PIN, GPT_5_5_PIN, DEEPSEEK_V4_PRO_PIN];

export const ALL_PINS: readonly ModelPin[] = [...DEBATER_PINS, JUDGE_PIN];

export const DEBATER_MAX_TOKENS = 1024;
export const JUDGE_MAX_TOKENS = 1024;
