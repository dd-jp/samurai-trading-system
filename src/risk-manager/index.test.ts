import type { Clock, OrderIntent } from '../shared/index.js';
import { CircuitBreakers } from './breakers.js';
import { RiskManagerImpl } from './index.js';
import type {
  BreakerState,
  CorrelationEstimate,
  PersistedBreakerState,
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
    daily_pnl: {
      crypto: { known: true, pct: 0 },
      stocks: { known: true, pct: 0 },
      portfolio: { known: true, pct: 0 },
    },
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
    insufficient_history: [],
    ...overrides,
  };
}

function makePersistedBreakerState(): PersistedBreakerState[] {
  return [
    { tier: 'portfolio_drawdown', tripped: false, tripped_at: null, reset_at: null, reason: null },
    { tier: 'kill_switch', tripped: false, tripped_at: null, reset_at: null, reason: null },
  ];
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
    cii_threshold: 70,
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
    next_breaker_state: makePersistedBreakerState(),
    correlation: makeCorrelation(),
    cii: {},
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

describe('RiskManagerImpl.evaluate — next_breaker_state pass-through (#203)', () => {
  it('echoes RiskInput.next_breaker_state onto RiskDecision unchanged on an approved entry', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const persisted = [
      {
        tier: 'portfolio_drawdown' as const,
        tripped: true,
        tripped_at: new Date('2026-07-10T00:00:00Z'),
        reset_at: null,
        reason: 'portfolio_drawdown_hard',
      },
      {
        tier: 'kill_switch' as const,
        tripped: false,
        tripped_at: null,
        reset_at: null,
        reason: null,
      },
    ];
    const input = makeInput({ next_breaker_state: persisted });

    const decision = manager.evaluate(input);

    expect(decision.next_breaker_state).toBe(persisted);
  });

  it('echoes next_breaker_state on a rejected entry (circuit-breaker gate)', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const persisted = makePersistedBreakerState();
    const input = makeInput({
      breakers: makeBreakers({ portfolio_tripped: true }),
      next_breaker_state: persisted,
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.next_breaker_state).toBe(persisted);
  });

  it('echoes next_breaker_state on an exit', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const persisted = makePersistedBreakerState();
    const input = makeInput({
      intent: makeIntent({ intent_type: 'exit' }),
      next_breaker_state: persisted,
    });

    const decision = manager.evaluate(input);

    expect(decision.next_breaker_state).toBe(persisted);
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

  it('blocks a new entry on an unknown daily figure, but still lets the exit out (#333)', () => {
    // The end-to-end shape of decision 5, through the real `CircuitBreakers`
    // rather than a hand-set `BreakerState`: an unknown daily figure has to
    // stop new risk without trapping the account in what it already holds.
    const unknown = { known: false, reason: 'no session-open equity observed' } as const;
    const breakers = new CircuitBreakers({
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 4,
      volatility: { baseline: { crypto: 2, stocks: 1 }, multiplier: 2 },
      auto_rearm: { recovery_drawdown_pct: 0.1, max_days_tripped: 5 },
    }).evaluate({
      portfolio: makePortfolio({
        daily_pnl: { crypto: unknown, stocks: unknown, portfolio: unknown },
      }),
      volatility: { crypto: 1, stocks: 0.5 },
      mode: 'live',
      clock: { now: () => new Date('2026-07-15T09:30:00Z') },
    });

    const manager = new RiskManagerImpl(makeConfig());

    const entry = manager.evaluate(makeInput({ breakers }));
    expect(entry.status).toBe('rejected');
    expect(entry.binding_constraint).toBe('circuit_breaker:portfolio');
    // The reason travels with the rejection — an operator must be able to tell
    // "we do not know the daily figure" from "the daily loss limit was hit".
    expect(entry.reasons.join(' ')).toContain('daily_pnl_unknown:portfolio');

    const exit = manager.evaluate(
      makeInput({ breakers, intent: makeIntent({ intent_type: 'exit' }) }),
    );
    expect(exit.status).toBe('approved');
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

describe('RiskManagerImpl.evaluate — CII soft signal (#205)', () => {
  it('fires macro_risk_flag when the mapped country is above the absolute threshold', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 85 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
  });

  it('does not fire when the country is at or below the threshold', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 70 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  it('does not fire for an instrument absent from the static country mapping', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      cii: { RU: 99 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  it('does not fire when the mapped country has no cached score', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: {},
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  it('fires every cycle a sustained high CII level is evaluated, not just on change', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 90 },
    });

    const first = manager.evaluate(input);
    const second = manager.evaluate(input);

    expect(first.warnings).toEqual(['macro_risk_flag:RU']);
    expect(second.warnings).toEqual(['macro_risk_flag:RU']);
  });

  it('never appears in binding_constraint or changes status/order_intent when it fires alongside a trim', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ cii_threshold: 70, max_position_size: 5_000 }),
    );
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX', size: 100, entry: 100 }),
      cii: { RU: 90 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
    expect(decision.binding_constraint).toBe('per_trade_size_cap');
    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(50);
  });

  it('still attaches the warning to an exit, which otherwise bypasses all entry gates', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX', intent_type: 'exit' }),
      cii: { RU: 90 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).toBeNull();
  });

  it('never appears in binding_constraint when a breaker rejects the intent', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      breakers: makeBreakers({ portfolio_tripped: true }),
      cii: { RU: 90 },
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU']);
    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });
});

