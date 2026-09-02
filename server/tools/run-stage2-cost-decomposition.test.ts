import type { CostConfig } from './backtest/index.js';
import { scaleCostConfig } from './run-stage2-cost-decomposition.js';

const BASE: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.5,
    commissionRate: 0.001,
    slippageCoefficient: 0.2,
    impactK: 0.1,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.1,
    commissionRate: 0.0005,
    slippageCoefficient: 0.05,
    impactK: 0.05,
  },
};

describe('scaleCostConfig', () => {
  it('scales every coefficient of both asset classes by factor', () => {
    const scaled = scaleCostConfig(BASE, 0.5);

    expect(scaled.stocks.commissionRate).toBeCloseTo(0.00025, 10);
    expect(scaled.crypto.commissionRate).toBeCloseTo(0.0005, 10);
    expect(scaled.stocks.spreadVolatilityCoefficient).toBeCloseTo(0.05, 10);
  });

  it('leaves a config with no floors/venues fields unchanged in that respect', () => {
    const scaled = scaleCostConfig(BASE, 0.1);

    expect(scaled.floors).toBeUndefined();
    expect(scaled.venues).toBeUndefined();
  });

  // #1000: floors/venues are not "cost coefficients" this function scales —
  // dropping them would silently reset a caller's floor override or Saxo
  // rate back to the default at every rung of the sensitivity ladder.
  it('carries floors through UNSCALED rather than dropping them', () => {
    const withFloors: CostConfig = {
      ...BASE,
      floors: { minHalfSpreadRate: 0.002, minCommissionRate: 0.003 },
    };

    const scaled = scaleCostConfig(withFloors, 0.1);

    expect(scaled.floors).toEqual({ minHalfSpreadRate: 0.002, minCommissionRate: 0.003 });
  });

  it('carries venue overrides through UNSCALED rather than dropping them', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008 } },
    };

    const scaled = scaleCostConfig(withVenues, 0.05);

    expect(scaled.venues).toEqual({ saxo: { commissionRate: 0.0008 } });
  });

  // #1000 review finding: floors/venues must be copied, not aliased — a
  // caller mutating a scaled rung's floors/venues (e.g. the sensitivity
  // ladder in run-stage2-cost-decomposition.ts) must not reach back into the
  // input config it was scaled from.
  it('copies floors rather than aliasing the input config object', () => {
    const withFloors: CostConfig = {
      ...BASE,
      floors: { minHalfSpreadRate: 0.002, minCommissionRate: 0.003 },
    };

    const scaled = scaleCostConfig(withFloors, 0.1);

    expect(scaled.floors).not.toBe(withFloors.floors);
  });

  it('copies venues (and each per-venue override object) rather than aliasing the input config object', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008 } },
    };

    const scaled = scaleCostConfig(withVenues, 0.05);

    expect(scaled.venues).not.toBe(withVenues.venues);
    expect(scaled.venues?.saxo).not.toBe(withVenues.venues?.saxo);
  });
});
