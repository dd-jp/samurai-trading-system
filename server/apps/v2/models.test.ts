import { describe, expect, it } from 'vitest';
import { pricedModels } from '../../shared/llm/index.js';
import { ALL_PINS, DEBATER_PINS, JUDGE_PIN, OPENROUTER_PROVIDER_ROUTING } from './models.js';

describe('model pins', () => {
  it('never puts a Fable model in a seat', () => {
    for (const pin of ALL_PINS) expect(pin.wire).not.toMatch(/fable/);
  });

  it('prices every pin against the pricing table', () => {
    const priced = new Set(pricedModels());
    for (const pin of ALL_PINS) expect(priced.has(pin.priced)).toBe(true);
  });

  it('seats Sonnet 5, GPT-5.5 and DeepSeek V4 Pro as debaters and Opus 5 as judge', () => {
    expect(DEBATER_PINS.map((pin) => pin.wire)).toEqual([
      'claude-sonnet-5',
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-pro-0813',
    ]);
    expect(JUDGE_PIN.wire).toBe('claude-opus-5');
    expect(JUDGE_PIN.provider).toBe('anthropic');
  });

  it('routes OpenRouter with no fallbacks and no data collection', () => {
    expect(OPENROUTER_PROVIDER_ROUTING).toEqual({
      allow_fallbacks: false,
      data_collection: 'deny',
    });
  });
});
