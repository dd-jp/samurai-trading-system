import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OrderIntent } from '../shared/types.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PortfolioView,
  RiskConfig,
  RiskDecision,
  RiskInput,
} from './types.js';

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'AAPL-2026-07-15T09:30:00Z',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 190,
    stop: 185,
    target: 200,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T09:30:00Z'),
    metadata: {
      debate_id: 'debate-abc123',
      conviction: 0.72,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1.2,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: {
        neighbor_count: 5,
        weighted_mean_r: 0.4,
        no_precedent: false,
      },
    },
    ...overrides,
  };
}

describe('PortfolioView', () => {
  it('matches the accounting-view shape', () => {
    const view: PortfolioView = {
      equity: 100_000,
      peak_equity: 110_000,
      drawdown_pct: 0.0909,
      exposure_by_instrument: { AAPL: 19_000 },
      exposure_by_class: { crypto: 0, stocks: 19_000 },
      gross_exposure: 19_000,
      daily_pnl_pct: -0.01,
      consecutive_losses: 1,
    };

    expectTypeOf(view).toMatchTypeOf<PortfolioView>();
  });
});

describe('BreakerState', () => {
  it('matches the tiered trip-state shape', () => {
    const breakers: BreakerState = {
      portfolio_tripped: false,
      asset_class_tripped: { crypto: false, stocks: false },
      armed_breakers: [],
    };

    expectTypeOf(breakers).toMatchTypeOf<BreakerState>();
  });
});

describe('RiskConfig', () => {
  it('matches the config-driven threshold shape', () => {
    const config: RiskConfig = {
      max_position_size: 20_000,
      per_asset_cap: 25_000,
      per_asset_class_cap: { crypto: 40_000, stocks: 60_000 },
      portfolio_gross_cap: 90_000,
      concentration: { cap: 30_000, threshold: 0.7 },
      min_viable_size: 500,
    };

    expectTypeOf(config).toMatchTypeOf<RiskConfig>();
  });
});

describe('CorrelationEstimate', () => {
  it('matches the pairwise-correlation shape, keyed by the other instrument', () => {
    const estimate: CorrelationEstimate = {
      correlations: { MSFT: 0.82, 'BTC-USD': -0.05 },
    };

    expectTypeOf(estimate).toMatchTypeOf<CorrelationEstimate>();
  });
});

describe('RiskInput', () => {
  it('matches the evaluate() seam input shape', () => {
    const input: RiskInput = {
      trace_id: 'trace-1',
      intent: makeIntent(),
      clock: { now: () => new Date('2026-07-15T09:30:00Z') },
      portfolio: {
        equity: 100_000,
        peak_equity: 100_000,
        drawdown_pct: 0,
        exposure_by_instrument: {},
        exposure_by_class: { crypto: 0, stocks: 0 },
        gross_exposure: 0,
        daily_pnl_pct: 0,
        consecutive_losses: 0,
      },
      breakers: {
        portfolio_tripped: false,
        asset_class_tripped: { crypto: false, stocks: false },
        armed_breakers: [],
      },
      correlation: { correlations: {} },
      mode: 'live',
    };

    expectTypeOf(input).toMatchTypeOf<RiskInput>();
  });
});

describe('RiskDecision', () => {
  it('allows an approved decision with modifications present', () => {
    const decision: RiskDecision = {
      status: 'approved',
      order_intent: makeIntent({ size: 80 }),
      modifications: { original_size: 100, final_size: 80, stop_tightened: false },
      binding_constraint: 'per_trade_size_cap',
      reasons: ['per_trade_size_cap: trimmed to max_position_size'],
      risk_snapshot: {
        exposure: { AAPL: 15_200, stocks: 15_200, portfolio: 15_200 },
        drawdown_pct: 0,
        armed_breakers: [],
      },
    };

    expectTypeOf(decision).toMatchTypeOf<RiskDecision>();
    expect(decision.order_intent).not.toBeNull();
  });

  it('allows a rejected decision with a null order_intent and modifications', () => {
    const decision: RiskDecision = {
      status: 'rejected',
      order_intent: null,
      modifications: null,
      binding_constraint: 'min_viable_size',
      reasons: ['min_viable_size: trimmed size below viable minimum'],
      risk_snapshot: {
        exposure: {},
        drawdown_pct: 0,
        armed_breakers: [],
      },
    };

    expectTypeOf(decision).toMatchTypeOf<RiskDecision>();
    expect(decision.order_intent).toBeNull();
  });
});
