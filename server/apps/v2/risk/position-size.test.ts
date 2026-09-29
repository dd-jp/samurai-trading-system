import { describe, expect, it } from 'vitest';
import {
  CFD_SHORT_GAP_BUDGET_FRACTION_OF_SLEEVE_LOSS_CAP,
  CFD_SHORT_GAP_FRACTION,
  MAX_POSITION_FRACTION_OF_EQUITY,
  positionSizeShares,
} from './position-size.js';

const base = {
  equityGbp: 1_000,
  riskFraction: 0.005,
  priceGbp: 10,
  atrGbp: 0.25,
  stopAtrMultiple: 2,
  sizeMultiplier: 1,
  macroDay: false,
  volumeCapShares: Number.POSITIVE_INFINITY,
};

describe('positionSizeShares', () => {
  it('risks 0.5% of equity at a 2-ATR stop', () => {
    expect(positionSizeShares(base)).toBe(10);
  });

  it('divides the risk budget by the sleeve stop multiple', () => {
    expect(positionSizeShares({ ...base, stopAtrMultiple: 4 })).toBe(5);
    expect(positionSizeShares({ ...base, stopAtrMultiple: 2.5 })).toBe(8);
  });

  it('caps notional at 10% of equity', () => {
    expect(MAX_POSITION_FRACTION_OF_EQUITY).toBe(0.1);
    expect(positionSizeShares({ ...base, atrGbp: 0.01 })).toBe(10);
    expect(positionSizeShares({ ...base, atrGbp: 0.01, priceGbp: 3 })).toBe(33);
  });

  it('halves on a macro day and scales by the loss-budget multiplier', () => {
    expect(positionSizeShares({ ...base, macroDay: true })).toBe(5);
    expect(positionSizeShares({ ...base, sizeMultiplier: 0.5 })).toBe(5);
    expect(positionSizeShares({ ...base, sizeMultiplier: 0.25, macroDay: true })).toBe(1);
    expect(positionSizeShares({ ...base, sizeMultiplier: 0.25, atrGbp: 0.7 })).toBe(0);
  });

  it('applies the macro halving to the notional cap as well as the risk budget', () => {
    expect(positionSizeShares({ ...base, atrGbp: 0.01, macroDay: true })).toBe(5);
    expect(positionSizeShares({ ...base, atrGbp: 0.01, sizeMultiplier: 0.5 })).toBe(5);
  });

  it('returns zero when halted or on degenerate inputs', () => {
    expect(positionSizeShares({ ...base, sizeMultiplier: 0 })).toBe(0);
    expect(positionSizeShares({ ...base, sizeMultiplier: -1 })).toBe(0);
    expect(positionSizeShares({ ...base, equityGbp: 0 })).toBe(0);
    expect(positionSizeShares({ ...base, equityGbp: -1_000 })).toBe(0);
    expect(positionSizeShares({ ...base, equityGbp: Number.NaN })).toBe(0);
    expect(positionSizeShares({ ...base, priceGbp: 0 })).toBe(0);
    expect(positionSizeShares({ ...base, priceGbp: -10 })).toBe(0);
    expect(positionSizeShares({ ...base, atrGbp: 0 })).toBe(0);
    expect(positionSizeShares({ ...base, atrGbp: -1 })).toBe(0);
    expect(positionSizeShares({ ...base, atrGbp: Number.NaN })).toBe(0);
  });

  it('scales the risk budget by the injected risk fraction', () => {
    expect(positionSizeShares({ ...base, riskFraction: 0.0025 })).toBe(5);
    expect(positionSizeShares({ ...base, riskFraction: 0.01 })).toBe(10);
    expect(positionSizeShares({ ...base, riskFraction: 0 })).toBe(0);
  });
});

describe('positionSizeShares CFD short gap bound', () => {
  const roomy = { ...base, equityGbp: 10_000, priceGbp: 10 };

  it('carries the ruled +30% gap and a 10% of sleeve loss cap budget', () => {
    expect(CFD_SHORT_GAP_FRACTION).toBe(0.3);
    expect(CFD_SHORT_GAP_BUDGET_FRACTION_OF_SLEEVE_LOSS_CAP).toBe(0.1);
  });

  it('leaves the size alone when no gap budget applies', () => {
    expect(positionSizeShares(roomy)).toBe(100);
    expect(positionSizeShares({ ...roomy, gapBudgetGbp: undefined })).toBe(100);
  });

  it('caps shares so a +30% gap costs at most the budget', () => {
    expect(positionSizeShares({ ...roomy, gapBudgetGbp: 45 })).toBe(15);
    expect(15 * 10 * CFD_SHORT_GAP_FRACTION).toBeCloseTo(45, 9);
  });

  it('drops a share the moment the price would push the gap loss over the budget', () => {
    expect(positionSizeShares({ ...roomy, priceGbp: 10, gapBudgetGbp: 45 })).toBe(15);
    expect(positionSizeShares({ ...roomy, priceGbp: 10.01, gapBudgetGbp: 45 })).toBe(14);
    expect(positionSizeShares({ ...roomy, priceGbp: 150, gapBudgetGbp: 45 })).toBe(1);
    expect(positionSizeShares({ ...roomy, priceGbp: 150.01, gapBudgetGbp: 45 })).toBe(0);
  });

  it('never raises a size the fixed-risk or notional rules already made smaller', () => {
    expect(positionSizeShares({ ...roomy, gapBudgetGbp: 4_500 })).toBe(100);
    expect(positionSizeShares({ ...base, gapBudgetGbp: 4_500 })).toBe(10);
  });

  it('is zero on a zero or negative budget', () => {
    expect(positionSizeShares({ ...roomy, gapBudgetGbp: 0 })).toBe(0);
    expect(positionSizeShares({ ...roomy, gapBudgetGbp: -45 })).toBe(0);
  });
});
