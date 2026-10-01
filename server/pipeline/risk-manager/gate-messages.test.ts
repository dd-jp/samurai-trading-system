import { describe, expect, it } from 'vitest';
import { armedBreakersText, longOnlyRefusalReason } from './index.js';
import type { RiskInput } from './types.js';

function intent(intent_type: 'entry' | 'scale_in'): RiskInput['intent'] {
  return { intent_type, instrument: 'VUSA' } as RiskInput['intent'];
}

describe('longOnlyRefusalReason', () => {
  it.each([
    ['entry', 'with no held lot'],
    ['scale_in', 'on a scale_in'],
  ] as const)('names the position claim for a sell %s', (intentType, claim) => {
    expect(longOnlyRefusalReason(intent(intentType))).toBe(
      `long_only_book: refusing a sell ${intentType} on VUSA ${claim} — #1511 decided a long-only ` +
        'book for the Saxo GIA equity leg. A sell that is not an exit is a short on the long ETP: ' +
        'not sized or costed (no borrow/margin model, ADR-0016/0018 sized this universe ' +
        'long-only); a "down" thesis routes to the paired inverse line if it is in the universe.',
    );
  });
});

describe('armedBreakersText', () => {
  it('lists the armed breakers', () => {
    expect(armedBreakersText({ armed_breakers: ['daily', 'weekly'] })).toBe('daily, weekly');
  });

  it('reads none when nothing is armed', () => {
    expect(armedBreakersText({ armed_breakers: [] })).toBe('none');
  });
});
