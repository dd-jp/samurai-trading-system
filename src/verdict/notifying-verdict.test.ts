import {
  AlwaysOpenCalendar,
  type Mark,
  type MarketDataService,
  type TradingCalendar,
} from '../market-data-service/index.js';
import type { BreakerState, RiskDecision } from '../risk-manager/index.js';
import type { Clock, OrderIntent } from '../shared/index.js';
import { VerdictImpl } from './index.js';
import type { TradeChannelNotifier } from './notifications/types.js';
import { NotifyingVerdict } from './notifying-verdict.js';
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
    warnings: [],
    next_breaker_state: [],
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
    drift_tolerance_pct: { crypto: 0.01, stocks: 0.01 },
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

const SESSION_BOUNDARY = new AlwaysOpenCalendar();

function makeTradingCalendar(isOpen = true): TradingCalendar {
  return {
    isOpen: () => isOpen,
    isTradingDay: () => true,
    sessionStart: (instant) => SESSION_BOUNDARY.sessionStart(instant),
  };
}

function makePositionStore(exists = false): PositionStore {
  return { findByKey: vi.fn().mockResolvedValue(exists) };
}

function makeApprovals(outcome: ApprovalOutcome = 'approved'): ApprovalChannel {
  return { requestApproval: vi.fn().mockResolvedValue(outcome) };
}

function makeNotifier(): TradeChannelNotifier {
  return { notify: vi.fn().mockResolvedValue(undefined) };
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

describe('NotifyingVerdict.decide', () => {
  it('stays SILENT on a routine no-go (staleness) — #465', async () => {
    // Reversed by #465, deliberately. verdict-spec.md story 14 asks for every
    // no-go on the trade channel, and that predates ADR-0007 (no human in the
    // loop) and ADR-0008 (the cadence). Together they make "every no-go" ~300
    // Telegram messages a day: alert fatigue by construction, and the failure
    // #342 split the heartbeat chat to avoid.
    //
    // The decision is still returned and still written to `verdict_log` by
    // `LoggingVerdict` — this changes what INTERRUPTS someone, not what is
    // recorded.
    const notifier = makeNotifier();
    const verdict = new NotifyingVerdict(new VerdictImpl(), notifier);
    const input = makeInput({
      risk_decision: makeRiskDecision({
        order_intent: makeIntent({ decision_timestamp: new Date('2026-07-15T13:00:00Z') }), // stale
      }),
    });

    const decision = await verdict.decide(input);

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('staleness');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('posts exactly one channel notification for a go decision reached via HITL', async () => {
    const notifier = makeNotifier();
    const verdict = new NotifyingVerdict(new VerdictImpl(), notifier);

    const decision = await verdict.decide(makeInput());

    expect(decision.status).toBe('go');
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('posts exactly one channel notification when the human rejects', async () => {
    const notifier = makeNotifier();
    const verdict = new NotifyingVerdict(new VerdictImpl(), notifier);

    const decision = await verdict.decide(makeInput({ approvals: makeApprovals('rejected') }));

    expect(decision.status).toBe('no_go');
    expect(decision.no_go_reason).toBe('human_rejected');
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('returns the inner decision unchanged', async () => {
    const notifier = makeNotifier();
    const inner = new VerdictImpl();
    const verdict = new NotifyingVerdict(inner, notifier);
    const input = makeInput();

    const expected = await inner.decide(input);
    const actual = await verdict.decide(input);

    expect(actual).toEqual(expected);
  });
});
