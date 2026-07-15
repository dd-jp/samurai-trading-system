import { describe, expect, it } from 'vitest';
import { CostModelImpl } from './cost-model.js';
import type { CostConfig, FillRequest, MarketState } from './types.js';

const PESSIMISTIC_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.5,
    commissionRate: 0.001, // 10 bps taker
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
    const large = model.fill(fillRequest({ size: 40 }), state); // 4x size

    const smallImpact = small.cost_breakdown.market_impact;
    const largeImpact = large.cost_breakdown.market_impact;

    // 4x size => sqrt(4) = 2x impact, not 4x (linear) or 1x (flat).
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
