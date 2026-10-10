import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rateFor } from '../../../shared/llm/index.js';
import { ALL_PINS, DEBATER_PINS, JUDGE_PIN, type ModelPin, pinDigest } from './models.js';

describe('model pins', () => {
  it('never puts a Fable model in a seat', () => {
    for (const pin of ALL_PINS) expect(pin.wire).not.toMatch(/fable/);
  });

  it('prices every pin under its own Nous id at the 2026-09-27 catalogue rate', () => {
    for (const pin of ALL_PINS) expect(pin.priced).toBe(pin.wire);
    expect(ALL_PINS.map((pin) => rateFor(pin.priced))).toEqual([
      { input: 2, output: 10 },
      { input: 5, output: 30 },
      { input: 0.58, output: 1.74 },
      { input: 4, output: 20 },
    ]);
  });

  it('seats Sonnet 5, GPT-5.5 and DeepSeek V4 Pro as debaters and Opus 5.5 as judge, all on Nous ids', () => {
    expect(DEBATER_PINS.map((pin) => pin.wire)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-pro-0813',
    ]);
    expect(JUDGE_PIN.wire).toBe('anthropic/claude-opus-5.5');
    expect(DEBATER_PINS.map((pin) => pin.seat)).toEqual(['sonnet', 'gpt', 'deepseek']);
    expect(JUDGE_PIN.seat).toBe('judge');
  });

  it('pins the canonical_slug the debate-sleeve spec §4 table records, leaving Sonnet 5 unverified', () => {
    expect(ALL_PINS.map((pin) => [pin.wire, pin.canonicalSlug])).toEqual([
      ['anthropic/claude-sonnet-5', undefined],
      ['openai/gpt-5.5', 'openai/gpt-5.5-20260423'],
      ['deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-20260813'],
      ['anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5-20260921'],
    ]);
  });
});

describe('pinDigest (#1747, David 2026-10-10)', () => {
  const sha16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

  it('hashes each pin as seat, wire and configured slug, sorted by seat, to 16 hex', () => {
    expect(pinDigest([JUDGE_PIN, ...DEBATER_PINS])).toBe(
      sha16(
        JSON.stringify(
          [...ALL_PINS]
            .sort((a, b) => (a.seat < b.seat ? -1 : 1))
            .map(({ seat, wire, canonicalSlug }) => ({
              seat,
              wire,
              canonicalSlug: canonicalSlug ?? null,
            })),
        ),
      ),
    );
    expect(pinDigest([...ALL_PINS].reverse())).toBe(pinDigest(ALL_PINS));
    expect(pinDigest([])).toBe(sha16('[]'));
  });

  it('writes an absent slug as null', () => {
    const pin: ModelPin = { seat: 'sonnet', wire: 'w', priced: 'p', canonicalSlug: undefined };
    expect(pinDigest([pin])).toBe(
      sha16(JSON.stringify([{ seat: 'sonnet', wire: 'w', canonicalSlug: null }])),
    );
  });

  it('moves on a wire or configured slug change, never on the priced id', () => {
    const base = pinDigest([JUDGE_PIN]);
    expect(pinDigest([{ ...JUDGE_PIN, wire: 'anthropic/other' }])).not.toBe(base);
    expect(pinDigest([{ ...JUDGE_PIN, canonicalSlug: 'anthropic/other-1' }])).not.toBe(base);
    expect(pinDigest([{ ...JUDGE_PIN, priced: 'anthropic/other' }])).toBe(base);
  });
});
