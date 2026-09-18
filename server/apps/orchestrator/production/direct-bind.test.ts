import type { DebateResult } from '../../../pipeline/debate-engine/index.js';
import {
  type ExecutionConfig,
  FilledZeroSizeThrottle,
  SqliteExecutionStore,
  UnrecordedVenuePositionThrottle,
} from '../../../pipeline/execution/index.js';
import type {
  PersistedBreakerState,
  RiskConfig,
  RiskCriticProducer,
  RiskCriticVerdict,
} from '../../../pipeline/risk-manager/index.js';
import {
  CircuitBreakers,
  RISK_CRITIC_SKIPPED_REASON,
} from '../../../pipeline/risk-manager/index.js';
import {
  ADR_0018_SUBCLASS_BRACKETS,
  DEFAULT_EARLY_EXIT_CONFIG,
  FixtureSetupStore,
  type TraderConfig,
} from '../../../pipeline/trader/index.js';
import type {
  ApprovalOutcome,
  VerdictConfig,
  VerdictDecision,
} from '../../../pipeline/verdict/index.js';
import {
  AlwaysOpenCalendar,
  collectMarks,
  type IndicatorSpec,
  InsufficientBarsError,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { TraderDecisionRecord } from '../../../shared/decision-records.js';
import type {
  AssetClass,
  Clock,
  LogEntry,
  Logger,
  OpenPosition,
  OrderIntent,
} from '../../../shared/index.js';
import { toBrokerFillId } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { OrphanVerdictScanner } from '../orphan-verdict-scan.js';
import { SqliteAuditLog } from '../sqlite-audit-log.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
import { type CapitalCeilingUsd, toCapitalCeilingUsd } from './capital-ceiling.js';
import type { PortfolioSnapshot } from './direct-bind.js';
import {
  buildExecutionStep,
  buildPersistence,
  buildRiskStep,
  buildTraderStep,
  buildTraderSteps,
  buildVerdictStep,
  sizingEquity,
} from './direct-bind.js';
import type {
  ExitValuationDegradedAlert,
  ExitValuationDegradedAlertChannel,
} from './exit-valuation-alert.js';
import type { TraderDiagnosticAlertChannel } from './trader-diagnostic-alert.js';

const OPEN_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

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

const FAKE_GET_MARK = vi.fn(async (_instrument: string, _asOf: Date) => ({
  price: 100,
  observed_at: NOW,
  asset_class: 'stocks' as const,
  source: 'fixture',
}));

const FAKE_MARKET_DATA = {
  getBars: vi.fn(async () => makeBars(20)),
  getIndicator: vi.fn(),
  getMark: FAKE_GET_MARK,
  getMarks: vi.fn(async (instruments: readonly string[], asOf: Date) =>
    collectMarks(FAKE_GET_MARK, instruments, asOf),
  ),
  getSpreadEstimate: vi.fn(async () => null),
  getQuote: vi.fn(async () => null),
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
    } as const,
    consecutive_losses: 0,
  })),
};

const FAKE_VOLATILITY = {
  getVolatilityReading: vi.fn(async () => ({ crypto: 0.02, stocks: 0.01 })),
};

const NO_POSITIONS: OpenPosition[] = [];

const TEST_MAX_MARK_AGE = { crypto: 2 * 60_000, stocks: 15 * 60_000 };

const NOOP_BREAKER_STATE = { save: () => {} };

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
    bar_timestamp: NOW,
    read: true,
    ...overrides,
  };
}

describe('buildTraderStep', () => {
  it('binds decide() to the TickSteps.trader shape and reads live portfolio equity', async () => {
    const config: TraderConfig = {
      conviction_floor: 0.5,
      max_risk_per_trade: 0.01,
      asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
      subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
      subclass_of: {},
      atr_timeframe: '1h',
      atr_lookback: 14,
      atr_k: 2,
      vol_floor_fraction: 0.002,
      non_converged_haircut: 0.5,
      reward_risk_multiple: 2,
      min_viable_notional: 10,
      whole_share_sizing: false,
      scale_in_conviction_delta: 0.1,
      early_exit: DEFAULT_EARLY_EXIT_CONFIG,
      time_in_force: { crypto: 'gtc', stocks: 'day' },
      flatten_before_close_ms: 5 * 60 * 1_000,
      flatten_after_close_ms: 5 * 60 * 1_000,
    };
    const step = buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
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

  it("brackets and sizes off ADR-0018's frozen row once the config classifies the instrument", async () => {
    const config: TraderConfig = {
      conviction_floor: 0.5,
      max_risk_per_trade: 0.01,
      asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
      subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
      subclass_of: { AAPL: 'index_etp_3x' },
      atr_timeframe: '1h',
      atr_lookback: 14,
      atr_k: 2,
      vol_floor_fraction: 0.002,
      non_converged_haircut: 1,
      reward_risk_multiple: 2,
      min_viable_notional: 10,
      whole_share_sizing: false,
      scale_in_conviction_delta: 0.1,
      early_exit: DEFAULT_EARLY_EXIT_CONFIG,
      time_in_force: { crypto: 'gtc', stocks: 'day' },
      flatten_before_close_ms: 5 * 60 * 1_000,
      flatten_after_close_ms: 5 * 60 * 1_000,
    };
    const step = buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ confidence: 1 }),
      clock: CLOCK,
    });

    if (intent === null) throw new Error('expected an entry intent');
    expect(intent.stop).toBeCloseTo(97.84, 9);
    expect(intent.target).toBeCloseTo(102, 9);
    expect(intent.size * intent.entry).toBeCloseTo(0.35 * 0.9 * 10_000 * 0.75, 6);
    expect(intent.metadata.sizing.frozen_bracket?.headroom_reserve_fraction).toBe(0.1);
    expect(intent.metadata.sizing.frozen_bracket?.stop_pct).toBe(0.0216);
  });

  it('returns null for a non-converged, low-confidence debate (no behavior change to decide())', async () => {
    const config: TraderConfig = {
      conviction_floor: 0.9,
      max_risk_per_trade: 0.01,
      asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
      subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
      subclass_of: {},
      atr_timeframe: '1h',
      atr_lookback: 14,
      atr_k: 2,
      vol_floor_fraction: 0.002,
      non_converged_haircut: 0.5,
      reward_risk_multiple: 2,
      min_viable_notional: 10,
      whole_share_sizing: false,
      scale_in_conviction_delta: 0.1,
      early_exit: DEFAULT_EARLY_EXIT_CONFIG,
      time_in_force: { crypto: 'gtc', stocks: 'day' },
      flatten_before_close_ms: 5 * 60 * 1_000,
      flatten_after_close_ms: 5 * 60 * 1_000,
    };
    const step = buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ confidence: 0.6 }),
      clock: CLOCK,
    });

    expect(intent).toBeNull();
  });

  it('sizes an exit to the residual of a partially flattened lot, reading the same store the lots come from', async () => {
    const config: TraderConfig = {
      conviction_floor: 0.5,
      max_risk_per_trade: 0.01,
      asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
      subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
      subclass_of: {},
      atr_timeframe: '1h',
      atr_lookback: 14,
      atr_k: 2,
      vol_floor_fraction: 0.002,
      non_converged_haircut: 0.5,
      reward_risk_multiple: 2,
      min_viable_notional: 10,
      whole_share_sizing: false,
      scale_in_conviction_delta: 0.1,
      early_exit: DEFAULT_EARLY_EXIT_CONFIG,
      time_in_force: { crypto: 'gtc', stocks: 'day' },
      flatten_before_close_ms: 5 * 60 * 1_000,
      flatten_after_close_ms: 5 * 60 * 1_000,
    };
    const store = new SqliteExecutionStore(openSharedStore(':memory:'));
    await store.writeAheadPosition({
      idempotency_key: 'key-aapl-entry-1',
      debate_id: 'debate-0',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10,
      filled_size: 10,
      avg_entry_price: 100,
      stop: 95,
      target: 110,
      order_state: 'filled',
      broker_order_ids: [],
      opened_at: NOW,
      decision_timestamp: NOW,
      conviction: 0.6,
      converged: true,
    });
    await store.applyLotAdvance({
      idempotency_key: 'key-aapl-entry-1',
      fills: [
        {
          idempotency_key: 'key-aapl-entry-1',
          broker_fill_id: toBrokerFillId('fill-partial-flatten'),
          leg: 'exit',
          price: 99,
          qty: 4,
          fee: 0.1,
          timestamp: NOW,
        },
      ],
    });

    const step = buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: () => store.getOpenPositions(),
      maxMarkAge: TEST_MAX_MARK_AGE,
      getExitFillSizes: (idempotency_keys) => store.getExitFillSizes(idempotency_keys),
      getUnresolvedFlattens: async () => [],
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config,
      setupStore: new FixtureSetupStore(),
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ direction: 'bearish', confidence: 0.8, converged: true }),
      clock: CLOCK,
    });

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.side).toBe('sell');
    expect(intent?.size).toBe(6);
  });
});

