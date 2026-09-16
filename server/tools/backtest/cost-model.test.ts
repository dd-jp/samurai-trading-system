import { CostModelImpl } from './cost-model.js';
import type { CostConfig, FillRequest, MarketState } from './types.js';

const PESSIMISTIC_CONFIG: CostConfig = {
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

// The most optimistic config a caller could configure: every coefficient at
// the smallest non-negative value. Should still charge a non-zero floor.
const OPTIMISTIC_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0,
    commissionRate: 0,
    slippageCoefficient: 0,
    impactK: 0,
  },
  stocks: {
    spreadVolatilityCoefficient: 0,
    commissionRate: 0,
    slippageCoefficient: 0,
    impactK: 0,
  },
};

function marketState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    mid: 100,
    spread: 0.2,
    adv: 10_000,
    volatility: 2,
    asset_class: 'crypto',
    timestamp: new Date('2026-07-15T00:00:00Z'),
    ...overrides,
  };
}

function fillRequest(overrides: Partial<FillRequest> = {}): FillRequest {
  return {
    instrument: 'BTC-USD',
    side: 'buy',
    size: 10,
    order_type: 'market',
    idempotency_key: 'test-key',
    ...overrides,
  };
}

describe('CostModelImpl.fill', () => {
  it('never fills a buy better than mid + half-spread', () => {
    const model = new CostModelImpl(PESSIMISTIC_CONFIG);
    const state = marketState({ spread: 1 });
    const result = model.fill(fillRequest({ side: 'buy' }), state);

    expect(result.fill_price).toBeGreaterThanOrEqual(state.mid + (state.spread ?? 0) / 2);
  });

  it('never fills a sell better than mid - half-spread', () => {
    const model = new CostModelImpl(PESSIMISTIC_CONFIG);
    const state = marketState({ spread: 1 });
    const result = model.fill(fillRequest({ side: 'sell' }), state);

    expect(result.fill_price).toBeLessThanOrEqual(state.mid - (state.spread ?? 0) / 2);
  });

  it('scales market impact by sqrt(size / adv)', () => {
    const model = new CostModelImpl(PESSIMISTIC_CONFIG);
    const state = marketState({ adv: 10_000 });

    const small = model.fill(fillRequest({ size: 10 }), state);
    const large = model.fill(fillRequest({ size: 40 }), state);

    const smallImpact = small.cost_breakdown.market_impact;
    const largeImpact = large.cost_breakdown.market_impact;

    // 4x size => sqrt(4) = 2x impact, not 4x (linear) or 1x (flat)
    expect(largeImpact / smallImpact).toBeCloseTo(2, 6);
  });

  it('charges a non-zero spread + commission floor even on the most optimistic config', () => {
    const model = new CostModelImpl(OPTIMISTIC_CONFIG);
    const state = marketState({ spread: 0 });
    const result = model.fill(fillRequest(), state);

    expect(result.cost_breakdown.spread_cost).toBeGreaterThan(0);
    expect(result.cost_breakdown.commission).toBeGreaterThan(0);
  });

  it('falls back to a volatility-derived spread when MarketState.spread is null', () => {
    const model = new CostModelImpl(PESSIMISTIC_CONFIG);
    const state = marketState({ spread: null, volatility: 3 });
    const result = model.fill(fillRequest(), state);

    const expectedFallback =
      (state.volatility * PESSIMISTIC_CONFIG.crypto.spreadVolatilityCoefficient) / 2;
    expect(result.cost_breakdown.spread_cost).toBeCloseTo(expectedFallback, 10);
  });

  it('sums cost_breakdown components consistently with the fill_price delta from mid (commission booked separately)', () => {
    const model = new CostModelImpl(PESSIMISTIC_CONFIG);
    const state = marketState();

    const buy = model.fill(fillRequest({ side: 'buy' }), state);
    const buyDelta = buy.fill_price - state.mid;
    const buySum =
      buy.cost_breakdown.spread_cost +
      buy.cost_breakdown.slippage +
      buy.cost_breakdown.market_impact;
    expect(buyDelta).toBeCloseTo(buySum, 10);

    const sell = model.fill(fillRequest({ side: 'sell' }), state);
    const sellDelta = state.mid - sell.fill_price;
    const sellSum =
      sell.cost_breakdown.spread_cost +
      sell.cost_breakdown.slippage +
      sell.cost_breakdown.market_impact;
    expect(sellDelta).toBeCloseTo(sellSum, 10);
  });

  it('throws when adv is not positive (no liquidity proxy to derive impact from)', () => {
    const model = new CostModelImpl(PESSIMISTIC_CONFIG);
    const state = marketState({ adv: 0 });

    expect(() => model.fill(fillRequest(), state)).toThrow();
  });
});

