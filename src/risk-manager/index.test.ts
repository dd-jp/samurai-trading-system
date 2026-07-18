import { describe, expect, it } from 'vitest';
import type { Clock } from '../shared/clock.js';
import type { OrderIntent } from '../shared/types.js';
import { RiskManagerImpl } from './index.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PortfolioView,
  RiskConfig,
  RiskInput,
} from './types.js';

const fixedClock: Clock = { now: () => new Date('2026-07-15T09:30:00Z') };

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'AAPL-2026-07-15T09:30:00Z',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
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

function makePortfolio(overrides: Partial<PortfolioView> = {}): PortfolioView {
  return {
    equity: 100_000,
    peak_equity: 100_000,
    drawdown_pct: 0,
    exposure_by_instrument: {},
    exposure_by_class: { crypto: 0, stocks: 0 },
    gross_exposure: 0,
    daily_pnl_pct: 0,
    consecutive_losses: 0,
    ...overrides,
  };
}

function makeBreakers(overrides: Partial<BreakerState> = {}): BreakerState {
  return {
    portfolio_tripped: false,
    asset_class_tripped: { crypto: false, stocks: false },
    armed_breakers: [],
    ...overrides,
  };
}

function makeCorrelation(overrides: Partial<CorrelationEstimate> = {}): CorrelationEstimate {
  return {
    correlations: {},
    ...overrides,
  };
}

// Caps set high enough by default that no step trims unless a test lowers one.
function makeConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    max_position_size: 1_000_000,
    per_asset_cap: 1_000_000,
    per_asset_class_cap: { crypto: 1_000_000, stocks: 1_000_000 },
    portfolio_gross_cap: 1_000_000,
    concentration: { cap: 1_000_000, threshold: 0.7 },
    min_viable_size: 100,
    ...overrides,
  };
}

function makeInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    trace_id: 'trace-1',
    intent: makeIntent(),
    clock: fixedClock,
    portfolio: makePortfolio(),
    breakers: makeBreakers(),
    correlation: makeCorrelation(),
    mode: 'live',
    ...overrides,
  };
}

describe('RiskManagerImpl.evaluate — exits', () => {
  it('passes an exit through verbatim, bypassing every gate', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ max_position_size: 1, min_viable_size: 1_000_000 }),
    );
    const input = makeInput({
      intent: makeIntent({ intent_type: 'exit', size: 100 }),
      breakers: makeBreakers({ portfolio_tripped: true }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent).toEqual(input.intent);
    expect(decision.modifications).toEqual({
      original_size: 100,
      final_size: 100,
      stop_tightened: false,
    });
    expect(decision.binding_constraint).toBeNull();
  });
});

describe('RiskManagerImpl.evaluate — circuit-breaker gate', () => {
  it('hard-rejects a new entry when the portfolio breaker is tripped', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({ breakers: makeBreakers({ portfolio_tripped: true }) });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.order_intent).toBeNull();
    expect(decision.modifications).toBeNull();
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });

  it('hard-rejects a new entry when the relevant asset-class breaker is tripped', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ asset_class: 'stocks' }),
      breakers: makeBreakers({ asset_class_tripped: { crypto: false, stocks: true } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('circuit_breaker:stocks');
  });

  it('does not trip on an unrelated asset-class breaker', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ asset_class: 'stocks' }),
      breakers: makeBreakers({ asset_class_tripped: { crypto: true, stocks: false } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
  });
});

