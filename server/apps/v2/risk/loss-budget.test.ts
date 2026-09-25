import { describe, expect, it } from 'vitest';
import type { CapitalYear } from '../../../../contracts/index.js';
import { dailyCapBreached, LossBudget, sizeMultiplierFor } from './loss-budget.js';

const capital: CapitalYear = {
  year: 2026,
  effectiveFrom: '2026-01-01',
  startCapitalGbp: 2_000,
  lossCapGbp: 1_500,
};

describe('sizeMultiplierFor', () => {
  it('steps at a third, two thirds and the whole cap', () => {
    expect(sizeMultiplierFor(-50, 1_500)).toBe(1);
    expect(sizeMultiplierFor(499.99, 1_500)).toBe(1);
    expect(sizeMultiplierFor(500, 1_500)).toBe(0.5);
    expect(sizeMultiplierFor(999.99, 1_500)).toBe(0.5);
    expect(sizeMultiplierFor(1_000, 1_500)).toBe(0.25);
    expect(sizeMultiplierFor(1_499.99, 1_500)).toBe(0.25);
    expect(sizeMultiplierFor(1_500, 1_500)).toBe(0);
    expect(sizeMultiplierFor(299.99, 900)).toBe(1);
    expect(sizeMultiplierFor(300, 900)).toBe(0.5);
    expect(sizeMultiplierFor(600, 900)).toBe(0.25);
    expect(sizeMultiplierFor(900, 900)).toBe(0);
  });
});

describe('dailyCapBreached', () => {
  it('breaches at exactly 1% of the year start capital', () => {
    expect(dailyCapBreached(19.99, capital)).toBe(false);
    expect(dailyCapBreached(20, capital)).toBe(true);
    expect(dailyCapBreached(10, { ...capital, startCapitalGbp: 1_000 })).toBe(true);
  });
});

describe('LossBudget', () => {
  it('refuses a non-positive start capital', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => new LossBudget(bad)).toThrow(/start capital must be > 0/);
    }
  });

  it('reports the loss against the reference and blocks next entries on a daily breach', () => {
    const budget = new LossBudget(2_000);
    expect(budget.referenceEquityGbp).toBe(2_000);
    expect(budget.markClose(1_990, 2_000, capital)).toEqual({
      referenceEquityGbp: 2_000,
      ytdLossGbp: 10,
      sizeMultiplier: 1,
      halted: false,
      entriesBlockedAtNextFill: false,
    });
    expect(budget.markClose(1_970, 1_990, capital)).toMatchObject({
      ytdLossGbp: 30,
      entriesBlockedAtNextFill: true,
    });
    expect(budget.markClose(1_500, 1_500, capital)).toMatchObject({
      sizeMultiplier: 0.5,
      entriesBlockedAtNextFill: false,
    });
  });

  it('halts at the cap and stays halted after a recovery until the year resets', () => {
    const budget = new LossBudget(2_000);
    expect(budget.markClose(500, 500, capital)).toMatchObject({
      sizeMultiplier: 0,
      halted: true,
      entriesBlockedAtNextFill: true,
    });
    expect(budget.markClose(2_100, 500, capital)).toMatchObject({
      ytdLossGbp: -100,
      sizeMultiplier: 0,
      halted: true,
      entriesBlockedAtNextFill: true,
    });
    budget.resetYear(2_100);
    expect(budget.referenceEquityGbp).toBe(2_100);
    expect(budget.markClose(2_100, 2_100, capital)).toMatchObject({
      ytdLossGbp: 0,
      sizeMultiplier: 1,
      halted: false,
      entriesBlockedAtNextFill: false,
    });
  });

  it('steps against whichever cap it is handed for the day', () => {
    const budget = new LossBudget(2_000);
    expect(budget.markClose(1_600, 1_600, capital).sizeMultiplier).toBe(1);
    expect(budget.markClose(1_600, 1_600, { ...capital, lossCapGbp: 900 }).sizeMultiplier).toBe(
      0.5,
    );
  });
});