describe('buildTraderStep — decision_class on trader_log (#1109)', () => {
  const CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    subclass_of: {},
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 10,
    whole_share_sizing: false,
    scale_in_conviction_delta: 0.1,
    early_exit: DEFAULT_EARLY_EXIT_CONFIG,
    time_in_force: { crypto: 'gtc', stocks: 'day' },
    flatten_before_close_ms: 5 * 60 * 1_000,
    flatten_after_close_ms: 5 * 60 * 1_000,
  };

  function makeStep(writes: TraderDecisionRecord[]) {
    return buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      traderLog: { write: (record) => writes.push(record) },
    });
  }

  it('persists could_not_decide, not a bare skip_reason, when the debate that read neutral had timed out', async () => {
    const writes: TraderDecisionRecord[] = [];
    const step = makeStep(writes);

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({
        direction: 'neutral',
        synthesis: 'neutral',
        converged: false,
        rounds_completed: 0,
        timed_out: { budget_ms: 8_000, elapsed_ms: 8_050 },
      }),
      clock: CLOCK,
    });

    expect(intent).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.skip_reason).toBe('neutral_direction_while_flat');
    expect(writes[0]?.decision_class).toBe('could_not_decide');
  });

  it('persists declined_on_signal, not the same row, when the debate genuinely converged on neutral', async () => {
    const writes: TraderDecisionRecord[] = [];
    const step = makeStep(writes);

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ direction: 'neutral', synthesis: 'neutral', converged: true }),
      clock: CLOCK,
    });

    expect(intent).toBeNull();
    expect(writes[0]?.skip_reason).toBe('neutral_direction_while_flat');
    expect(writes[0]?.decision_class).toBe('declined_on_signal');
  });

  it('persists the compared value and the threshold on a conviction-floor decline', async () => {
    const writes: TraderDecisionRecord[] = [];
    const step = makeStep(writes);

    await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ confidence: 0.1 }),
      clock: CLOCK,
    });

    expect(writes[0]?.skip_reason).toBe('below_conviction_floor');
    expect(writes[0]?.reason_detail).toEqual({ compared_value: 0.1, threshold: 0.5 });
  });

  it('persists no decision_class and no reason_detail on an emitted order', async () => {
    const writes: TraderDecisionRecord[] = [];
    const step = makeStep(writes);

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate(),
      clock: CLOCK,
    });

    expect(intent).not.toBeNull();
    expect(writes[0]?.decision_class).toBeNull();
    expect(writes[0]?.reason_detail).toBeNull();
  });
});

describe('sizingEquity (#511)', () => {
  const CEILING = toCapitalCeilingUsd(2_000, 'test');

  it('takes the ceiling when equity exceeds it — a funded account cannot widen the run', () => {
    expect(sizingEquity(250_000, CEILING)).toBe(2_000);
  });

  it('takes real equity when it is below the ceiling — a ceiling is not a floor', () => {
    expect(sizingEquity(500, CEILING)).toBe(500);
  });

  it('leaves equity untouched when no ceiling is declared', () => {
    expect(sizingEquity(10_000, undefined)).toBe(10_000);
  });
});

describe('buildTraderStep capital ceiling (#511)', () => {
  const CEILING_CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    subclass_of: {},
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 0.01,
    whole_share_sizing: false,
    scale_in_conviction_delta: 0.1,
    early_exit: DEFAULT_EARLY_EXIT_CONFIG,
    time_in_force: { crypto: 'gtc', stocks: 'day' },
    flatten_before_close_ms: 5 * 60 * 1_000,
    flatten_after_close_ms: 5 * 60 * 1_000,
  };

  function stepWithCeiling(capitalCeilingUsd?: CapitalCeilingUsd) {
    return buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CEILING_CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      ...(capitalCeilingUsd === undefined ? {} : { capitalCeilingUsd }),
    });
  }

  async function sizeFor(capitalCeilingUsd?: CapitalCeilingUsd): Promise<number> {
    const intent = await stepWithCeiling(capitalCeilingUsd)({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate(),
      clock: CLOCK,
    });
    if (intent === null) throw new Error('expected an intent to size');
    return intent.size;
  }

  it('sizes off the ceiling, not off account equity, when equity is larger', async () => {
    const unclamped = await sizeFor(undefined);
    const clamped = await sizeFor(toCapitalCeilingUsd(1_000, 'test'));

    expect(clamped).toBeCloseTo(unclamped / 10, 10);
  });

  it('does not inflate a size when the ceiling is above real equity', async () => {
    expect(await sizeFor(toCapitalCeilingUsd(1_000_000, 'test'))).toBeCloseTo(
      await sizeFor(undefined),
      10,
    );
  });

  it('rejects instead of skipping when the CONTROL arm cannot read the account (#1089)', async () => {
    const step = buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: {
        getAccountState: async () => {
          throw new Error('account read failed');
        },
      },
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CEILING_CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
      arm: 'control',
    });

    await expect(
      step({ trace_id: TRACE_ID, instrument: 'AAPL', debate: makeDebate(), clock: CLOCK }),
    ).rejects.toThrow(/account read failed/);
  });
});

describe('buildTraderSteps exit_reason persistence (#748)', () => {
  const HELD: OpenPosition = {
    idempotency_key: 'existing-key',
    debate_id: 'debate-that-opened-the-lot',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 50,
    filled_size: 50,
    avg_entry_price: 100,
    stop: 90,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['broker-1'],
    opened_at: new Date(NOW.getTime() - 60 * 60 * 1_000),
    decision_timestamp: new Date(NOW.getTime() - 60 * 60 * 1_000),
    conviction: 0.6,
    converged: true,
  };

  const CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    subclass_of: {},
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 10,
    whole_share_sizing: false,
    scale_in_conviction_delta: 0.1,
    early_exit: DEFAULT_EARLY_EXIT_CONFIG,
    time_in_force: { crypto: 'gtc', stocks: 'day' },
    flatten_before_close_ms: 5 * 60 * 1_000,
    flatten_after_close_ms: 5 * 60 * 1_000,
  };

  it('records signal_decay on the row the exit-check path writes', async () => {
    const written: TraderDecisionRecord[] = [];
    const marketData = {
      ...FAKE_MARKET_DATA,
      getIndicator: vi.fn(async (_instrument: string, spec: IndicatorSpec) => ({
        indicator: spec.indicator,
        value: spec.indicator === 'rsi' ? 40 : -0.5,
        as_of_bar_close: NOW,
      })),
    };

    const { exitCheck } = buildTraderSteps({
      marketData,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => [HELD],
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      traderLog: { write: (record) => written.push(record) },
    });

    const intent = await exitCheck({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      clock: CLOCK,
      bar: new Date(NOW.getTime() - 60 * 60 * 1_000),
    });

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.metadata.exit_reason).toBe('signal_decay');
    expect(written).toHaveLength(1);
    expect(written[0]?.exit_reason).toBe('signal_decay');
    expect(written[0]?.intent_type).toBe('exit');
    expect(written[0]?.debate_id).toBe('debate-that-opened-the-lot');
  });
});