describe('RiskManagerImpl.evaluate — trim steps', () => {
  it('trims to the per-trade size cap', () => {
    const manager = new RiskManagerImpl(makeConfig({ max_position_size: 5_000 }));
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) }); // notional 10,000

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(50); // 5,000 / 100
    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.modifications).toEqual({
      original_size: 100,
      final_size: 50,
      stop_tightened: false,
    });
  });

  it('trims to the per-asset exposure cap, accounting for existing exposure', () => {
    const manager = new RiskManagerImpl(makeConfig({ per_asset_cap: 12_000 }));
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100 }), // notional 10,000
      portfolio: makePortfolio({ exposure_by_instrument: { AAPL: 5_000 } }),
    });

    const decision = manager.evaluate(input);

    // Allowed additional = 12,000 - 5,000 = 7,000 -> size 70
    expect(decision.order_intent?.size).toBe(70);
    expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
  });

  it('trims to the per-asset-class exposure cap', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ per_asset_class_cap: { crypto: 1_000_000, stocks: 8_000 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, asset_class: 'stocks' }),
      portfolio: makePortfolio({ exposure_by_class: { crypto: 0, stocks: 3_000 } }),
    });

    const decision = manager.evaluate(input);

    // Allowed additional = 8,000 - 3,000 = 5,000 -> size 50
    expect(decision.order_intent?.size).toBe(50);
    expect(decision.binding_constraint).toBe('per_asset_class_exposure_cap');
  });

  it('trims to the portfolio gross exposure cap', () => {
    const manager = new RiskManagerImpl(makeConfig({ portfolio_gross_cap: 6_000 }));
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100 }),
      portfolio: makePortfolio({ gross_exposure: 2_000 }),
    });

    const decision = manager.evaluate(input);

    // Allowed additional = 6,000 - 2,000 = 4,000 -> size 40
    expect(decision.order_intent?.size).toBe(40);
    expect(decision.binding_constraint).toBe('portfolio_gross_exposure_cap');
  });

  it('trims to the concentration cap when the instrument is correlated with a held one', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap: 9_000, threshold: 0.7 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      correlation: makeCorrelation({ correlations: { MSFT: 0.82 } }),
    });

    const decision = manager.evaluate(input);

    // Allowed additional = 9,000 - 4,000 (existing MSFT, AAPL has none) = 5,000 -> size 50
    expect(decision.order_intent?.size).toBe(50);
    expect(decision.binding_constraint).toBe('concentration_correlation_cap');
  });

  it('does not trim on a held instrument whose correlation is below the threshold', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap: 9_000, threshold: 0.7 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      correlation: makeCorrelation({ correlations: { MSFT: 0.3 } }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(100);
    expect(decision.binding_constraint).toBeNull();
  });

  it('falls back gracefully (no trim) when correlation history is insufficient (warm-up)', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap: 9_000, threshold: 0.7 } }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      // MSFT omitted entirely — insufficient overlapping return history.
      correlation: makeCorrelation({ correlations: {} }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(100);
    expect(decision.binding_constraint).toBeNull();
  });

  it('never trims below zero when existing exposure already exceeds a cap', () => {
    const manager = new RiskManagerImpl(makeConfig({ per_asset_cap: 1_000, min_viable_size: 100 }));
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100 }),
      portfolio: makePortfolio({ exposure_by_instrument: { AAPL: 5_000 } }),
    });

    const decision = manager.evaluate(input);

    // Allowed additional is negative, floored at 0 notional -> rejected as dust, never a negative size.
    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('min_viable_size');
  });
});

describe('RiskManagerImpl.evaluate — ordering and monotonicity', () => {
  it('applies checks in documented order — an earlier, tighter cap wins over a later one', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ max_position_size: 3_000, per_asset_cap: 999_999 }),
    );
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) });

    const decision = manager.evaluate(input);

    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.order_intent?.size).toBe(30);
  });

  it('never increases size relative to the original intent', () => {
    const manager = new RiskManagerImpl(makeConfig({ max_position_size: 50_000 }));
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) });

    const decision = manager.evaluate(input);

    expect(decision.order_intent?.size).toBeLessThanOrEqual(100);
  });
});

describe('RiskManagerImpl.evaluate — min-viable-size re-check', () => {
  it('rejects with min_viable_size when a mid-pipeline trim pushes size below viable', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ per_asset_class_cap: { crypto: 1_000_000, stocks: 50 }, min_viable_size: 100 }),
    );
    const input = makeInput({
      intent: makeIntent({ size: 100, entry: 100, asset_class: 'stocks' }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.order_intent).toBeNull();
    expect(decision.modifications).toBeNull();
    expect(decision.binding_constraint).toBe('min_viable_size');
    expect(decision.reasons.some((r) => r.startsWith('min_viable_size'))).toBe(true);
  });

  it('approves when the trimmed size stays at or above the viable minimum', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ max_position_size: 200, min_viable_size: 100 }),
    );
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 1 }) });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
  });
});

describe('RiskManagerImpl.evaluate — audit fields', () => {
  it('attaches reason codes to every reject and modify', () => {
    const manager = new RiskManagerImpl(makeConfig({ max_position_size: 5_000 }));
    const input = makeInput({ intent: makeIntent({ size: 100, entry: 100 }) });

    const decision = manager.evaluate(input);

    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons[0]).toContain('per_trade_size_cap');
  });

  it('includes a risk_snapshot with exposure, drawdown, and armed breakers', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      portfolio: makePortfolio({
        exposure_by_instrument: { AAPL: 1_000 },
        exposure_by_class: { crypto: 0, stocks: 1_000 },
        gross_exposure: 1_000,
        drawdown_pct: 0.05,
      }),
      breakers: makeBreakers({ armed_breakers: ['crypto_daily_loss_soft'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.risk_snapshot.exposure.AAPL).toBe(1_000);
    expect(decision.risk_snapshot.exposure.stocks).toBe(1_000);
    expect(decision.risk_snapshot.exposure.portfolio).toBe(1_000);
    expect(decision.risk_snapshot.drawdown_pct).toBe(0.05);
    expect(decision.risk_snapshot.armed_breakers).toEqual(['crypto_daily_loss_soft']);
  });
});
