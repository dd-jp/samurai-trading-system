import type { OrderIntent } from '../../shared/index.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PersistedBreakerState,
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
    decided_at: new Date('2026-07-15T09:30:00Z'),
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
      reserved_exposure_by_instrument: {},
      reserved_exposure_by_class: { crypto: 0, stocks: 0 },
      reserved_gross_exposure: 0,
      daily_pnl: {
        crypto: { known: true, pct: -0.01 },
        stocks: { known: true, pct: -0.01 },
        portfolio: { known: true, pct: -0.01 },
      },
      consecutive_losses: 1,
      unvalued_instruments: [],
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

describe('PersistedBreakerState', () => {
  it('matches the crash-restart-safe, one-row-per-tier shape (#203)', () => {
    const rows: PersistedBreakerState[] = [
      {
        tier: 'portfolio_drawdown',
        tripped: true,
        tripped_at: new Date('2026-07-10T00:00:00Z'),
        reset_at: null,
        reason: 'portfolio_drawdown_hard',
      },
      {
        tier: 'kill_switch',
        tripped: false,
        tripped_at: null,
        reset_at: null,
        reason: null,
      },
    ];

    expectTypeOf(rows).toMatchTypeOf<PersistedBreakerState[]>();
  });
});

describe('RiskConfig', () => {
  it('matches the config-driven threshold shape', () => {
    const config: RiskConfig = {
      max_position_size_fraction_of_equity: 20_000,
      per_asset_cap_fraction_of_equity: 25_000,
      per_asset_class_cap_fraction_of_equity: { crypto: 40_000, stocks: 60_000 },
      portfolio_gross_cap_fraction_of_equity: 90_000,
      concentration: { cap_fraction_of_equity: 30_000, threshold: 0.7 },
      min_viable_size: 500,
      whole_share_sizing: false,
      cii_threshold: 70,
      max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    };

    expectTypeOf(config).toMatchTypeOf<RiskConfig>();
  });
});

describe('CorrelationEstimate', () => {
  it('matches the pairwise-correlation shape, keyed by the other instrument', () => {
    const estimate: CorrelationEstimate = {
      correlations: { MSFT: 0.82, 'BTC-USD': -0.05 },
      insufficient_history: [],
    };

    expectTypeOf(estimate).toMatchTypeOf<CorrelationEstimate>();
  });

  it('carries under-min_bars pairs in insufficient_history, separate from correlations', () => {
    const estimate: CorrelationEstimate = {
      correlations: { MSFT: 0.82 },
      insufficient_history: ['ETH-USD'],
    };

    expectTypeOf(estimate).toMatchTypeOf<CorrelationEstimate>();
    expect(estimate.correlations['ETH-USD']).toBeUndefined();
    expect(estimate.insufficient_history).toContain('ETH-USD');
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
        reserved_exposure_by_instrument: {},
        reserved_exposure_by_class: { crypto: 0, stocks: 0 },
        reserved_gross_exposure: 0,
        daily_pnl: {
          crypto: { known: true, pct: 0 },
          stocks: { known: true, pct: 0 },
          portfolio: { known: true, pct: 0 },
        },
        consecutive_losses: 0,
        unvalued_instruments: [],
      },
      breakers: {
        portfolio_tripped: false,
        asset_class_tripped: { crypto: false, stocks: false },
        armed_breakers: [],
      },
      next_breaker_state: [
        {
          tier: 'portfolio_drawdown',
          tripped: false,
          tripped_at: null,
          reset_at: null,
          reason: null,
        },
        { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
      ],
      correlation: { correlations: {}, insufficient_history: [] },
      cii: {},
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
      warnings: [],
      risk_snapshot: {
        exposure: { AAPL: 15_200, stocks: 15_200, portfolio: 15_200 },
        drawdown_pct: 0,
        armed_breakers: [],
      },
      next_breaker_state: [
        {
          tier: 'portfolio_drawdown',
          tripped: false,
          tripped_at: null,
          reset_at: null,
          reason: null,
        },
        { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
      ],
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
      warnings: [],
      risk_snapshot: {
        exposure: {},
        drawdown_pct: 0,
        armed_breakers: [],
      },
      next_breaker_state: [
        {
          tier: 'portfolio_drawdown',
          tripped: true,
          tripped_at: new Date('2026-07-10T00:00:00Z'),
          reset_at: null,
          reason: 'portfolio_drawdown_hard',
        },
        { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
      ],
    };

    expectTypeOf(decision).toMatchTypeOf<RiskDecision>();
    expect(decision.order_intent).toBeNull();
  });
});