/**
 * #303: the concentration check still treats an uncovered pair as "not
 * correlated" — nothing about sizing moves. What changes is that the decision
 * now SAYS so, so an absent correlation is no longer indistinguishable from a
 * measured zero.
 */
describe('RiskManagerImpl.evaluate — correlation warm-up warning (#303)', () => {
  it('warns for each held instrument with insufficient overlapping history', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000, TSLA: 3_000 } }),
      correlation: makeCorrelation({ insufficient_history: ['MSFT', 'TSLA'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['correlation_warmup:MSFT', 'correlation_warmup:TSLA']);
  });

  it('does not warn when every held pair has enough history', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
      correlation: makeCorrelation({ correlations: { MSFT: 0.1 }, insufficient_history: [] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual([]);
  });

  /**
   * The distinction that #303 exists to draw: a measured 0.0 and an
   * un-measurable pair both leave the concentration check inert, but only one
   * of them is evidence of diversification.
   */
  it('distinguishes a measured near-zero correlation from an unmeasurable pair', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const measured = manager.evaluate(
      makeInput({
        intent: makeIntent({ instrument: 'AAPL' }),
        portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
        correlation: makeCorrelation({ correlations: { MSFT: 0.0 }, insufficient_history: [] }),
      }),
    );
    const unmeasurable = manager.evaluate(
      makeInput({
        intent: makeIntent({ instrument: 'AAPL' }),
        portfolio: makePortfolio({ exposure_by_instrument: { MSFT: 4_000 } }),
        correlation: makeCorrelation({ correlations: {}, insufficient_history: ['MSFT'] }),
      }),
    );

    expect(measured.warnings).toEqual([]);
    expect(unmeasurable.warnings).toEqual(['correlation_warmup:MSFT']);
    // ...and the sizing outcome is identical: this warning trims nothing.
    expect(measured.order_intent?.size).toBe(unmeasurable.order_intent?.size);
  });

  /**
   * #381's six-instrument widening on day 1 of the soak: every pair uncovered.
   * The portfolio must not read as silently diversified.
   */
  it('flags every peer of a six-instrument day-1 portfolio rather than reading as diversified', () => {
    const manager = new RiskManagerImpl(
      makeConfig({ concentration: { cap: 9_000, threshold: 0.7 } }),
    );
    const peers = ['QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD'];
    const input = makeInput({
      intent: makeIntent({ instrument: 'SPY', size: 100, entry: 100 }),
      portfolio: makePortfolio({
        exposure_by_instrument: Object.fromEntries(peers.map((p) => [p, 4_000])),
      }),
      correlation: makeCorrelation({ correlations: {}, insufficient_history: peers }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    // Unchanged behaviour: nothing trims, because nothing is KNOWN correlated.
    expect(decision.binding_constraint).toBeNull();
    expect(decision.order_intent?.size).toBe(100);
    // ...but the blindness is now stated rather than implied by an empty map.
    expect(decision.warnings).toEqual(peers.map((p) => `correlation_warmup:${p}`));
  });

  it('attaches the warm-up warning alongside a CII flag without displacing it', () => {
    const manager = new RiskManagerImpl(makeConfig({ cii_threshold: 70 }));
    const input = makeInput({
      intent: makeIntent({ instrument: 'YNDX' }),
      cii: { RU: 90 },
      correlation: makeCorrelation({ insufficient_history: ['MSFT'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.warnings).toEqual(['macro_risk_flag:RU', 'correlation_warmup:MSFT']);
  });

  it('attaches the warm-up warning to a breaker rejection too', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL' }),
      breakers: makeBreakers({ portfolio_tripped: true }),
      correlation: makeCorrelation({ insufficient_history: ['MSFT'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('rejected');
    expect(decision.warnings).toEqual(['correlation_warmup:MSFT']);
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });

  it('attaches the warm-up warning to an exit, which bypasses every entry gate', () => {
    const manager = new RiskManagerImpl(makeConfig());
    const input = makeInput({
      intent: makeIntent({ instrument: 'AAPL', intent_type: 'exit' }),
      correlation: makeCorrelation({ insufficient_history: ['MSFT'] }),
    });

    const decision = manager.evaluate(input);

    expect(decision.status).toBe('approved');
    expect(decision.warnings).toEqual(['correlation_warmup:MSFT']);
  });
});

/**
 * #433 — the enforcement, not the construction.
 *
 * `autoTighten` moved every risk threshold toward its guardrail bound on a
 * kill-line breach, `AdjustmentLog` recorded it, and `RiskManagerImpl` went on
 * evaluating against a `RiskConfig` frozen at construction. So the system's
 * defensive response to "the edge may be gone" changed nothing about what it
 * would trade. After ADR-0007 removed the human gate, that was one of the few
 * self-defence mechanisms left.
 */
describe('RiskManagerImpl.evaluate — live risk thresholds (#433)', () => {
  /** A `risk_thresholds` table whose contents a test can move between calls. */
  function liveThresholds(initial: Record<string, number> = {}) {
    const thresholds = { ...initial };
    return {
      source: { getRiskThresholds: () => ({ ...thresholds }) },
      tighten(name: string, value: number) {
        thresholds[name] = value;
      },
    };
  }

  it('binds the tightened cap, not the constructor one', () => {
    const { source, tighten } = liveThresholds();
    const manager = new RiskManagerImpl(makeConfig(), source);
    // Default intent is 100 x $100 = $10,000 notional, well under the
    // 1,000,000 default cap.
    expect(manager.evaluate(makeInput()).modifications?.final_size).toBe(100);

    tighten('max_position_size', 5_000);
    const decision = manager.evaluate(makeInput());

    expect(decision.modifications?.final_size).toBe(50);
    // `binding_constraint` names the CHECK STEP, not the config field — the
    // tuning key is `max_position_size`, the step is `per_trade_size_cap`.
    expect(decision.binding_constraint).toBe('per_trade_size_cap');
  });

  it('picks up a tightening applied BETWEEN two evaluations', () => {
    // The property a constructor-frozen config cannot have, stated directly:
    // the Feedback Loop tightens once a day, and the next tick must feel it.
    const { source, tighten } = liveThresholds();
    const manager = new RiskManagerImpl(makeConfig(), source);

    const before = manager.evaluate(makeInput());
    tighten('portfolio_gross_cap', 2_000);
    const after = manager.evaluate(makeInput());

    expect(before.modifications?.final_size).toBe(100);
    expect(after.modifications?.final_size).toBe(20);
    expect(after.binding_constraint).toBe('portfolio_gross_exposure_cap');
  });

  it('tightens the per-asset-class cap through the nested field', () => {
    const { source } = liveThresholds({ per_asset_class_cap_stocks: 4_000 });
    const manager = new RiskManagerImpl(makeConfig(), source);

    const decision = manager.evaluate(makeInput());

    expect(decision.modifications?.final_size).toBe(40);
    expect(decision.binding_constraint).toBe('per_asset_class_exposure_cap');
  });

  it('falls back to the static config for a threshold the table has no row for', () => {
    const { source } = liveThresholds({ max_position_size: 5_000 });
    const manager = new RiskManagerImpl(makeConfig({ per_asset_cap: 3_000 }), source);

    const decision = manager.evaluate(makeInput());

    // per_asset_cap (3,000, static) binds before max_position_size (5,000, live).
    expect(decision.modifications?.final_size).toBe(30);
    expect(decision.binding_constraint).toBe('per_asset_exposure_cap');
  });

  it('behaves exactly as before when no source is supplied', () => {
    const withoutSource = new RiskManagerImpl(makeConfig({ max_position_size: 5_000 }));
    const withEmptySource = new RiskManagerImpl(makeConfig({ max_position_size: 5_000 }), {
      getRiskThresholds: () => ({}),
    });

    expect(withoutSource.evaluate(makeInput()).modifications?.final_size).toBe(
      withEmptySource.evaluate(makeInput()).modifications?.final_size,
    );
  });

  it('ignores a corrupt row rather than letting it disable the cap', () => {
    // NaN compares false against every notional, so applying one would turn a
    // cap into no cap at all — the opposite of what a tightening means.
    const { source } = liveThresholds({ max_position_size: Number.NaN });
    const manager = new RiskManagerImpl(makeConfig({ max_position_size: 5_000 }), source);

    const decision = manager.evaluate(makeInput());

    expect(decision.modifications?.final_size).toBe(50);
  });
});
