import { describe, expect, it, vi } from 'vitest';
import type { TradingCalendar } from '../market-data-service/trading-calendar.js';
import type { Mark, MarketDataService } from '../market-data-service/types.js';
import type { BreakerState, RiskDecision } from '../risk-manager/types.js';
import type { Clock } from '../shared/clock.js';
import type { OrderIntent } from '../shared/types.js';
import { VerdictImpl } from './index.js';
import { LoggingVerdict } from './logging-verdict.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  PositionStore,
  VerdictConfig,
  VerdictInput,
} from './types.js';
import { InMemoryVerdictLogStore } from './verdict-log-store.js';

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
    decision_timestamp: new Date('2026-07-15T13:55:00Z'),
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
      cosine_precedent: { neighbor_count: 5, weighted_mean_r: 0.4, no_precedent: false },
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
  return { price: 100, observed_at: NOW, source: 'test', asset_class: 'stocks', ...overrides };
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
  return { isOpen: () => isOpen, isTradingDay: () => true };
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

describe('LoggingVerdict.decide', () => {
  it('writes exactly one verdict_log row for a no-go decision (staleness, no HITL reached)', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decision_timestamp: new Date('2026-07-15T13:00:00Z') }), // stale
      }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('staleness');
    expect(store.getByTraceId('trace-1')).toEqual({
      trace_id: 'trace-1',
      idempotency_key: decision.idempotency_key,
      instrument: 'AAPL',
      status: 'no_go',
      no_go_reason: 'staleness',
      hitl_override: false,
      timestamp: decision.timestamp,
    });
  });

  it('writes a go row with hitl_override true when reached via human approval', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);

    const decision = await verdict.decide(makeInput());

    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('human');
    const row = store.getByTraceId('trace-1');
    expect(row?.status).toBe('go');
    expect(row?.no_go_reason).toBeNull();
    expect(row?.hitl_override).toBe(true);
  });

  it('writes hitl_override true when the human rejects', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);

    const decision = await verdict.decide(makeInput({ approvals: makeApprovals('rejected') }));

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('human_rejected');
    const row = store.getByTraceId('trace-1');
    expect(row?.no_go_reason).toBe('human_rejected');
    expect(row?.hitl_override).toBe(true);
  });

  it('writes hitl_override true on a human timeout', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);

    const decision = await verdict.decide(makeInput({ approvals: makeApprovals('timeout') }));

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('timeout');
    const row = store.getByTraceId('trace-1');
    expect(row?.hitl_override).toBe(true);
  });

  it('writes hitl_override true in paper mode, same as live (no backtest bypass)', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);

    const decision = await verdict.decide(makeInput({ mode: 'paper' }));

    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('human');
    const row = store.getByTraceId('trace-1');
    expect(row?.hitl_override).toBe(true);
  });

  it('writes hitl_override false on a backtest bypass, even though would_require_approval is true', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);

    const decision = await verdict.decide(makeInput({ mode: 'backtest' }));

    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    expect(decision.would_require_approval).toBe(true);
    const row = store.getByTraceId('trace-1');
    expect(row?.hitl_override).toBe(false);
  });

  it('writes hitl_override false on a fully automated go (auto dial, no HITL engaged)', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);

    const decision = await verdict.decide(
      makeInput({ config: makeConfig({ automation_level: { crypto: 'auto', stocks: 'auto' } }) }),
    );

    expect(decision.status).toBe('go');
    expect(decision.approval_path).toBe('automated');
    const row = store.getByTraceId('trace-1');
    expect(row?.hitl_override).toBe(false);
  });

  it('returns the inner decision unchanged', async () => {
    const store = new InMemoryVerdictLogStore();
    const inner = new VerdictImpl();
    const verdict = new LoggingVerdict(inner, store);
    const input = makeInput();

    const expected = await inner.decide(input);
    const actual = await verdict.decide(input);

    expect(actual).toEqual(expected);
  });

  it('does not conflate rows across distinct trace_ids', async () => {
    const store = new InMemoryVerdictLogStore();
    const verdict = new LoggingVerdict(new VerdictImpl(), store);

    await verdict.decide(makeInput({ trace_id: 'trace-a' }));
    await verdict.decide(
      makeInput({
        trace_id: 'trace-b',
        risk_decision: makeRiskDecision({ order_intent: makeIntent({ instrument: 'TSLA' }) }),
      }),
    );

    expect(store.getByTraceId('trace-a')?.instrument).toBe('AAPL');
    expect(store.getByTraceId('trace-b')?.instrument).toBe('TSLA');
  });
});