describe('CostModelImpl floors (#1000)', () => {
  it('charges the same amount whether floors is omitted or set to DEFAULT_COST_FLOORS', () => {
    // Regression pin: a config with no `floors` field must behave exactly as
    // the old hard-coded 1bp/1bp constants did — "nothing changes
    // behaviorally" per #1000's own framing
    const withoutFloors = new CostModelImpl(OPTIMISTIC_CONFIG);
    const withDefaultFloors = new CostModelImpl({
      ...OPTIMISTIC_CONFIG,
      floors: { minHalfSpreadRate: 0.0001, minCommissionRate: 0.0001 },
    });
    const state = marketState({ spread: 0 });

    const a = withoutFloors.fill(fillRequest(), state);
    const b = withDefaultFloors.fill(fillRequest(), state);

    expect(a.cost_breakdown.spread_cost).toBeCloseTo(b.cost_breakdown.spread_cost, 12);
    expect(a.cost_breakdown.commission).toBeCloseTo(b.cost_breakdown.commission, 12);
  });

  it('is calibration-addressable: a config can raise the floors above the default', () => {
    const model = new CostModelImpl({
      ...OPTIMISTIC_CONFIG,
      floors: { minHalfSpreadRate: 0.01, minCommissionRate: 0.02 },
    });
    const state = marketState({ spread: 0 });
    const result = model.fill(fillRequest(), state);

    expect(result.cost_breakdown.spread_cost).toBeCloseTo(state.mid * 0.01, 10);
    const notional = 10 * state.mid;
    expect(result.cost_breakdown.commission).toBeCloseTo(notional * 0.02, 10);
  });

  it('rejects a zero half-spread floor at construction (Principle 1: never representable)', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          floors: { minHalfSpreadRate: 0, minCommissionRate: 0.0001 },
        }),
    ).toThrow();
  });

  it('rejects a zero commission floor at construction (Principle 1: never representable)', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          floors: { minHalfSpreadRate: 0.0001, minCommissionRate: 0 },
        }),
    ).toThrow();
  });

  it('rejects a negative floor at construction', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          floors: { minHalfSpreadRate: -0.0001, minCommissionRate: 0.0001 },
        }),
    ).toThrow();
  });

  it('rejects a NaN floor at construction (Math.max(x, NaN) silently corrupts fill_price)', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          floors: { minHalfSpreadRate: NaN, minCommissionRate: 0.0001 },
        }),
    ).toThrow();
  });

  it('rejects a non-finite (Infinity) floor at construction', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          floors: { minHalfSpreadRate: 0.0001, minCommissionRate: Infinity },
        }),
    ).toThrow();
  });
});

describe('CostModelImpl venue keying (#1000)', () => {
  it('applies the plain asset-class commissionRate when marketState.venue is unset', () => {
    const config: CostConfig = {
      ...OPTIMISTIC_CONFIG,
      stocks: { ...OPTIMISTIC_CONFIG.stocks, commissionRate: 0.0005 },
      venues: { saxo: { commissionRate: 0.0008 } },
    };
    const model = new CostModelImpl(config);
    const state = marketState({ asset_class: 'stocks', spread: 1 });

    const result = model.fill(fillRequest(), state);

    const notional = 10 * state.mid;
    expect(result.cost_breakdown.commission).toBeCloseTo(notional * 0.0005, 10);
  });

  it('applies the venue-keyed commissionRate override when marketState.venue matches', () => {
    const config: CostConfig = {
      ...OPTIMISTIC_CONFIG,
      stocks: { ...OPTIMISTIC_CONFIG.stocks, commissionRate: 0.0005 },
      venues: { saxo: { commissionRate: 0.0008 } },
    };
    const model = new CostModelImpl(config);
    const state = marketState({ asset_class: 'stocks', spread: 1, venue: 'saxo' });

    const result = model.fill(fillRequest(), state);

    const notional = 10 * state.mid;
    expect(result.cost_breakdown.commission).toBeCloseTo(notional * 0.0008, 10);
  });

  it('leaves the venue override commission above the floor unmolested (Saxo real-world case)', () => {
    // ADR-0015:201: Saxo Classic is 8bps/side, no per-order minimum — well
    // above the 1bp structural floor, so the floor should never bind once
    // the rate is set
    const config: CostConfig = {
      ...OPTIMISTIC_CONFIG,
      stocks: { ...OPTIMISTIC_CONFIG.stocks, commissionRate: 0 },
      venues: { saxo: { commissionRate: 0.0008 } },
    };
    const model = new CostModelImpl(config);
    const state = marketState({ asset_class: 'stocks', spread: 1, venue: 'saxo' });

    const result = model.fill(fillRequest(), state);

    const notional = 10 * state.mid;
    expect(result.cost_breakdown.commission).toBeCloseTo(notional * 0.0008, 10);
    expect(result.cost_breakdown.commission).toBeGreaterThan(notional * 0.0001);
  });

  it('rejects a NaN venue override field at construction (Math.max(x, NaN) silently corrupts fill_price)', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          venues: { saxo: { commissionRate: NaN } },
        }),
    ).toThrow();
  });

  it('rejects a negative venue override field at construction', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          venues: { saxo: { commissionRate: -0.0001 } },
        }),
    ).toThrow();
  });

  it('rejects a non-finite (Infinity) venue override field at construction', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          venues: { saxo: { spreadVolatilityCoefficient: Infinity } },
        }),
    ).toThrow();
  });

  it('accepts a venue override field of exactly 0 (a legitimately zero rate, unlike a floor)', () => {
    expect(
      () =>
        new CostModelImpl({
          ...OPTIMISTIC_CONFIG,
          venues: { saxo: { commissionRate: 0 } },
        }),
    ).not.toThrow();
  });

  it('does not mutate other fields of the asset-class config when only commissionRate is overridden', () => {
    const config: CostConfig = {
      ...OPTIMISTIC_CONFIG,
      stocks: {
        spreadVolatilityCoefficient: 0.05,
        commissionRate: 0,
        slippageCoefficient: 0.02,
        impactK: 0.3,
      },
      venues: { saxo: { commissionRate: 0.0008 } },
    };
    const model = new CostModelImpl(config);
    const state = marketState({
      asset_class: 'stocks',
      spread: null,
      volatility: 2,
      venue: 'saxo',
    });

    const result = model.fill(fillRequest(), state);

    // slippage = volatility * slippageCoefficient, unaffected by the venue override
    expect(result.cost_breakdown.slippage).toBeCloseTo(2 * 0.02, 10);
  });
});
