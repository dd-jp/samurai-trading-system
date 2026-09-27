import { describe, expect, it } from 'vitest';
import { rateFor } from '../../../shared/llm/index.js';
import { ALL_PINS, DEBATER_PINS, JUDGE_PIN } from './models.js';

describe('model pins', () => {
  it('puts a Fable model in the judge seat only', () => {
    for (const pin of DEBATER_PINS) expect(pin.wire).not.toMatch(/fable/);
    expect(JUDGE_PIN.wire).toMatch(/fable/);
  });

  it('prices every pin under its own Nous id at the 2026-09-27 catalogue rate', () => {
    for (const pin of ALL_PINS) expect(pin.priced).toBe(pin.wire);
    expect(ALL_PINS.map((pin) => rateFor(pin.priced))).toEqual([
      { input: 2, output: 10 },
      { input: 5, output: 30 },
      { input: 0.58, output: 1.74 },
      { input: 10, output: 50 },
    ]);
  });

  it('seats Sonnet 5, GPT-5.5 and DeepSeek V4 Pro as debaters and Fable 5.1 as judge, all on Nous ids', () => {
    expect(DEBATER_PINS.map((pin) => pin.wire)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-pro-0813',
    ]);
    expect(JUDGE_PIN.wire).toBe('anthropic/claude-fable-5.1');
    expect(DEBATER_PINS.map((pin) => pin.seat)).toEqual(['sonnet', 'gpt', 'deepseek']);
    expect(JUDGE_PIN.seat).toBe('judge');
  });

  it('pins the canonical_slug the debate-sleeve spec §4 table records, leaving Sonnet 5 unverified', () => {
    expect(ALL_PINS.map((pin) => [pin.wire, pin.canonicalSlug])).toEqual([
      ['anthropic/claude-sonnet-5', undefined],
      ['openai/gpt-5.5', 'openai/gpt-5.5-20260423'],
      ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-20260813'],
      ['anthropic/claude-fable-5.1', 'anthropic/claude-fable-5.1-20260831'],
    ]);
  });
});
