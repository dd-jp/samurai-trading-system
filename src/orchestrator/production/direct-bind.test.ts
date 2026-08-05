import type { DebateResult } from '../../debate-engine/index.js';
import type { ExecutionConfig } from '../../execution/index.js';
import type { RiskConfig } from '../../risk-manager/index.js';
import { CircuitBreakers } from '../../risk-manager/index.js';
import type { Clock, OpenPosition, OrderIntent } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { TraderConfig } from '../../trader/index.js';
import type { VerdictConfig, VerdictDecision } from '../../verdict/index.js';
import { OrphanVerdictScanner } from '../orphan-verdict-scan.js';
import { SqliteAuditLog } from '../sqlite-audit-log.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
import {
  buildExecutionStep,
  buildPersistence,
  buildRiskStep,
  buildTraderStep,
  buildVerdictStep,
} from './direct-bind.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };
const TRACE_ID = 'trace-1';

function makeBars(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const close_time = new Date(NOW.getTime() - (count - i) * 60 * 60 * 1000);
    return {
      instrument: 'AAPL',
      timeframe: '1h',
      open_time: new Date(close_time.getTime() - 60 * 60 * 1000),
      close_time,
      open: 100 + i,
      high: 102 + i,
      low: 98 + i,
      close: 100 + i,
      volume: 1000,
      source: 'fixture',
    };
  });
}

const FAKE_MARKET_DATA = {
  getBars: vi.fn(async () => makeBars(20)),
  getIndicator: vi.fn(),
  getMark: vi.fn(async () => ({
    price: 100,
    observed_at: NOW,
    asset_class: 'stocks' as const,
  })),
  getSpreadEstimate: vi.fn(async () => null),
  getADV: vi.fn(async () => 1000),
};

const FAKE_ACCOUNT_STATE = {
  getAccountState: vi.fn(async () => ({
    cash: 10_000,
    peak_equity: 10_000,
    daily_basis: {
      crypto: { known: true, open_equity: 10_000, realized_pnl: 0 },
      stocks: { known: true, open_equity: 10_000, realized_pnl: 0 },
      portfolio: { known: true, open_equity: 10_000, realized_pnl: 0 },
    },
    consecutive_losses: 0,
  })),
};

const FAKE_VOLATILITY = {
  getVolatilityReading: vi.fn(async () => ({ crypto: 0.02, stocks: 0.01 })),
};

const NO_POSITIONS: OpenPosition[] = [];

function makeDebate(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'bullish',
    position: 'long',
    confidence: 0.8,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 1,
    latency_ms: 10,
    direction: 'bullish',
    debate_id: 'debate-1',
    ...overrides,
  };
}

describe('buildTraderStep', () => {
  it('binds decide() to the TickSteps.trader shape and reads live portfolio equity', async () => {
    const config: TraderConfig = {
      conviction_floor: 0.5,
      max_risk_per_trade: 0.01,
      asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
      atr_timeframe: '1h',
      atr_lookback: 14,
      atr_k: 2,
      vol_floor_fraction: 0.002,
      non_converged_haircut: 0.5,
      reward_risk_multiple: 2,
      min_viable_notional: 10,
      time_in_force: 'day',
    };
    const step = buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      mode: 'paper',
      config,
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate(),
      clock: CLOCK,
    });

    expect(intent).not.toBeNull();
    expect(intent?.instrument).toBe('AAPL');
    expect(intent?.intent_type).toBe('entry');
    expect(FAKE_ACCOUNT_STATE.getAccountState).toHaveBeenCalled();
  });

  it('returns null for a non-converged, low-confidence debate (no behavior change to decide())', async () => {
    const config: TraderConfig = {
      conviction_floor: 0.9,
      max_risk_per_trade: 0.01,
      asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
      atr_timeframe: '1h',
      atr_lookback: 14,
      atr_k: 2,
      vol_floor_fraction: 0.002,
      non_converged_haircut: 0.5,
      reward_risk_multiple: 2,
      min_viable_notional: 10,
      time_in_force: 'day',
    };
    const step = buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      mode: 'paper',
      config,
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ confidence: 0.6 }),
      clock: CLOCK,
    });

    expect(intent).toBeNull();
  });
});

