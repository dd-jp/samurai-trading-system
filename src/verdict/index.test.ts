import { describe, expect, it, vi } from 'vitest';
import type { TradingCalendar } from '../market-data-service/trading-calendar.js';
import type { Mark, MarketDataService } from '../market-data-service/types.js';
import type { BreakerState, RiskDecision } from '../risk-manager/types.js';
import type { Clock } from '../shared/clock.js';
import type { OrderIntent } from '../shared/types.js';
import { VerdictImpl } from './index.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  PositionStore,
  VerdictConfig,
  VerdictInput,
} from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const fixedClock: Clock = { now: () => NOW };

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T13:55:00Z'), // 5 min before NOW
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

function makeRiskDecision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  const orderIntent = makeIntent();
  return {
    status: 'approved',
    order_intent: orderIntent,
    modifications: { original_size: 100, final_size: 100, stop_tightened: false },
    binding_constraint: null,
    reasons: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
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

function makeConfig(overrides: Partial<VerdictConfig> = {}): VerdictConfig {
  return {
    automation_level: { crypto: 'manual', stocks: 'manual' },
    max_signal_age: { crypto: 5 * 60_000, stocks: 30 * 60_000 },
    drift_tolerance: 1,
    human_timeout: 5 * 60_000,
    allow_extended_hours: false,
    flag_thresholds: { size_over: 10_000 },
    ...overrides,
  };
}

function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    price: 100,
    observed_at: NOW,
    source: 'test',
    asset_class: 'stocks',
    ...overrides,
  };
}

function makeMarketData(mark: Mark = makeMark()): MarketDataService {
  return {
    getBars: vi.fn(),
    getIndicator: vi.fn(),
    getMark: vi.fn().mockResolvedValue(mark),
    getSpreadEstimate: vi.fn(),
    getADV: vi.fn(),
  } as unknown as MarketDataService;
}

function makeTradingCalendar(isOpen = true): TradingCalendar {
  return {
    isOpen: () => isOpen,
    isTradingDay: () => true,
  };
}

function makePositionStore(exists = false): PositionStore {
  return { findByKey: vi.fn().mockResolvedValue(exists) };
}

function makeApprovals(outcome: ApprovalOutcome = 'approved'): ApprovalChannel {
  return { requestApproval: vi.fn().mockResolvedValue(outcome) };
}

function makeInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    trace_id: 'trace-1',
    risk_decision: makeRiskDecision(),
    clock: fixedClock,
    marketData: makeMarketData(),
    tradingCalendar: makeTradingCalendar(),
    positionStore: makePositionStore(),
    breakers: makeBreakers(),
    config: makeConfig(),
    mode: 'live',
    approvals: makeApprovals(),
    ...overrides,
  };
}

describe('VerdictImpl.decide — full pass', () => {
  it('produces go when every gate passes and the human approves', async () => {
    const verdict = new VerdictImpl();
    const decision = await verdict.decide(makeInput());

    expect(decision.status).toBe('go');
    expect(decision.order).toEqual(makeIntent());
    expect(decision.no_go_reason).toBeNull();
    expect(decision.approval_path).toBe('human');
    expect(decision.would_require_approval).toBe(true);
    expect(decision.idempotency_key).toBe('AAPL-2026-07-15T13:55:00Z');
    expect(decision.timestamp).toEqual(NOW);
  });
});

describe('VerdictImpl.decide — staleness gate', () => {
  it('no-go with staleness when the signal has aged past max_signal_age', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decision_timestamp: new Date('2026-07-15T13:00:00Z') }), // 60 min old
      }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('staleness');
    expect(decision.order).toBeNull();
  });
});

describe('VerdictImpl.decide — drift gate', () => {
  it('no-go with drift when current price has moved past tolerance from entry', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      marketData: makeMarketData(makeMark({ price: 105 })), // entry 100, tolerance 1
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('drift');
  });
});

describe('VerdictImpl.decide — dedup gate', () => {
  it('no-go with dedup when an order/fill already exists for this idempotency key', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ positionStore: makePositionStore(true) });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('dedup');
  });
});

describe('VerdictImpl.decide — market-open gate', () => {
  it('no-go with market_closed for a stock order outside session hours', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ tradingCalendar: makeTradingCalendar(false) });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('market_closed');
  });

  it('skips the market-open gate for crypto', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ asset_class: 'crypto', instrument: 'BTC-USD' }),
      }),
      tradingCalendar: makeTradingCalendar(false),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
  });

  it('skips the market-open gate for stocks when extended hours are allowed', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      tradingCalendar: makeTradingCalendar(false),
      config: makeConfig({ allow_extended_hours: true }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
  });
});

describe('VerdictImpl.decide — breaker re-check gate', () => {
  it('no-go with breaker when the portfolio breaker is tripped at fire time', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ breakers: makeBreakers({ portfolio_tripped: true }) });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('breaker');
  });

  it('no-go with breaker when the relevant asset-class breaker is tripped', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      breakers: makeBreakers({ asset_class_tripped: { crypto: false, stocks: true } }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('breaker');
  });
});

describe('VerdictImpl.decide — HITL gate', () => {
  it('no-go with human_rejected when the human rejects', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ approvals: makeApprovals('rejected') });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('human_rejected');
    expect(decision.approval_path).toBe('human');
  });

  it('defaults to no-go with timeout when the human does not respond in time', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({ approvals: makeApprovals('timeout') });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('timeout');
    expect(decision.approval_path).toBe('human_timeout');
  });
});

