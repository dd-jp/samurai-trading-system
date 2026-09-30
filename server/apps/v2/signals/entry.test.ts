import { describe, expect, it } from 'vitest';
import { bracketTarget, planSignalEntry } from './entry.js';

describe('bracketTarget', () => {
  it('takes the first target at least 2R above the entry', () => {
    expect(bracketTarget(100, 95, [105, 109.99, 110, 120])).toBe(110);
    expect(bracketTarget(100, 95, [111, 120])).toBe(111);
  });

  it('falls back to the last target when none reaches 2R', () => {
    expect(bracketTarget(100, 95, [102, 104, 109])).toBe(109);
  });

  it('throws on an empty target list', () => {
    expect(() => bracketTarget(100, 95, [])).toThrow('at least one target');
  });
});

describe('planSignalEntry', () => {
  it('plans a limit at a single entry at or below the last close', () => {
    expect(planSignalEntry({ entry: 50, targets: [52, 56, 60], stop: 48 }, 50)).toEqual({
      ok: true,
      plan: { limit: 50, stop: 48, target: 56, riskPerShare: 2 },
    });
    expect(planSignalEntry({ entry: 49, targets: [60], stop: 48 }, 50.5)).toMatchObject({
      ok: true,
      plan: { limit: 49 },
    });
  });

  it('plans a zone as a limit at its high, even when the high is above the last close', () => {
    expect(planSignalEntry({ entry: [49, 51], targets: [55, 60], stop: 47 }, 50)).toEqual({
      ok: true,
      plan: { limit: 51, stop: 47, target: 60, riskPerShare: 4 },
    });
  });

  it('refuses a single entry above the last close as a buy-stop', () => {
    expect(planSignalEntry({ entry: 50.01, targets: [60], stop: 48 }, 50)).toMatchObject({
      ok: false,
      refusal: 'entry_is_buy_stop',
    });
  });

  it('refuses a zone wholly above the last close as a buy-stop', () => {
    expect(planSignalEntry({ entry: [51, 52], targets: [60], stop: 48 }, 50)).toMatchObject({
      ok: false,
      refusal: 'entry_is_buy_stop',
    });
  });

  it('refuses when the last close is at or below the stop', () => {
    for (const lastClose of [48, 47]) {
      expect(planSignalEntry({ entry: 50, targets: [60], stop: 48 }, lastClose)).toEqual({
        ok: false,
        refusal: 'last_close_at_or_below_stop',
        detail: `last close ${lastClose} is at or below the stop 48`,
      });
    }
  });
});