describe('buildRiskStep', () => {
  const RISK_CONFIG: RiskConfig = {
    max_position_size: 100_000,
    per_asset_cap: 100_000,
    per_asset_class_cap: { crypto: 100_000, stocks: 100_000 },
    portfolio_gross_cap: 200_000,
    concentration: { cap: 100_000, threshold: 0.9 },
    min_viable_size: 1,
    cii_threshold: 80,
  };

  function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
    return {
      idempotency_key: 'key-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      size: 10,
      entry: 100,
      stop: 95,
      target: 110,
      time_in_force: 'day',
      decision_timestamp: NOW,
      metadata: {
        debate_id: 'debate-1',
        conviction: 0.8,
        converged: true,
        sizing: {
          conviction_multiplier: 1,
          non_converged_haircut: 1,
          cosine_multiplier: 0.75,
          vol_floor_applied: false,
        },
        cosine_precedent: { no_precedent: true, nearest_ids: [] },
      },
      ...overrides,
    } as OrderIntent;
  }

  it('assembles RiskInput from live portfolio/breakers/correlation/cii and calls evaluate() unmodified', async () => {
    const step = buildRiskStep({
      config: RISK_CONFIG,
      correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
      ciiConsumer: { getScores: vi.fn(() => ({})) },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      mode: 'paper',
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.instrument).toBe('AAPL');
    expect(decision.next_breaker_state).toHaveLength(2);
  });

  it('rejects when the portfolio circuit breaker is already tripped (sticky state honored)', async () => {
    const circuitBreakers = new CircuitBreakers({
      daily_loss_pct: 0.05,
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    });
    // Force the hard drawdown breaker to trip: peak far above equity so
    // drawdown_pct exceeds max_drawdown_pct on the first evaluate() call.
    const step = buildRiskStep({
      config: RISK_CONFIG,
      correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
      ciiConsumer: { getScores: vi.fn(() => ({})) },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers,
      accountState: {
        getAccountState: vi.fn(async () => ({
          cash: 0,
          peak_equity: 1_000_000,
          daily_basis: {
            crypto: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
            stocks: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
            portfolio: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
          },
          consecutive_losses: 0,
        })),
      },
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      mode: 'paper',
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });
});

describe('buildVerdictStep', () => {
  const VERDICT_CONFIG: VerdictConfig = {
    automation_level: { crypto: 'auto', stocks: 'auto' },
    max_signal_age: { crypto: 60_000, stocks: 60_000 },
    drift_tolerance: 5,
    human_timeout: 60_000,
    allow_extended_hours: true,
    flag_thresholds: { size_over: 1000 },
  };

  it('calls VerdictImpl.decide() with a freshly-fetched breaker state, not a fabricated one', async () => {
    const riskDecision = {
      status: 'approved' as const,
      order_intent: {
        idempotency_key: 'key-1',
        instrument: 'AAPL',
        asset_class: 'stocks' as const,
        side: 'buy' as const,
        intent_type: 'entry' as const,
        size: 10,
        entry: 100,
        stop: 95,
        target: 110,
        time_in_force: 'day',
        decision_timestamp: NOW,
        metadata: {
          debate_id: 'debate-1',
          conviction: 0.8,
          converged: true,
          sizing: {
            conviction_multiplier: 1,
            non_converged_haircut: 1,
            cosine_multiplier: 0.75,
            vol_floor_applied: false,
          },
          cosine_precedent: { no_precedent: true, nearest_ids: [] },
        },
      },
      modifications: null,
      binding_constraint: null,
      reasons: [],
      warnings: [],
      risk_snapshot: {
        exposure: {},
        drawdown_pct: 0,
        armed_breakers: [],
      },
      next_breaker_state: [],
    };

    const db = openSharedStore(':memory:');
    const step = buildVerdictStep({
      tradingCalendar: { isOpen: () => true, hasSession: () => true } as never,
      positionStore: { findByKey: vi.fn(async () => false) },
      config: VERDICT_CONFIG,
      approvals: { requestApproval: vi.fn(async () => 'approved') },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      mode: 'paper',
      store: db,
    });

    const result: VerdictDecision = await step({
      trace_id: TRACE_ID,
      risk_decision: riskDecision as never,
      clock: CLOCK,
    });

    expect(result.status).toBe('go');
  });

  it('persists the go decision to verdict_log (#302 — LoggingVerdict must be wired, not a bare VerdictImpl)', async () => {
    const db = openSharedStore(':memory:');
    const riskDecision = {
      status: 'approved' as const,
      order_intent: {
        idempotency_key: 'key-2',
        instrument: 'TSLA',
        asset_class: 'stocks' as const,
        side: 'buy' as const,
        intent_type: 'entry' as const,
        size: 10,
        entry: 100,
        stop: 95,
        target: 110,
        time_in_force: 'day',
        decision_timestamp: NOW,
        metadata: {
          debate_id: 'debate-2',
          conviction: 0.8,
          converged: true,
          sizing: {
            conviction_multiplier: 1,
            non_converged_haircut: 1,
            cosine_multiplier: 0.75,
            vol_floor_applied: false,
          },
          cosine_precedent: { no_precedent: true, nearest_ids: [] },
        },
      },
      modifications: null,
      binding_constraint: null,
      reasons: [],
      warnings: [],
      risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
      next_breaker_state: [],
    };

    const step = buildVerdictStep({
      tradingCalendar: { isOpen: () => true, hasSession: () => true } as never,
      positionStore: { findByKey: vi.fn(async () => false) },
      config: VERDICT_CONFIG,
      approvals: { requestApproval: vi.fn(async () => 'approved') },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      mode: 'paper',
      store: db,
    });

    const result: VerdictDecision = await step({
      trace_id: 'trace-verdict-log',
      risk_decision: riskDecision as never,
      clock: CLOCK,
    });

    expect(result.status).toBe('go');
    const row = db
      .prepare('SELECT * FROM verdict_log WHERE trace_id = ?')
      .get('trace-verdict-log') as { status: string; instrument: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.status).toBe('go');
    expect(row?.instrument).toBe('TSLA');
  });
});

describe('buildExecutionStep', () => {
  const EXECUTION_CONFIG: ExecutionConfig = {
    simulated: { spread_fallback_bps: 5, adv_participation_cap: 0.1 } as never,
  };

  it('binds execute() to the TickSteps.execution shape', async () => {
    const store = {
      findByKey: vi.fn(async () => false),
      writeAheadPosition: vi.fn(async () => {}),
      updatePositionState: vi.fn(async () => {}),
      getOpenPositions: vi.fn(async () => []),
      writeClosedTrade: vi.fn(async () => {}),
    };
    const broker = {
      submitBracket: vi.fn(async () => ({ broker_order_ids: ['o1'] })),
      getOrder: vi.fn(async () => null),
    };

    const step = buildExecutionStep({
      clock: CLOCK,
      broker: broker as never,
      store: store as never,
      costModel: {} as never,
      marketData: FAKE_MARKET_DATA,
      config: EXECUTION_CONFIG,
      mode: 'paper',
    });

    const verdict: VerdictDecision = {
      status: 'no_go',
      order: null,
      no_go_reason: 'staleness',
      approval_path: 'automated',
      would_require_approval: false,
      idempotency_key: 'key-1',
      timestamp: NOW,
    };

    const result = await step(verdict);
    expect(result.status).toBe('error');
  });
});

describe('buildPersistence', () => {
  it('constructs SqliteAuditLog/SqliteCurrentTickStore/OrphanVerdictScanner against the shared store', () => {
    const db = openSharedStore(':memory:');
    const persistence = buildPersistence(db);

    expect(persistence.auditLog).toBeInstanceOf(SqliteAuditLog);
    expect(persistence.currentTickStore).toBeInstanceOf(SqliteCurrentTickStore);
    expect(persistence.orphanScanner).toBeInstanceOf(OrphanVerdictScanner);
  });
});
