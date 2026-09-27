import { describe, expect, it } from 'vitest';
import type { CapitalYear, SleeveSpec } from '../../../../contracts/index.js';
import { DEBATE_SLEEVE_SPEC } from '../signal/index.js';
import { assertCapitalShares, sleeveAllocationGbp, sleeveCapitalYear } from './allocation.js';
import { dailyCapGbp, sizeStepMarksGbp } from './loss-budget.js';

const year: CapitalYear = {
  year: 2026,
  effectiveFrom: '2026-01-01',
  startCapitalGbp: 2_000,
  lossCapGbp: 1_500,
};

function spec(overrides: Partial<SleeveSpec> = {}): SleeveSpec {
  return { ...DEBATE_SLEEVE_SPEC, ...overrides };
}

function sleeve(id: string, capitalShare: number) {
  return { id, spec: spec({ capitalShare }) };
}

describe('sleeve capital share', () => {
  it('gives the debate sleeve 30% of capital, of the loss cap and of the daily cap', () => {
    const debate = sleeveCapitalYear(DEBATE_SLEEVE_SPEC, year);
    expect(debate).toEqual({ ...year, startCapitalGbp: 600, lossCapGbp: 450 });
    expect(sizeStepMarksGbp(debate.lossCapGbp)).toEqual([150, 300, 450]);
    expect(dailyCapGbp(debate)).toBe(6);
    expect(sleeveAllocationGbp(DEBATE_SLEEVE_SPEC, year)).toBe(600);
  });

  it('allocates the share, capped at capacity, and nothing below the minimum', () => {
    expect(sleeveAllocationGbp(spec({ capitalShare: 0.7 }), year)).toBe(1_400);
    expect(sleeveAllocationGbp(spec({ capitalShare: 0.7, capacityGbp: 1_000 }), year)).toBe(1_000);
    expect(sleeveAllocationGbp(spec({ capitalShare: 0.7, minimumCapitalGbp: 1_400 }), year)).toBe(
      1_400,
    );
    expect(sleeveAllocationGbp(spec({ capitalShare: 0.7, minimumCapitalGbp: 1_401 }), year)).toBe(
      0,
    );
  });

  it('never lets the sleeves together hold more capital or cap than the account', () => {
    const sleeves = [sleeve('debate', 0.3), sleeve('trend', 0.35), sleeve('reversion', 0.35)];
    assertCapitalShares(sleeves);
    const scaled = sleeves.map(({ spec: declared }) => sleeveCapitalYear(declared, year));
    const total = (pick: (capital: CapitalYear) => number) =>
      scaled.reduce((sum, capital) => sum + pick(capital), 0);
    expect(total((capital) => capital.startCapitalGbp)).toBeCloseTo(year.startCapitalGbp, 9);
    expect(total((capital) => capital.lossCapGbp)).toBeCloseTo(year.lossCapGbp, 9);
    expect(total(dailyCapGbp)).toBeCloseTo(dailyCapGbp(year), 9);
  });

  it('refuses shares that overrun the account or fall outside (0, 1]', () => {
    expect(() => assertCapitalShares([sleeve('debate', 0.3), sleeve('trend', 0.7)])).not.toThrow();
    expect(() => assertCapitalShares([sleeve('debate', 0.3), sleeve('trend', 0.71)])).toThrow(
      /sleeves declare 1\.01 of the account, more than 1/,
    );
    for (const share of [0, -0.1, 1.01, Number.NaN]) {
      expect(() => assertCapitalShares([sleeve('bad', share)])).toThrow(
        `capital share: sleeve 'bad' declares ${share}, outside (0, 1]`,
      );
    }
    expect(() => assertCapitalShares([sleeve('whole', 1)])).not.toThrow();
  });
});
