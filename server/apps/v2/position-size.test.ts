import { describe, expect, it } from 'vitest';
import {
  MAX_POSITION_FRACTION_OF_EQUITY,
  positionSizeShares,
  STOP_ATR_MULTIPLE,
} from './position-size.js';

const base = {
  equityGbp: 1_000,
  riskFraction: 0.005,
  priceGbp: 10,
  atrGbp: 0.25,
  sizeMultiplier: 1,
  macroDay: false,
};

describe('positionSizeShares', () => {
  it('risks 0.5% of equity at a 2-ATR stop', () => {
    expect(STOP_ATR_MULTIPLE).toBe(2);
    expect(positionSizeShares(base)).toBe(10);
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
