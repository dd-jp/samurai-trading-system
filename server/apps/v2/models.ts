export type DebaterSeat = 'sonnet' | 'gpt' | 'deepseek';

export interface ModelPin {
  readonly seat: DebaterSeat | 'judge';
  readonly wire: string;
  readonly priced: string;
}

export const SONNET_5_PIN: ModelPin = {
  seat: 'sonnet',
  wire: 'anthropic/claude-sonnet-5',
  priced: 'anthropic/claude-sonnet-5',
};

const GPT_5_5_PIN: ModelPin = {
  seat: 'gpt',
  wire: 'openai/gpt-5.5',
  priced: 'openai/gpt-5.5',
};

export const DEEPSEEK_V4_PRO_PIN: ModelPin = {
  seat: 'deepseek',
  wire: 'deepseek/deepseek-v4-pro-0813',
  priced: 'deepseek/deepseek-v4-pro-0813',
};

export const JUDGE_PIN: ModelPin = {
  seat: 'judge',
  wire: 'anthropic/claude-opus-5',
  priced: 'anthropic/claude-opus-5',
};

export const DEBATER_PINS: readonly ModelPin[] = [SONNET_5_PIN, GPT_5_5_PIN, DEEPSEEK_V4_PRO_PIN];

export const ALL_PINS: readonly ModelPin[] = [...DEBATER_PINS, JUDGE_PIN];

export const DEBATER_MAX_TOKENS = 1024;
export const JUDGE_MAX_TOKENS = 1024;