describe('buildTraderSteps exit-skip decision_class (#1128)', () => {
  const HELD: OpenPosition = {
    idempotency_key: 'held-lot',
    debate_id: 'debate-that-opened-the-lot',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 50,
    filled_size: 50,
    avg_entry_price: 100,
    stop: 90,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['broker-1'],
    opened_at: new Date(NOW.getTime() - 60 * 60 * 1_000),
    decision_timestamp: new Date(NOW.getTime() - 60 * 60 * 1_000),
    conviction: 0.6,
    converged: true,
  };

  const CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    subclass_of: {},
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 10,
    whole_share_sizing: false,
    scale_in_conviction_delta: 0.1,
    early_exit: DEFAULT_EARLY_EXIT_CONFIG,
    time_in_force: { crypto: 'gtc', stocks: 'day' },
    flatten_before_close_ms: 5 * 60 * 1_000,
    flatten_after_close_ms: 5 * 60 * 1_000,
  };

  const HOLDS = async (_instrument: string, spec: IndicatorSpec) => ({
    indicator: spec.indicator,
    value: spec.indicator === 'rsi' ? 60 : 0.5,
    as_of_bar_close: NOW,
  });
  const DECAYS = async (_instrument: string, spec: IndicatorSpec) => ({
    indicator: spec.indicator,
    value: spec.indicator === 'rsi' ? 40 : -0.5,
    as_of_bar_close: NOW,
  });

  function build(overrides: {
    getOpenPositions?: () => Promise<OpenPosition[]>;
    getIndicator?: typeof HOLDS;
    getExitFillSizes?: () => Promise<Map<string, number>>;
    traderLog: { write: (record: TraderDecisionRecord) => void };
  }) {
    return buildTraderSteps({
      marketData: { ...FAKE_MARKET_DATA, getIndicator: overrides.getIndicator ?? HOLDS },
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: overrides.getOpenPositions ?? (async () => [HELD]),
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: overrides.getExitFillSizes ?? (async () => new Map<string, number>()),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      traderLog: overrides.traderLog,
    });
  }

  const TICK_BAR = new Date(NOW.getTime() - 60 * 60 * 1_000);

  it('writes decision_class once across repeated ticks with the same skip reason', async () => {
    const written: TraderDecisionRecord[] = [];
    const { exitCheck } = build({ traderLog: { write: (record) => written.push(record) } });

    for (let i = 0; i < 3; i++) {
      const intent = await exitCheck({
        trace_id: `trace-${i}`,
        instrument: 'AAPL',
        clock: CLOCK,
        bar: TICK_BAR,
      });
      expect(intent).toBeNull();
    }

    expect(written).toHaveLength(1);
    expect(written[0]?.skip_reason).toBe('signal_still_supports_position');
    expect(written[0]?.decision_class).toBe('declined_on_signal');
    expect(written[0]?.debate_id).toBe('debate-that-opened-the-lot');
  });

  it('writes again when the skip reason changes', async () => {
    const written: TraderDecisionRecord[] = [];
    let indicatorImpl = HOLDS;
    const { exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getIndicator: async (instrument: string, spec: IndicatorSpec) =>
        indicatorImpl(instrument, spec),
    });

    await exitCheck({ trace_id: 'trace-a', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    indicatorImpl = async () => {
      throw new InsufficientBarsError({
        indicator: 'macd_histogram',
        period: 26,
        required: 112,
        received: 0,
      });
    };
    await exitCheck({ trace_id: 'trace-b', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });

    expect(written).toHaveLength(2);
    expect(written[0]?.skip_reason).toBe('signal_still_supports_position');
    expect(written[0]?.decision_class).toBe('declined_on_signal');
    expect(written[1]?.skip_reason).toBe('early_exit_signal_unavailable');
    expect(written[1]?.decision_class).toBe('input_unusable');
  });

  it('writes exit_no_filled_size once, then stays silent — FilledZeroSizeThrottle already covers repeats (review round 1, finding 1)', async () => {
    const written: TraderDecisionRecord[] = [];
    const { exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getIndicator: DECAYS,
      getOpenPositions: async () => [{ ...HELD, filled_size: 0, requested_size: 0 }],
    });

    for (let i = 0; i < 2; i++) {
      await exitCheck({ trace_id: `trace-${i}`, instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    }

    expect(written).toHaveLength(1);
    expect(written[0]?.skip_reason).toBe('exit_no_filled_size');
    expect(written[0]?.decision_class).toBe('input_unusable');
  });

  it('writes exit_held_quantity_diverged on a bounded repeat, not every tick, while the wedge persists (review round 1, finding 1a)', async () => {
    const written: TraderDecisionRecord[] = [];
    const { exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getIndicator: DECAYS,
      getExitFillSizes: async () => new Map([[HELD.idempotency_key, 999]]),
    });

    for (let i = 0; i < 9; i++) {
      await exitCheck({ trace_id: `trace-${i}`, instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    }

    expect(written).toHaveLength(2);
    expect(written[0]?.skip_reason).toBe('exit_held_quantity_diverged');
    expect(written[1]?.skip_reason).toBe('exit_held_quantity_diverged');
  });

  it('never writes a row for no_open_position — no lot to attribute a debate_id to', async () => {
    const written: TraderDecisionRecord[] = [];
    const { exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getOpenPositions: async () => [],
    });

    const intent = await exitCheck({
      trace_id: 'trace-flat',
      instrument: 'AAPL',
      clock: CLOCK,
      bar: TICK_BAR,
    });

    expect(intent).toBeNull();
    expect(written).toHaveLength(0);
  });

  it('writes a fresh row after a reconciliation-driven no_open_position, even with the same first skip reason (review round 1, finding 3)', async () => {
    const written: TraderDecisionRecord[] = [];
    let positions: OpenPosition[] = [HELD];
    const { exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getIndicator: HOLDS,
      getOpenPositions: async () => positions,
    });

    await exitCheck({ trace_id: 'trace-1', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    await exitCheck({ trace_id: 'trace-2', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    expect(written).toHaveLength(1);

    positions = [];
    await exitCheck({ trace_id: 'trace-flat', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    expect(written).toHaveLength(1);

    positions = [{ ...HELD, debate_id: 'debate-that-reopened-the-lot' }];
    await exitCheck({ trace_id: 'trace-3', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });

    expect(written).toHaveLength(2);
    expect(written[1]?.skip_reason).toBe('signal_still_supports_position');
    expect(written[1]?.debate_id).toBe('debate-that-reopened-the-lot');
  });

  it('bounds writes when the skip reason flaps every tick, instead of writing on every change (review round 1, finding 1b)', async () => {
    const written: TraderDecisionRecord[] = [];
    let toggle = false;
    const flapping = async (instrument: string, spec: IndicatorSpec) => {
      if (toggle) return HOLDS(instrument, spec);
      throw new InsufficientBarsError({
        indicator: 'macd_histogram',
        period: 26,
        required: 112,
        received: 0,
      });
    };
    const { exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getIndicator: flapping,
    });

    for (let i = 0; i < 10; i++) {
      toggle = !toggle;
      await exitCheck({ trace_id: `trace-${i}`, instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    }

    expect(written).toHaveLength(4);
    expect(written.map((record) => record.skip_reason)).toEqual([
      'signal_still_supports_position',
      'early_exit_signal_unavailable',
      'signal_still_supports_position',
      'early_exit_signal_unavailable',
    ]);
  });

  it('writes a fresh row after an exit fires, even when the reopened lot hits the same first skip reason (review round 1, finding 2/3)', async () => {
    const written: TraderDecisionRecord[] = [];
    let indicatorImpl = HOLDS;
    let positions: OpenPosition[] = [HELD];
    const { exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getIndicator: async (instrument: string, spec: IndicatorSpec) =>
        indicatorImpl(instrument, spec),
      getOpenPositions: async () => positions,
    });

    await exitCheck({ trace_id: 'trace-1', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });

    indicatorImpl = DECAYS;
    const exitIntent = await exitCheck({
      trace_id: 'trace-2',
      instrument: 'AAPL',
      clock: CLOCK,
      bar: TICK_BAR,
    });
    expect(exitIntent).not.toBeNull();

    positions = [{ ...HELD, debate_id: 'debate-that-reopened-the-lot' }];
    indicatorImpl = HOLDS;
    await exitCheck({ trace_id: 'trace-3', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });

    expect(written).toHaveLength(3);
    expect(written[2]?.skip_reason).toBe('signal_still_supports_position');
    expect(written[2]?.debate_id).toBe('debate-that-reopened-the-lot');
  });

  it('writes a fresh row after the DECISION path fires the exit, even when the reopened lot hits the same first skip reason (review round 3, finding 3)', async () => {
    const written: TraderDecisionRecord[] = [];
    let positions: OpenPosition[] = [HELD];
    const { trader, exitCheck } = build({
      traderLog: { write: (record) => written.push(record) },
      getIndicator: HOLDS,
      getOpenPositions: async () => positions,
    });

    await exitCheck({ trace_id: 'trace-1', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });
    expect(written).toHaveLength(1);

    const exitIntent = await trader({
      trace_id: 'trace-2',
      instrument: 'AAPL',
      debate: makeDebate({ direction: 'bearish', confidence: 0.8, converged: true }),
      clock: CLOCK,
    });
    expect(exitIntent?.intent_type).toBe('exit');
    expect(written).toHaveLength(2);

    positions = [{ ...HELD, debate_id: 'debate-that-reopened-the-lot' }];
    await exitCheck({ trace_id: 'trace-3', instrument: 'AAPL', clock: CLOCK, bar: TICK_BAR });

    expect(written).toHaveLength(3);
    expect(written[2]?.skip_reason).toBe('signal_still_supports_position');
    expect(written[2]?.debate_id).toBe('debate-that-reopened-the-lot');
  });
});

describe('buildTraderSteps unpriced flatten escalation (#826)', () => {
  const INSIDE_WINDOW = new Date('2026-07-28T19:56:00Z');
  const WINDOW_CLOCK: Clock = { now: () => INSIDE_WINDOW };
  const TICK_BAR = new Date('2026-07-28T19:00:00Z');
  const STALL = 'alpaca: request timed out after 3 attempts';

  const HELD: OpenPosition = {
    idempotency_key: 'held-lot',
    debate_id: 'debate-that-opened-the-lot',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 50,
    filled_size: 50,
    avg_entry_price: 100,
    stop: 90,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['broker-1'],
    opened_at: new Date(INSIDE_WINDOW.getTime() - 6 * 60 * 60 * 1_000),
    decision_timestamp: new Date(INSIDE_WINDOW.getTime() - 6 * 60 * 60 * 1_000),
    conviction: 0.6,
    converged: true,
  };

  const CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    subclass_of: {},
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 10,
    whole_share_sizing: false,
    scale_in_conviction_delta: 0.1,
    early_exit: DEFAULT_EARLY_EXIT_CONFIG,
    time_in_force: { crypto: 'gtc', stocks: 'day' },
    flatten_before_close_ms: 5 * 60 * 1_000,
    flatten_after_close_ms: 5 * 60 * 1_000,
  };

  function buildExitCheck(overrides: { exitValuationAlerts?: ExitValuationDegradedAlertChannel }) {
    return buildTraderSteps({
      marketData: {
        ...FAKE_MARKET_DATA,
        getMark: vi.fn(async () => {
          throw new Error(STALL);
        }),
      },
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => [HELD],
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      ...overrides,
    }).exitCheck;
  }

  it('still emits the flatten, unpriced, when the tick path cannot read a mark', async () => {
    const exitCheck = buildExitCheck({});

    const intent = await exitCheck({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      clock: WINDOW_CLOCK,
      bar: TICK_BAR,
    });

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.metadata.exit_reason).toBe('flatten');
    expect(intent?.metadata.unpriced_exit).toBe(true);
    expect(intent?.size).toBe(50);
    expect(intent?.entry).toBe(0);
  });

  it('pages the operator through the channel this root owns', async () => {
    const posted: ExitValuationDegradedAlert[] = [];
    const exitCheck = buildExitCheck({
      exitValuationAlerts: {
        postExitValuationDegradedAlert: (alert) => posted.push(alert),
      },
    });

    await exitCheck({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      clock: WINDOW_CLOCK,
      bar: TICK_BAR,
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.seam).toBe('trader');
    expect(posted[0]?.instrument).toBe('AAPL');
    expect(posted[0]?.unvalued_instruments).toEqual(['AAPL']);
    expect(posted[0]?.reason).toContain('timed out');
    expect(posted[0]?.reported_at).toEqual(INSIDE_WINDOW);
  });

  it('pages the operator when the DECISION path decides the unpriced flatten', async () => {
    const posted: ExitValuationDegradedAlert[] = [];
    const { trader } = buildTraderSteps({
      marketData: {
        ...FAKE_MARKET_DATA,
        getMark: vi.fn(async () => {
          throw new Error(STALL);
        }),
      },
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => [HELD],
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      exitValuationAlerts: {
        postExitValuationDegradedAlert: (alert) => posted.push(alert),
      },
    });

    const intent = await trader({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ direction: 'neutral', synthesis: 'neutral', bar_timestamp: TICK_BAR }),
      clock: WINDOW_CLOCK,
    });

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.metadata.exit_reason).toBe('flatten');
    expect(intent?.metadata.unpriced_exit).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.seam).toBe('trader');
    expect(posted[0]?.instrument).toBe('AAPL');
    expect(posted[0]?.unvalued_instruments).toEqual(['AAPL']);
    expect(posted[0]?.reason).toContain('timed out');
  });

  it('does not page when the mark reads cleanly', async () => {
    const posted: ExitValuationDegradedAlert[] = [];
    const exitCheck = buildTraderSteps({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => [HELD],
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      exitValuationAlerts: {
        postExitValuationDegradedAlert: (alert) => posted.push(alert),
      },
    }).exitCheck;

    const intent = await exitCheck({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      clock: WINDOW_CLOCK,
      bar: TICK_BAR,
    });

    expect(intent?.metadata.exit_reason).toBe('flatten');
    expect(intent?.metadata.unpriced_exit).toBeUndefined();
    expect(posted).toHaveLength(0);
  });
});

describe('buildTraderStep diagnostic escalation (#698, #710)', () => {
  const BROKEN_STOCKS_CALENDAR: TradingCalendar = {
    isOpen: () => true,
    isTradingDay: () => true,
    sessionStart: (instant: Date) => instant,
    sessionEnd: () => null,
  };

  const CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    subclass_of: {},
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 10,
    whole_share_sizing: false,
    scale_in_conviction_delta: 0.1,
    early_exit: DEFAULT_EARLY_EXIT_CONFIG,
    time_in_force: { crypto: 'gtc', stocks: 'day' },
    flatten_before_close_ms: 5 * 60 * 1_000,
    flatten_after_close_ms: 5 * 60 * 1_000,
  };

  function buildStep(options: {
    logger?: Logger;
    traderDiagnosticAlerts?: TraderDiagnosticAlertChannel;
  }) {
    return buildTraderStep({
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: BROKEN_STOCKS_CALENDAR,
      },
      ...options,
    });
  }

  function collectingLogger(): { logger: Logger; entries: LogEntry[] } {
    const entries: LogEntry[] = [];
    return { logger: { log: (entry) => entries.push(entry) }, entries };
  }

  function diagnosticLines(entries: readonly LogEntry[]): LogEntry[] {
    return entries.filter(
      (entry) =>
        entry.stage === 'trader' &&
        entry.level === 'error' &&
        entry.message.includes('session_end_absent_on_non_crypto'),
    );
  }

  it('does not wait for the alert transport before returning the intent', async () => {
    let posted = 0;
    const step = buildStep({
      traderDiagnosticAlerts: {
        postTraderDiagnosticAlert: () => {
          posted += 1;
          return new Promise<void>(() => {});
        },
      },
    });

    await step({ trace_id: TRACE_ID, instrument: 'AAPL', debate: makeDebate(), clock: CLOCK });

    expect(posted).toBe(1);
  });

  it('logs the condition on every tick while alerting on a bounded interval', async () => {
    const { logger, entries } = collectingLogger();
    let posted = 0;
    const step = buildStep({
      logger,
      traderDiagnosticAlerts: {
        postTraderDiagnosticAlert: async () => {
          posted += 1;
        },
      },
    });

    for (let tick = 0; tick < 3; tick += 1) {
      await step({ trace_id: TRACE_ID, instrument: 'AAPL', debate: makeDebate(), clock: CLOCK });
    }

    expect(diagnosticLines(entries)).toHaveLength(3);
    expect(diagnosticLines(entries)[2]?.message).toContain('3 consecutive tick(s)');
    expect(posted).toBe(1);
  });

  it('logs under the TICK trace, not a synthetic constant', async () => {
    const { logger, entries } = collectingLogger();

    await buildStep({ logger })({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate(),
      clock: CLOCK,
    });

    expect(diagnosticLines(entries)).toHaveLength(1);
    expect(diagnosticLines(entries)[0]?.trace_id).toBe(TRACE_ID);
  });

  it('still logs with no channel wired, since the log is the record and the alert is a copy', async () => {
    const { logger, entries } = collectingLogger();

    await buildStep({ logger })({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate(),
      clock: CLOCK,
    });

    expect(diagnosticLines(entries)).toHaveLength(1);
  });
});

