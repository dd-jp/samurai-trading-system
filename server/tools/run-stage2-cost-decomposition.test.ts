import type { CostConfig, MarketState } from './backtest/index.js';
import { CostModelImpl } from './backtest/index.js';
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

  // #1017: `venues[*]` rate fields are cost coefficients (the same kind of
  // fact as `stocks.commissionRate`/`crypto.commissionRate`), unlike
  // `floors`, and must be scaled the same way — carrying them through
  // unscaled silently under-measures cost sensitivity the moment a
  // Saxo-keyed config reaches the ladder (`PESSIMISTIC_COST_CONFIG` sets no
  // `venues` today, so this was inert, not yet observable, before #1017).
  it('scales every present rate field of each venue override by factor (#1017)', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008, impactK: 0.02 } },
    };

    const scaled = scaleCostConfig(withVenues, 0.05);

    expect(scaled.venues?.saxo?.commissionRate).toBeCloseTo(0.00004, 10);
    expect(scaled.venues?.saxo?.impactK).toBeCloseTo(0.001, 10);
  });

  it('leaves a venue override field unset when the input did not set it', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008 } },
    };

    const scaled = scaleCostConfig(withVenues, 0.05);

    expect(scaled.venues?.saxo).toEqual({ commissionRate: 0.00004 });
    expect('spreadVolatilityCoefficient' in (scaled.venues?.saxo ?? {})).toBe(false);
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

  // #1032 item 2: the #1017 tests above check the scaled CONFIG object. None
  // of them would have caught `venues` being inert end to end, because no
  // `MarketState` in the codebase carried `venue`. This one prices a fill
  // through `CostModelImpl` against a venue-stamped state, so the scaled
  // Saxo rate must show up in the charged commission — not just in the
  // config it was copied into.
  it('charges the SCALED Saxo rate on a venue-stamped fill (end to end)', () => {
    const withVenues: CostConfig = {
      ...BASE,
      venues: { saxo: { commissionRate: 0.0008 } },
    };
    const state: MarketState = {
      mid: 100,
      spread: 0.02,
      adv: 1_000_000,
      volatility: 1,
      asset_class: 'stocks',
      venue: 'saxo',
      timestamp: new Date('2026-09-05T10:00:00Z'),
    };
    const request = {
      instrument: '3USL',
      side: 'buy' as const,
      size: 10,
      order_type: 'market' as const,
      idempotency_key: 'k',
    };

    const full = new CostModelImpl(withVenues).fill(request, state);
    const half = new CostModelImpl(scaleCostConfig(withVenues, 0.5)).fill(request, state);
    const { venue: _venue, ...unstamped } = state;
    const unkeyed = new CostModelImpl(withVenues).fill(request, unstamped);

    // Notional 1,000: 8bps -> 0.8, halved -> 0.4, base stocks 5bps -> 0.5.
    expect(full.cost_breakdown.commission).toBeCloseTo(0.8, 10);
    expect(half.cost_breakdown.commission).toBeCloseTo(0.4, 10);
    expect(unkeyed.cost_breakdown.commission).toBeCloseTo(0.5, 10);
  });
});