describe('VerdictImpl.decide — automation dial', () => {
  it('auto mode never engages HITL, even for a near-limit (flagged) trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('rejected'); // would fail if ever called
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'auto' } }),
      risk_decision: makeRiskDecision({
        modifications: { original_size: 200, final_size: 100, stop_tightened: true },
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    expect(decision.would_require_approval).toBe(false);
  });

  it('manual mode always engages HITL, even with no flags set', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'manual' } }),
      risk_decision: makeRiskDecision({ modifications: null }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
    expect(decision.would_require_approval).toBe(true);
  });

  it('semi_auto skips HITL for an unflagged trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('rejected'); // would fail if ever called
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({ modifications: null }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    expect(decision.would_require_approval).toBe(false);
  });

  it('semi_auto engages HITL for a near-limit trade (risk_decision.modifications != null)', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({
        modifications: { original_size: 200, final_size: 100, stop_tightened: true },
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('semi_auto engages HITL for a non-converged trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({
        modifications: null,
        order_intent: makeIntent({ metadata: { ...makeIntent().metadata, converged: false } }),
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('semi_auto engages HITL for a no-precedent trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
      risk_decision: makeRiskDecision({
        modifications: null,
        order_intent: makeIntent({
          metadata: {
            ...makeIntent().metadata,
            cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
          },
        }),
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('semi_auto engages HITL for a size-over trade', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({
      config: makeConfig({
        automation_level: { crypto: 'manual', stocks: 'semi_auto' },
        flag_thresholds: { size_over: 50 },
      }),
      risk_decision: makeRiskDecision({
        modifications: null,
        order_intent: makeIntent({ size: 100 }),
      }),
      approvals,
    });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.approval_path).toBe('human');
  });

  it('the same OrderIntent produces different routing under each dial setting', async () => {
    const verdict = new VerdictImpl();
    const riskDecision = makeRiskDecision({
      modifications: { original_size: 200, final_size: 100, stop_tightened: true }, // near-limit
    });

    const manualApprovals = makeApprovals('approved');
    const manualDecision = await verdict.decide(
      makeInput({
        config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'manual' } }),
        risk_decision: riskDecision,
        approvals: manualApprovals,
      }),
    );

    const semiAutoApprovals = makeApprovals('approved');
    const semiAutoDecision = await verdict.decide(
      makeInput({
        config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'semi_auto' } }),
        risk_decision: riskDecision,
        approvals: semiAutoApprovals,
      }),
    );

    const autoApprovals = makeApprovals('approved');
    const autoDecision = await verdict.decide(
      makeInput({
        config: makeConfig({ automation_level: { crypto: 'manual', stocks: 'auto' } }),
        risk_decision: riskDecision,
        approvals: autoApprovals,
      }),
    );

    expect(manualApprovals.requestApproval).toHaveBeenCalledTimes(1);
    expect(semiAutoApprovals.requestApproval).toHaveBeenCalledTimes(1);
    expect(autoApprovals.requestApproval).not.toHaveBeenCalled();

    expect(manualDecision.approval_path).toBe('human');
    expect(semiAutoDecision.approval_path).toBe('human');
    expect(autoDecision.approval_path).toBe('automated');

    expect(manualDecision.would_require_approval).toBe(true);
    expect(semiAutoDecision.would_require_approval).toBe(true);
    expect(autoDecision.would_require_approval).toBe(false);
  });
});

describe('VerdictImpl.decide — paper mode', () => {
  it('requires HITL via the real ApprovalChannel, same as live', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({ mode: 'paper', approvals });

    const decision = await verdict.decide(input);

    expect(approvals.requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('human');
    expect(decision.would_require_approval).toBe(true);
  });

  it('no-goes when the human rejects, same as live', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('rejected');
    const input = makeInput({ mode: 'paper', approvals });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
  });
});

describe('VerdictImpl.decide — backtest mode', () => {
  it('bypasses HITL with an automated go, recording would_require_approval', async () => {
    const verdict = new VerdictImpl();
    const approvals = makeApprovals('approved');
    const input = makeInput({ mode: 'backtest', approvals });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    expect(decision.would_require_approval).toBe(true);
  });
});

describe('VerdictImpl.decide — gate ordering', () => {
  it('the first failing gate wins even when later gates would also fail', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decision_timestamp: new Date('2026-07-15T13:00:00Z') }), // stale
      }),
      marketData: makeMarketData(makeMark({ price: 999 })), // would also drift-fail
      positionStore: makePositionStore(true), // would also dedup-fail
      breakers: makeBreakers({ portfolio_tripped: true }), // would also breaker-fail
      approvals: makeApprovals('rejected'), // would also HITL-fail
    });

    const decision = await verdict.decide(input);

    expect(decision.no_go_reason).toBe('staleness');
  });

  it('a stale feed at the final check no-goes even though every earlier gate passed', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decision_timestamp: new Date('2026-07-15T13:00:00Z') }), // stale
      }),
      // Every other gate would pass cleanly.
      marketData: makeMarketData(makeMark({ price: 100 })),
      tradingCalendar: makeTradingCalendar(true),
      positionStore: makePositionStore(false),
      breakers: makeBreakers(),
      approvals: makeApprovals('approved'),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('staleness');
  });
});

describe('VerdictImpl.decide — precondition', () => {
  it('throws if handed a RiskDecision without an approved order_intent', async () => {
    const verdict = new VerdictImpl();
    const input = makeInput({
      risk_decision: makeRiskDecision({ status: 'rejected', order_intent: null }),
    });

    await expect(verdict.decide(input)).rejects.toThrow();
  });
});