describe('buildRiskStep', () => {
  const RISK_CONFIG: RiskConfig = {
    max_position_size_fraction_of_equity: 10,
    per_asset_cap_fraction_of_equity: 10,
    per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 10 },
    portfolio_gross_cap_fraction_of_equity: 20,
    concentration: { cap_fraction_of_equity: 10, threshold: 0.9 },
    min_viable_size: 1,
    whole_share_sizing: false,
    cii_threshold: 80,
    max_mark_age: TEST_MAX_MARK_AGE,
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
      decided_at: NOW,
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
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      critic: undefined,
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.instrument).toBe('AAPL');
    expect(decision.next_breaker_state).toHaveLength(2);
  });

  it('#1019: a sibling write-ahead order with no fill yet still consumes the gross cap, end to end from getOpenPositions', async () => {
    const writeAhead: OpenPosition = {
      idempotency_key: 'MSFT-write-ahead',
      debate_id: 'debate-sibling',
      instrument: 'MSFT',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 65,
      filled_size: 0,
      avg_entry_price: 0,
      stop: 95,
      target: 110,
      order_state: 'pending',
      broker_order_ids: [],
      opened_at: NOW,
      decision_timestamp: NOW,
      conviction: 0.8,
      converged: true,
    };

    const step = buildRiskStep({
      config: { ...RISK_CONFIG, portfolio_gross_cap_fraction_of_equity: 0.7 },
      correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
      ciiConsumer: { getScores: vi.fn(() => ({})) },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => [writeAhead],
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      critic: undefined,
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.size).toBe(5);
    expect(decision.binding_constraint).toBe('portfolio_gross_exposure_cap');
    expect(decision.risk_snapshot.exposure.portfolio).toBe(0);
  });

  it("#1019: next_breaker_state is the state of THIS pass's own observation, not whatever the shared instance holds after the await", async () => {
    const circuitBreakers = new CircuitBreakers({
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    });
    const mine: PersistedBreakerState[] = [
      {
        tier: 'portfolio_drawdown',
        tripped: false,
        tripped_at: null,
        reset_at: null,
        reason: null,
      },
    ];
    const siblings: PersistedBreakerState[] = [
      {
        tier: 'portfolio_drawdown',
        tripped: true,
        tripped_at: CLOCK.now(),
        reset_at: null,
        reason: 'a sibling instrument tripped it between the await and the read',
      },
    ];
    let reads = 0;
    vi.spyOn(circuitBreakers, 'getPersistedState').mockImplementation(() => {
      reads += 1;
      return reads === 1 ? mine : siblings;
    });
    const saved: PersistedBreakerState[][] = [];

    const step = buildRiskStep({
      config: RISK_CONFIG,
      correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
      ciiConsumer: { getScores: vi.fn(() => ({})) },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers,
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: { save: (state: PersistedBreakerState[]) => saved.push(state) },
      portfolioSnapshots: new Map(),
      critic: undefined,
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.next_breaker_state).toStrictEqual(mine);
    expect(saved).toStrictEqual([mine]);
  });

  it('rejects when the portfolio circuit breaker is already tripped (sticky state honored)', async () => {
    const circuitBreakers = new CircuitBreakers({
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    });
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
          } as const,
          consecutive_losses: 0,
        })),
      },
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      critic: undefined,
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });

  it('#740: persists a below-viable-size refusal to risk_log with a binding_constraint distinct from a circuit-breaker refusal', async () => {
    const writes: unknown[] = [];
    const riskLog = { write: (record: unknown) => writes.push(record) };

    const sizeStep = buildRiskStep({
      config: {
        ...RISK_CONFIG,
        per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 0.0005 },
        min_viable_size: 100,
        whole_share_sizing: false,
      },
      correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
      ciiConsumer: { getScores: vi.fn(() => ({})) },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      critic: undefined,
      riskLog,
    });

    const sizeDecision = await sizeStep({
      trace_id: TRACE_ID,
      intent: makeIntent({ size: 10, entry: 100 }),
      clock: CLOCK,
    });

    expect(sizeDecision.status).toBe('rejected');
    expect(sizeDecision.binding_constraint).toBe('min_viable_size');
    expect(sizeDecision.order_intent).toBeNull();

    const breakerStep = buildRiskStep({
      config: RISK_CONFIG,
      correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
      ciiConsumer: { getScores: vi.fn(() => ({})) },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: {
        getAccountState: vi.fn(async () => ({
          cash: 0,
          peak_equity: 1_000_000,
          daily_basis: {
            crypto: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
            stocks: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
            portfolio: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
          } as const,
          consecutive_losses: 0,
        })),
      },
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      critic: undefined,
      riskLog,
    });

    const breakerDecision = await breakerStep({
      trace_id: TRACE_ID,
      intent: makeIntent(),
      clock: CLOCK,
    });

    expect(breakerDecision.status).toBe('rejected');
    expect(breakerDecision.binding_constraint).toBe('circuit_breaker:portfolio');

    expect(writes).toHaveLength(2);
    const [sizeRow, breakerRow] = writes as Array<{
      status: string;
      binding_constraint: string | null;
    }>;
    expect(sizeRow.status).toBe('rejected');
    expect(breakerRow.status).toBe('rejected');
    expect(sizeRow.binding_constraint).toBe('min_viable_size');
    expect(breakerRow.binding_constraint).toBe('circuit_breaker:portfolio');
    expect(sizeRow.binding_constraint).not.toBe(breakerRow.binding_constraint);
  });

  describe('#726: risk_log on the per-subclass cap gate throw', () => {
    const ARMED_CAP_CONFIG: RiskConfig = {
      ...RISK_CONFIG,
      per_subclass_deployment_cap: {
        subclass_of: {},
        cap_fraction_of_equity: { index_etp_3x: 0.1, single_stock_etp_3x: 0.1, crypto: null },
      },
    };

    function makeRiskLog() {
      const writes: unknown[] = [];
      return { store: { write: (record: unknown) => writes.push(record) }, writes };
    }

    function buildStep(riskLog: ReturnType<typeof makeRiskLog>['store']) {
      return buildRiskStep({
        config: ARMED_CAP_CONFIG,
        correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
        ciiConsumer: { getScores: vi.fn(() => ({})) },
        marketData: FAKE_MARKET_DATA,
        circuitBreakers: new CircuitBreakers({
          daily_loss_pct: 0.05,
          daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
          max_drawdown_pct: 0.2,
          max_consecutive_losses: 5,
          volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
          auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
        }),
        accountState: FAKE_ACCOUNT_STATE,
        volatility: FAKE_VOLATILITY,
        getOpenPositions: async () => NO_POSITIONS,
        maxMarkAge: TEST_MAX_MARK_AGE,
        mode: 'paper',
        breakerState: NOOP_BREAKER_STATE,
        portfolioSnapshots: new Map(),
        critic: undefined,
        riskLog,
      });
    }

    it('writes a risk_log row naming the unclassified subclass, then re-throws unchanged', async () => {
      const { store, writes } = makeRiskLog();
      const step = buildStep(store);

      await expect(
        step({ trace_id: TRACE_ID, intent: makeIntent({ intent_type: 'entry' }), clock: CLOCK }),
      ).rejects.toThrow(/AAPL has no subclass/);

      expect(writes).toHaveLength(1);
      const row = writes[0] as {
        trace_id: string;
        instrument: string;
        status: string;
        binding_constraint: string | null;
      };
      expect(row.trace_id).toBe(TRACE_ID);
      expect(row.instrument).toBe('AAPL');
      expect(row.status).toBe('error');
      expect(row.binding_constraint).toBe(
        'per_subclass_deployment_cap:unclassified_instrument:AAPL',
      );
    });

    it('still returns before the entry-gate loop on an exit, even with the same armed-but-unclassified config', async () => {
      const { store, writes } = makeRiskLog();
      const step = buildStep(store);

      const decision = await step({
        trace_id: TRACE_ID,
        intent: makeIntent({ intent_type: 'exit' }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(decision.binding_constraint).toBeNull();
      expect(writes).toHaveLength(1);
      expect((writes[0] as { status: string }).status).toBe('approved');
    });

    it('propagates the original gate error unchanged even if the risk_log write itself throws', async () => {
      const step = buildStep({
        write: () => {
          throw new Error('boom');
        },
      });

      await expect(
        step({ trace_id: TRACE_ID, intent: makeIntent({ intent_type: 'entry' }), clock: CLOCK }),
      ).rejects.toThrow(/AAPL has no subclass/);
    });
  });

  describe('#766: threshold-clamp trip alert', () => {
    function makeAlerts() {
      const posted: unknown[] = [];
      return {
        channel: { postThresholdClampAlert: (alert: unknown) => posted.push(alert) },
        posted,
      };
    }

    function buildStep(overrides: {
      thresholdClampAlerts?: ReturnType<typeof makeAlerts>['channel'];
    }) {
      return buildRiskStep({
        config: RISK_CONFIG,
        correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
        ciiConsumer: { getScores: vi.fn(() => ({})) },
        marketData: FAKE_MARKET_DATA,
        circuitBreakers: new CircuitBreakers({
          daily_loss_pct: 0.05,
          daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
          max_drawdown_pct: 0.2,
          max_consecutive_losses: 5,
          volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
          auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
        }),
        accountState: FAKE_ACCOUNT_STATE,
        volatility: FAKE_VOLATILITY,
        getOpenPositions: async () => NO_POSITIONS,
        maxMarkAge: TEST_MAX_MARK_AGE,
        mode: 'paper',
        breakerState: NOOP_BREAKER_STATE,
        portfolioSnapshots: new Map(),
        critic: undefined,
        thresholds: { getRiskThresholds: () => ({ max_pbo: 0.5 }) },
        ...overrides,
      });
    }

    it('posts a threshold-clamp alert and still re-throws the original refusal', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({ thresholdClampAlerts: channel });

      await expect(
        step({ trace_id: TRACE_ID, intent: makeIntent({ intent_type: 'entry' }), clock: CLOCK }),
      ).rejects.toThrow(/in-code clamp/);

      expect(posted).toHaveLength(1);
      expect((posted[0] as { where: string }).where).toBe('live-read');
      expect((posted[0] as { message: string }).message).toMatch(/max_pbo/);
      expect((posted[0] as { trace_id: string }).trace_id).toBe(TRACE_ID);
    });

    it('proves by removal: with no channel injected, the step still refuses (fail-closed unaffected)', async () => {
      const step = buildStep({});

      await expect(
        step({ trace_id: TRACE_ID, intent: makeIntent({ intent_type: 'entry' }), clock: CLOCK }),
      ).rejects.toThrow(/in-code clamp/);
    });

    it('does not post — and does not throw — for an exit intent under the same bad table (#766)', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({ thresholdClampAlerts: channel });

      const decision = await step({
        trace_id: TRACE_ID,
        intent: makeIntent({ intent_type: 'exit' }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(posted).toHaveLength(0);
    });

    it('latches after the first trip — a second crashed instrument does not double-page', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({ thresholdClampAlerts: channel });

      await expect(
        step({ trace_id: TRACE_ID, intent: makeIntent({ intent_type: 'entry' }), clock: CLOCK }),
      ).rejects.toThrow();
      await expect(
        step({
          trace_id: 'trace-2',
          intent: makeIntent({ instrument: 'MSFT', intent_type: 'entry' }),
          clock: CLOCK,
        }),
      ).rejects.toThrow();

      expect(posted).toHaveLength(1);
    });
  });

  describe('#841: the exit path must not require a whole-book valuation', () => {
    function makeHeld(instrument: string): OpenPosition {
      return {
        idempotency_key: `held-${instrument}`,
        debate_id: 'debate-1',
        instrument,
        asset_class: 'stocks',
        side: 'buy',
        intent_type: 'entry',
        requested_size: 10,
        filled_size: 10,
        avg_entry_price: 90,
        stop: 80,
        target: 120,
        order_state: 'filled',
        broker_order_ids: [],
        opened_at: NOW,
        decision_timestamp: NOW,
        conviction: 0.8,
        converged: true,
      };
    }

    const HELD = [makeHeld('AAPL'), makeHeld('DARK')];

    const DARK_MARKET_DATA = {
      ...FAKE_MARKET_DATA,
      getMarks: vi.fn(async (instruments: readonly string[], asOf: Date) =>
        collectMarks(
          async (instrument: string, at: Date) => {
            if (instrument === 'DARK') throw new Error('feed timeout for DARK');
            return FAKE_GET_MARK(instrument, at);
          },
          instruments,
          asOf,
        ),
      ),
    };

    function makeAlerts() {
      const posted: ExitValuationDegradedAlert[] = [];
      return {
        channel: {
          postExitValuationDegradedAlert: (alert: ExitValuationDegradedAlert) => posted.push(alert),
        },
        posted,
      };
    }

    function makeBreakers() {
      return new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      });
    }

    function buildStep(
      overrides: Partial<Parameters<typeof buildRiskStep>[0]> = {},
    ): ReturnType<typeof buildRiskStep> {
      return buildRiskStep({
        config: RISK_CONFIG,
        correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
        ciiConsumer: { getScores: vi.fn(() => ({})) },
        marketData: DARK_MARKET_DATA,
        circuitBreakers: makeBreakers(),
        accountState: FAKE_ACCOUNT_STATE,
        volatility: FAKE_VOLATILITY,
        getOpenPositions: async () => HELD,
        maxMarkAge: TEST_MAX_MARK_AGE,
        mode: 'paper',
        breakerState: NOOP_BREAKER_STATE,
        portfolioSnapshots: new Map(),
        critic: undefined,
        ...overrides,
      });
    }

    it('flattens the freshly-marked name even though another held instrument is dark', async () => {
      const riskLogRows: { portfolio: { gross_exposure: number } }[] = [];
      const step = buildStep({
        riskLog: { write: (row) => riskLogRows.push(row as never) },
      });

      const decision = await step({
        trace_id: TRACE_ID,
        intent: makeIntent({ intent_type: 'exit', instrument: 'AAPL' }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(decision.order_intent?.instrument).toBe('AAPL');
      expect(riskLogRows[0]?.portfolio.gross_exposure).toBe(1_000);
    });

    it('escalates the degradation rather than only logging it', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({ exitValuationAlerts: channel });

      await step({
        trace_id: TRACE_ID,
        intent: makeIntent({ intent_type: 'exit', instrument: 'AAPL' }),
        clock: CLOCK,
      });

      expect(posted).toHaveLength(1);
      expect(posted[0]?.instrument).toBe('AAPL');
      expect(posted[0]?.seam).toBe('risk');
      expect(posted[0]?.unvalued_instruments).toEqual(['DARK']);
      expect(posted[0]?.reason).toMatch(/DARK/);
      expect(posted[0]?.reason).toMatch(/feed timeout/);
    });

    it('does not alert when the whole book values cleanly — the strict path is still the norm', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({
        marketData: FAKE_MARKET_DATA,
        getOpenPositions: async () => [makeHeld('AAPL')],
        exitValuationAlerts: channel,
      });

      const decision = await step({
        trace_id: TRACE_ID,
        intent: makeIntent({ intent_type: 'exit', instrument: 'AAPL' }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(posted).toHaveLength(0);
    });

    it('re-raises an exit failure the degraded attempt cannot explain, instead of swallowing it', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({
        marketData: FAKE_MARKET_DATA,
        getOpenPositions: async () => [makeHeld('AAPL')],
        volatility: {
          getVolatilityReading: async () => {
            throw new Error('volatility feed unavailable');
          },
        },
        exitValuationAlerts: channel,
      });

      await expect(
        step({
          trace_id: TRACE_ID,
          intent: makeIntent({ intent_type: 'exit', instrument: 'AAPL' }),
          clock: CLOCK,
        }),
      ).rejects.toThrow(/volatility feed unavailable/);
      expect(posted).toHaveLength(0);
    });

    it('does NOT degrade for an entry — the whole-book refusal still stands and still throws', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({ exitValuationAlerts: channel });

      await expect(
        step({
          trace_id: TRACE_ID,
          intent: makeIntent({ intent_type: 'entry', instrument: 'AAPL' }),
          clock: CLOCK,
        }),
      ).rejects.toThrow(/DARK/);
      expect(posted).toHaveLength(0);
    });

    it('a degraded valuation cannot trip — or persist — the sticky drawdown breaker', async () => {
      const saved: unknown[] = [];
      const circuitBreakers = makeBreakers();
      const step = buildStep({
        circuitBreakers,
        breakerState: { save: (state) => saved.push(state) },
        accountState: {
          getAccountState: vi.fn(async () => ({
            cash: 10_000,
            peak_equity: 1_000_000,
            daily_basis: {
              crypto: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
              stocks: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
              portfolio: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
            } as const,
            consecutive_losses: 0,
          })),
        },
      });

      const decision = await step({
        trace_id: TRACE_ID,
        intent: makeIntent({ intent_type: 'exit', instrument: 'AAPL' }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(decision.risk_snapshot.armed_breakers).toEqual([]);
      expect(
        circuitBreakers
          .getPersistedState()
          .some((row) => row.tier === 'portfolio_drawdown' && row.tripped),
      ).toBe(false);
      expect(saved).toHaveLength(0);
    });
  });

  describe('risk critic (#957)', () => {
    const BREAKER_CONFIG = {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    } as const;

    function recordingCritic(verdict?: RiskCriticVerdict): {
      critic: RiskCriticProducer;
      asks: { instrument: string; held: string[] }[];
    } {
      const asks: { instrument: string; held: string[] }[] = [];
      return {
        asks,
        critic: {
          produce: async (request) => {
            asks.push({
              instrument: request.intent.instrument,
              held: request.portfolio.held.map((position) => position.instrument),
            });
            return verdict;
          },
        },
      };
    }

    function unvaluedSnapshot(): PortfolioSnapshot {
      const known = { known: true, pct: 0 } as const;
      return {
        portfolio: {
          equity: 10_000,
          peak_equity: 10_000,
          drawdown_pct: 0,
          exposure_by_instrument: {},
          exposure_by_class: { crypto: 0, stocks: 0 },
          gross_exposure: 0,
          reserved_exposure_by_instrument: {},
          reserved_exposure_by_class: { crypto: 0, stocks: 0 },
          reserved_gross_exposure: 0,
          daily_pnl: { crypto: known, stocks: known, portfolio: known },
          consecutive_losses: 0,
          unvalued_instruments: ['DARK'],
        },
        breakers: {
          portfolio_tripped: false,
          asset_class_tripped: { crypto: false, stocks: false },
          armed_breakers: [],
        },
        next_breaker_state: [],
      };
    }

    function step(
      overrides: {
        critic?: RiskCriticProducer;
        config?: RiskConfig;
        peakEquity?: number;
        riskLog?: { write: (record: unknown) => void };
        portfolioSnapshots?: Map<string, PortfolioSnapshot>;
      } = {},
    ) {
      return buildRiskStep({
        config: overrides.config ?? RISK_CONFIG,
        correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
        ciiConsumer: { getScores: vi.fn(() => ({})) },
        marketData: FAKE_MARKET_DATA,
        circuitBreakers: new CircuitBreakers(BREAKER_CONFIG),
        accountState:
          overrides.peakEquity === undefined
            ? FAKE_ACCOUNT_STATE
            : {
                getAccountState: vi.fn(async () => ({
                  cash: 0,
                  peak_equity: overrides.peakEquity as number,
                  daily_basis: {
                    crypto: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
                    stocks: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
                    portfolio: { known: true, open_equity: 1_000_000, realized_pnl: 0 },
                  } as const,
                  consecutive_losses: 0,
                })),
              },
        volatility: FAKE_VOLATILITY,
        getOpenPositions: async () => NO_POSITIONS,
        maxMarkAge: TEST_MAX_MARK_AGE,
        mode: 'paper',
        breakerState: NOOP_BREAKER_STATE,
        portfolioSnapshots: overrides.portfolioSnapshots ?? new Map(),
        critic: overrides.critic,
        ...(overrides.riskLog === undefined ? {} : { riskLog: overrides.riskLog }),
      });
    }

    it('consults the critic on a viable entry, and shows it the book', async () => {
      const { critic, asks } = recordingCritic();

      await step({ critic })({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

      expect(asks).toHaveLength(1);
      expect(asks[0]?.instrument).toBe('AAPL');
      expect(asks[0]?.held).toBeDefined();
    });

    it('a reject verdict binds the decision, with the critic’s own words in the record', async () => {
      const writes: { binding_constraint: string | null; reasons: string[] }[] = [];
      const { critic } = recordingCritic({
        verdict: 'reject',
        max_notional: null,
        reasoning: 'every open leg rides the same CPI print',
      });

      const decision = await step({
        critic,
        riskLog: { write: (record) => writes.push(record as (typeof writes)[number]) },
      })({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

      expect(decision.status).toBe('rejected');
      expect(decision.binding_constraint).toBe('risk_critic:reject');
      expect(decision.reasons.join(' ')).toContain('same CPI print');
      expect(writes).toHaveLength(1);
      expect(writes[0]?.binding_constraint).toBe('risk_critic:reject');
    });

    it('a trim verdict only ever reduces the position', async () => {
      const { critic } = recordingCritic({
        verdict: 'trim',
        max_notional: 400,
        reasoning: 'halve it until the print lands',
      });

      const decision = await step({ critic })({
        trace_id: TRACE_ID,
        intent: makeIntent({ size: 10, entry: 100 }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(decision.binding_constraint).toBe('risk_critic:trim');
      expect(decision.order_intent?.size).toBe(4);
    });

    it('no verdict leaves the decision on the mechanical steps, by record', async () => {
      const { critic } = recordingCritic(undefined);

      const decision = await step({ critic })({
        trace_id: TRACE_ID,
        intent: makeIntent(),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(decision.reasons).toContain(RISK_CRITIC_SKIPPED_REASON);
    });

    it('a producer that THROWS does not take the tick down', async () => {
      const decision = await step({
        critic: {
          produce: () => Promise.reject(new Error('producer exploded')),
        },
      })({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

      expect(decision.status).toBe('approved');
      expect(decision.reasons).toContain(RISK_CRITIC_SKIPPED_REASON);
    });

    it('with no producer wired at all, nothing changes from before #957', async () => {
      const decision = await step()({
        trace_id: TRACE_ID,
        intent: makeIntent(),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(decision.reasons).toContain(RISK_CRITIC_SKIPPED_REASON);
    });

    it('never pays for an EXIT — exits bypass the entry gates and never reach step 7', async () => {
      const { critic, asks } = recordingCritic();

      const decision = await step({ critic })({
        trace_id: TRACE_ID,
        intent: makeIntent({ intent_type: 'exit' }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(asks).toHaveLength(0);
    });

    it('never pays for an entry a circuit breaker already refused', async () => {
      const { critic, asks } = recordingCritic();

      const decision = await step({ critic, peakEquity: 1_000_000 })({
        trace_id: TRACE_ID,
        intent: makeIntent(),
        clock: CLOCK,
      });

      expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
      expect(asks).toHaveLength(0);
    });

    it('never pays for an entry the unvalued-book gate already refused', async () => {
      const { critic, asks } = recordingCritic();
      const snapshots = new Map<string, PortfolioSnapshot>([[TRACE_ID, unvaluedSnapshot()]]);

      const decision = await step({ critic, portfolioSnapshots: snapshots })({
        trace_id: TRACE_ID,
        intent: makeIntent(),
        clock: CLOCK,
      });

      expect(decision.status).toBe('rejected');
      expect(decision.binding_constraint).toBe('unvalued_book');
      expect(decision.reasons).not.toContain(RISK_CRITIC_SKIPPED_REASON);
      expect(asks).toHaveLength(0);
    });

    it('DOES pay once the same intent’s book is fully valued — the gate is what excluded it', async () => {
      const { critic, asks } = recordingCritic();

      const decision = await step({ critic })({
        trace_id: TRACE_ID,
        intent: makeIntent(),
        clock: CLOCK,
      });

      expect(decision.binding_constraint).not.toBe('unvalued_book');
      expect(asks).toHaveLength(1);
    });

    it('never pays for an entry trimmed below the min-viable floor', async () => {
      const { critic, asks } = recordingCritic();

      const decision = await step({
        critic,
        config: {
          ...RISK_CONFIG,
          per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 0.0005 },
          min_viable_size: 100,
        },
      })({ trace_id: TRACE_ID, intent: makeIntent({ size: 10, entry: 100 }), clock: CLOCK });

      expect(decision.binding_constraint).toBe('min_viable_size');
      expect(asks).toHaveLength(0);
    });
  });
});

describe('buildVerdictStep', () => {
  const VERDICT_CONFIG: VerdictConfig = {
    automation_level: { crypto: 'auto', stocks: 'auto' },
    max_signal_age: { crypto: 60_000, stocks: 60_000 },
    max_mark_age: TEST_MAX_MARK_AGE,
    drift_tolerance_pct: { crypto: 0.05, stocks: 0.05 },
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
        decided_at: NOW,
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
      approvals: { requestApproval: vi.fn(async (): Promise<ApprovalOutcome> => 'approved') },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      store: db,
    });

    const result: VerdictDecision = await step({
      trace_id: TRACE_ID,
      risk_decision: riskDecision as never,
      clock: CLOCK,
    });

    expect(result.status).toBe('go');
  });

  it('#841: an EXIT still reaches a verdict when one held instrument cannot be valued', async () => {
    const held: OpenPosition = {
      idempotency_key: 'held-DARK',
      debate_id: 'debate-1',
      instrument: 'DARK',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10,
      filled_size: 10,
      avg_entry_price: 90,
      stop: 80,
      target: 120,
      order_state: 'filled',
      broker_order_ids: [],
      opened_at: NOW,
      decision_timestamp: NOW,
      conviction: 0.8,
      converged: true,
    };
    const darkMarketData = {
      ...FAKE_MARKET_DATA,
      getMarks: vi.fn(async (instruments: readonly string[], asOf: Date) =>
        collectMarks(
          async (instrument: string, at: Date) => {
            if (instrument === 'DARK') throw new Error('feed timeout for DARK');
            return FAKE_GET_MARK(instrument, at);
          },
          instruments,
          asOf,
        ),
      ),
    };
    const posted: ExitValuationDegradedAlert[] = [];

    const riskDecision = {
      status: 'approved' as const,
      order_intent: {
        idempotency_key: 'key-exit-841',
        instrument: 'AAPL',
        asset_class: 'stocks' as const,
        side: 'sell' as const,
        intent_type: 'exit' as const,
        size: 10,
        entry: 100,
        stop: 95,
        target: 110,
        time_in_force: 'day',
        decision_timestamp: NOW,
        decided_at: NOW,
        metadata: {
          debate_id: 'debate-1',
          conviction: 0.8,
          converged: true,
          exit_reason: 'flatten',
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

    const db = openSharedStore(':memory:');
    const step = buildVerdictStep({
      tradingCalendar: { isOpen: () => true, hasSession: () => true } as never,
      positionStore: { findByKey: vi.fn(async () => false) },
      config: VERDICT_CONFIG,
      approvals: { requestApproval: vi.fn(async (): Promise<ApprovalOutcome> => 'approved') },
      marketData: darkMarketData,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => [held],
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      exitValuationAlerts: {
        postExitValuationDegradedAlert: (alert) => posted.push(alert),
      },
      store: db,
    });

    const result: VerdictDecision = await step({
      trace_id: TRACE_ID,
      risk_decision: riskDecision as never,
      clock: CLOCK,
    });

    expect(result.status).toBe('go');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.seam).toBe('verdict');
    expect(posted[0]?.unvalued_instruments).toEqual(['DARK']);
  });

  it('#841: an ENTRY is still refused outright at the verdict seam when the book cannot be valued', async () => {
    const held: OpenPosition = {
      idempotency_key: 'held-DARK',
      debate_id: 'debate-1',
      instrument: 'DARK',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10,
      filled_size: 10,
      avg_entry_price: 90,
      stop: 80,
      target: 120,
      order_state: 'filled',
      broker_order_ids: [],
      opened_at: NOW,
      decision_timestamp: NOW,
      conviction: 0.8,
      converged: true,
    };
    const darkMarketData = {
      ...FAKE_MARKET_DATA,
      getMarks: vi.fn(async (instruments: readonly string[], asOf: Date) =>
        collectMarks(
          async (instrument: string, at: Date) => {
            if (instrument === 'DARK') throw new Error('feed timeout for DARK');
            return FAKE_GET_MARK(instrument, at);
          },
          instruments,
          asOf,
        ),
      ),
    };

    const riskDecision = {
      status: 'approved' as const,
      order_intent: {
        idempotency_key: 'key-entry-841',
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
        decided_at: NOW,
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
      risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
      next_breaker_state: [],
    };

    const db = openSharedStore(':memory:');
    const step = buildVerdictStep({
      tradingCalendar: { isOpen: () => true, hasSession: () => true } as never,
      positionStore: { findByKey: vi.fn(async () => false) },
      config: VERDICT_CONFIG,
      approvals: { requestApproval: vi.fn(async (): Promise<ApprovalOutcome> => 'approved') },
      marketData: darkMarketData,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => [held],
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      store: db,
    });

    await expect(
      step({ trace_id: TRACE_ID, risk_decision: riskDecision as never, clock: CLOCK }),
    ).rejects.toThrow(/DARK/);
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
        decided_at: NOW,
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
      approvals: { requestApproval: vi.fn(async (): Promise<ApprovalOutcome> => 'approved') },
      marketData: FAKE_MARKET_DATA,
      circuitBreakers: new CircuitBreakers({
        daily_loss_pct: 0.05,
        daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
        max_drawdown_pct: 0.2,
        max_consecutive_losses: 5,
        volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
        auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
      }),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
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
      maxMarkAge: TEST_MAX_MARK_AGE,
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
      sessionCalendars: OPEN_SESSION_CALENDARS,
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
      unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
      logger: { log: vi.fn() },
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    });

    const verdict: VerdictDecision = {
      status: 'no_go',
      order: null,
      no_go_reason: 'staleness',
      no_go_detail: null,
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

describe('#847: a dark mark must not suppress a newly decided flatten', () => {
  const INSIDE_FLATTEN_WINDOW = new Date('2026-07-28T19:56:00Z');
  const WINDOW_CLOCK: Clock = { now: () => INSIDE_FLATTEN_WINDOW };

  const RISK_CONFIG: RiskConfig = {
    max_position_size_fraction_of_equity: 10,
    per_asset_cap_fraction_of_equity: 10,
    per_asset_class_cap_fraction_of_equity: { crypto: 10, stocks: 10 },
    portfolio_gross_cap_fraction_of_equity: 20,
    concentration: { cap_fraction_of_equity: 10, threshold: 0.9 },
    min_viable_size: 1,
    whole_share_sizing: false,
    cii_threshold: 80,
    max_mark_age: TEST_MAX_MARK_AGE,
  };

  const TRADER_CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    subclass_of: {},
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 10,
    whole_share_sizing: false,
    scale_in_conviction_delta: 0.1,
    early_exit: DEFAULT_EARLY_EXIT_CONFIG,
    time_in_force: { crypto: 'gtc', stocks: 'day' },
    flatten_before_close_ms: 5 * 60 * 1_000,
    flatten_after_close_ms: 5 * 60 * 1_000,
  };

  function makeHeld(instrument: string): OpenPosition {
    return {
      idempotency_key: `held-${instrument}`,
      debate_id: 'debate-1',
      instrument,
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10,
      filled_size: 10,
      avg_entry_price: 90,
      stop: 80,
      target: 120,
      order_state: 'filled',
      broker_order_ids: [],
      opened_at: NOW,
      decision_timestamp: NOW,
      conviction: 0.8,
      converged: true,
    };
  }

  const DARK_MARKET_DATA = {
    ...FAKE_MARKET_DATA,
    getMark: vi.fn(async (instrument: string, asOf: Date) => {
      if (instrument === 'DARK') throw new Error('feed timeout for DARK');
      return FAKE_GET_MARK(instrument, asOf);
    }),
    getMarks: vi.fn(async (instruments: readonly string[], asOf: Date) =>
      collectMarks(
        async (instrument: string, at: Date) => {
          if (instrument === 'DARK') throw new Error('feed timeout for DARK');
          return FAKE_GET_MARK(instrument, at);
        },
        instruments,
        asOf,
      ),
    ),
  };

  function makeBreakers() {
    return new CircuitBreakers({
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    });
  }

  function makeDeps(held: OpenPosition[], portfolioSnapshots: Map<string, never>) {
    return {
      marketData: DARK_MARKET_DATA,
      circuitBreakers: makeBreakers(),
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => held,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper' as const,
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots,
      critic: undefined,
      config: TRADER_CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
      getUnresolvedFlattens: async () => [],
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
    };
  }

  it('decides the flatten in THIS pass rather than deferring it to the next tick', async () => {
    const snapshots = new Map<string, never>();
    const step = buildTraderStep(makeDeps([makeHeld('AAPL'), makeHeld('DARK')], snapshots));

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ direction: 'neutral', synthesis: 'neutral', position: 'flat' }),
      clock: WINDOW_CLOCK,
    });

    expect(intent).not.toBeNull();
    expect(intent?.intent_type).toBe('exit');
    expect(intent?.side).toBe('sell');
    expect(snapshots.size).toBe(0);
  });

  it('carries that flatten through Risk on the same pass, on the #841 degraded valuation', async () => {
    const snapshots = new Map<string, never>();
    const deps = makeDeps([makeHeld('AAPL'), makeHeld('DARK')], snapshots);
    const traderStep = buildTraderStep(deps);
    const riskStep = buildRiskStep({
      ...deps,
      config: RISK_CONFIG,
      correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
      ciiConsumer: { getScores: vi.fn(() => ({})) },
    });

    const intent = await traderStep({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      debate: makeDebate({ direction: 'neutral', synthesis: 'neutral', position: 'flat' }),
      clock: WINDOW_CLOCK,
    });
    expect(intent).not.toBeNull();

    const decision = await riskStep({
      trace_id: TRACE_ID,
      intent: intent as OrderIntent,
      clock: WINDOW_CLOCK,
    });

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.instrument).toBe('AAPL');
  });

  it('still refuses to size an ENTRY when one held name is dark', async () => {
    const snapshots = new Map<string, never>();
    const step = buildTraderStep(makeDeps([makeHeld('DARK')], snapshots));

    await expect(
      step({
        trace_id: TRACE_ID,
        instrument: 'MSFT',
        debate: makeDebate(),
        clock: CLOCK,
      }),
    ).rejects.toThrow(/DARK/);
    expect(snapshots.size).toBe(0);
  });

  it('still evaluates and persists breakers on a decision pass that produces nothing', async () => {
    const snapshots = new Map<string, never>();
    const saved: unknown[] = [];
    const step = buildTraderStep({
      ...makeDeps([], snapshots),
      marketData: FAKE_MARKET_DATA,
      breakerState: { save: (state: unknown) => saved.push(state) },
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'MSFT',
      debate: makeDebate({ direction: 'neutral', synthesis: 'neutral', position: 'flat' }),
      clock: CLOCK,
    });

    expect(intent).toBeNull();
    expect(saved).toHaveLength(1);
    expect(snapshots.size).toBe(1);
  });

  it('leaves a cleanly-valued decision pass on exactly the path it took before', async () => {
    const snapshots = new Map<string, never>();
    const step = buildTraderStep({
      ...makeDeps([makeHeld('AAPL')], snapshots),
      marketData: FAKE_MARKET_DATA,
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'MSFT',
      debate: makeDebate(),
      clock: CLOCK,
    });

    expect(intent?.intent_type).toBe('entry');
    expect(snapshots.size).toBe(1);
  });

  describe('#1089: a dark or zero-priced held instrument must not crash the CONTROL arm', () => {
    const CONTROL_DARK_MARKET_DATA = {
      ...FAKE_MARKET_DATA,
      getMark: vi.fn(async (instrument: string, asOf: Date) => {
        if (instrument === 'DARK' || instrument === 'ZERO') {
          throw new Error(`feed timeout for ${instrument}`);
        }
        return FAKE_GET_MARK(instrument, asOf);
      }),
      getMarks: vi.fn(async (instruments: readonly string[], asOf: Date) =>
        collectMarks(
          async (instrument: string, at: Date) => {
            if (instrument === 'DARK' || instrument === 'ZERO') {
              throw new Error(`feed timeout for ${instrument}`);
            }
            return FAKE_GET_MARK(instrument, at);
          },
          instruments,
          asOf,
        ),
      ),
    };

    function makeControlDeps(
      held: OpenPosition[],
      writes: TraderDecisionRecord[],
      logs: LogEntry[],
    ) {
      return {
        ...makeDeps(held, new Map<string, never>()),
        marketData: CONTROL_DARK_MARKET_DATA,
        arm: 'control' as const,
        traderLog: { write: (record: TraderDecisionRecord) => writes.push(record) },
        logger: { log: (entry: LogEntry) => logs.push(entry) },
      };
    }

    it('completes rather than throwing — the step resolves with a named skip, not a rejection', async () => {
      const writes: TraderDecisionRecord[] = [];
      const logs: LogEntry[] = [];
      const step = buildTraderStep(
        makeControlDeps(
          [{ ...makeHeld('DARK') }, { ...makeHeld('ZERO'), avg_entry_price: 0 }],
          writes,
          logs,
        ),
      );

      const intent = await step({
        trace_id: `${TRACE_ID}:control`,
        instrument: 'MSFT',
        debate: makeDebate(),
        clock: CLOCK,
      });

      expect(intent).toBeNull();
    });

    it('records the skip on trader_log — recoverable from the store, not only a warn log line', async () => {
      const writes: TraderDecisionRecord[] = [];
      const logs: LogEntry[] = [];
      const step = buildTraderStep(
        makeControlDeps(
          [{ ...makeHeld('DARK') }, { ...makeHeld('ZERO'), avg_entry_price: 0 }],
          writes,
          logs,
        ),
      );

      await step({
        trace_id: `${TRACE_ID}:control`,
        instrument: 'MSFT',
        debate: makeDebate(),
        clock: CLOCK,
      });

      expect(writes).toHaveLength(1);
      expect(writes[0]?.skip_reason).toBe('control_arm_valuation_refused');
      expect(writes[0]?.intent_type).toBeNull();
    });

    it('is visible above warn — an error-level line, not the containment catch’s warn alone', async () => {
      const writes: TraderDecisionRecord[] = [];
      const logs: LogEntry[] = [];
      const step = buildTraderStep(
        makeControlDeps(
          [{ ...makeHeld('DARK') }, { ...makeHeld('ZERO'), avg_entry_price: 0 }],
          writes,
          logs,
        ),
      );

      await step({
        trace_id: `${TRACE_ID}:control`,
        instrument: 'MSFT',
        debate: makeDebate(),
        clock: CLOCK,
      });

      const errorLine = logs.find(
        (entry) =>
          entry.level === 'error' &&
          (entry.payload as { kind?: string } | undefined)?.kind ===
            'control_arm_valuation_refused',
      );
      expect(errorLine).toBeDefined();
    });

    it('the LIVE arm is unaffected — the same dark book still throws for arm: live', async () => {
      const writes: TraderDecisionRecord[] = [];
      const logs: LogEntry[] = [];
      const deps = makeControlDeps(
        [{ ...makeHeld('DARK') }, { ...makeHeld('ZERO'), avg_entry_price: 0 }],
        writes,
        logs,
      );
      const step = buildTraderStep({ ...deps, arm: 'live' });

      await expect(
        step({ trace_id: TRACE_ID, instrument: 'MSFT', debate: makeDebate(), clock: CLOCK }),
      ).rejects.toThrow(/DARK|ZERO/);
      expect(writes).toHaveLength(0);
    });
  });
});
