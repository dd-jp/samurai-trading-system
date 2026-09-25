import { describe, expect, it } from 'vitest';
import { rateFor } from '../../shared/llm/index.js';
import { ALL_PINS, DEBATER_PINS, JUDGE_PIN } from './models.js';

describe('model pins', () => {
  it('never puts a Fable model in a seat', () => {
    for (const pin of ALL_PINS) expect(pin.wire).not.toMatch(/fable/);
  });

  it('prices every pin under its own Nous id at the 2026-09-25 catalogue rate', () => {
    for (const pin of ALL_PINS) expect(pin.priced).toBe(pin.wire);
    expect(ALL_PINS.map((pin) => rateFor(pin.priced))).toEqual([
      { input: 2, output: 10 },
      { input: 5, output: 30 },
      { input: 0.58, output: 1.74 },
      { input: 5, output: 25 },
    ]);
  });

  it('seats Sonnet 5, GPT-5.5 and DeepSeek V4 Pro as debaters and Opus 5 as judge, all on Nous ids', () => {
    expect(DEBATER_PINS.map((pin) => pin.wire)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-pro-0813',
    ]);
    expect(JUDGE_PIN.wire).toBe('anthropic/claude-opus-5');
    expect(DEBATER_PINS.map((pin) => pin.seat)).toEqual(['sonnet', 'gpt', 'deepseek']);
    expect(JUDGE_PIN.seat).toBe('judge');
  });
});
