import type { DebateResult } from '../../../pipeline/debate-engine/index.js';
import { type ExecutionConfig, SqliteExecutionStore } from '../../../pipeline/execution/index.js';
import type {
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
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { TraderDecisionRecord } from '../../../shared/decision-records.js';
import type { Clock, LogEntry, Logger, OpenPosition, OrderIntent } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { OrphanVerdictScanner } from '../orphan-verdict-scan.js';
import { SqliteAuditLog } from '../sqlite-audit-log.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
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
    // `as const` because `SessionBasis` is a discriminated union on
    // `known: true | false`; without it `known` widens to `boolean` and the
    // literal no longer selects a branch.
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

/**
 * The #640 valuation-freshness bound for these binds. Wide, because these
 * tests exercise wiring rather than freshness — `FAKE_MARKET_DATA` observes
 * every mark at the clock's own `now`, so the bound is never the reason a case
 * here passes or fails. `portfolio-view.test.ts` owns the gate's behaviour.
 */
const TEST_MAX_MARK_AGE = { crypto: 2 * 60_000, stocks: 15 * 60_000 };

/** B1 persistence seam — a sink; these tests assert step behavior, not the write. */
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
    // #687: NOW is bar-aligned, so this is the bar the Trader now inherits
    // instead of flooring a clock read of its own.
    bar_timestamp: NOW,
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
      // Unarmed: this fixture's universe declares no subclass, so sizing keeps
      // the pre-ADR-0018 geometry these expectations were written against.
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
      // #568: no lot open in these cases, so nothing to look an exit fill up for.
      getExitFillSizes: async () => new Map<string, number>(),
      // #668: the Trader resolves flat-by-close through the instrument's own
      // venue calendar, so the step needs the same pair production builds once.
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
    // The composition-root half of #739: `paperTradingProfile` fills
    // `subclass_of` from the universe, and THIS is the binding that carries it
    // into the live decision. A per-subclass table the production step never
    // consults is this repo's dominant defect shape, so the assertion is on the
    // emitted intent's geometry and deployment rather than on the config.
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
    // Mark is 100 and the index row is +2.00% / -2.16%.
    expect(intent.stop).toBeCloseTo(97.84, 9);
    expect(intent.target).toBeCloseTo(102, 9);
    // Equity is the fake account's $10,000, the no-precedent haircut is 0.75x,
    // and #897's headroom reserve keeps the first tranche at 0.9x the envelope
    // — all stated rather than divided out, so the number below is the whole
    // deployment this binding actually produces: 0.35 x 0.9 x 10,000 x 0.75.
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
      // Unarmed: this fixture's universe declares no subclass, so sizing keeps
      // the pre-ADR-0018 geometry these expectations were written against.
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
      // #568: no lot open in these cases, so nothing to look an exit fill up for.
      getExitFillSizes: async () => new Map<string, number>(),
      // #668: the Trader resolves flat-by-close through the instrument's own
      // venue calendar, so the step needs the same pair production builds once.
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

  // #568, at the call site: the composition root binds `getExitFillSizes` to
  // the SAME store `getOpenPositions` reads (production.ts), so an exit is
  // sized off the fill record `executeExit` re-derives its own guard from.
  // Bound here to a real `SqliteExecutionStore` rather than a fake, because
  // the failure this closes was precisely a reader that existed and was not
  // wired to the lots it had to agree with.
  it('sizes an exit to the residual of a partially flattened lot, reading the same store the lots come from', async () => {
    const config: TraderConfig = {
      conviction_floor: 0.5,
      max_risk_per_trade: 0.01,
      asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
      subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
      // Unarmed: this fixture's universe declares no subclass, so sizing keeps
      // the pre-ADR-0018 geometry these expectations were written against.
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
    // The earlier partial flatten's own fill: 4 of the 10 closed, 6 left at
    // the venue, the lot still open at `filled_size` 10.
    await store.applyLotAdvance({
      idempotency_key: 'key-aapl-entry-1',
      fills: [
        {
          idempotency_key: 'key-aapl-entry-1',
          broker_fill_id: 'fill-partial-flatten',
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
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config,
      setupStore: new FixtureSetupStore(),
      // #668: the Trader resolves flat-by-close through the instrument's own
      // venue calendar, so the step needs the same pair production builds once.
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
    });

    const intent = await step({
      trace_id: TRACE_ID,
      instrument: 'AAPL',
      // Opposite the held long → flatten.
      debate: makeDebate({ direction: 'bearish', confidence: 0.8, converged: true }),
      clock: CLOCK,
    });

    expect(intent?.intent_type).toBe('exit');
    expect(intent?.side).toBe('sell');
    expect(intent?.size).toBe(6);
  });
});

describe('sizingEquity (#511)', () => {
  it('takes the ceiling when equity exceeds it — a funded account cannot widen the run', () => {
    expect(sizingEquity(250_000, 2_000)).toBe(2_000);
  });

  it('takes real equity when it is below the ceiling — a ceiling is not a floor', () => {
    expect(sizingEquity(500, 2_000)).toBe(500);
  });

  it('leaves equity untouched when no ceiling is declared', () => {
    // Paper, backtest, and every existing caller: the pre-#511 behaviour.
    expect(sizingEquity(10_000, undefined)).toBe(10_000);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('throws for an unusable ceiling of %j instead of sizing off unclamped equity (#569)', (ceiling) => {
    // `Math.min(10_000, NaN)` is `NaN`, and "unclamped" is exactly the
    // fail-OPEN outcome #511 exists to prevent: a live run whose declared
    // ceiling somehow arrives non-finite must refuse to size, not silently
    // size off the raw account equity. Unreachable via the shipped
    // entrypoint (`resolveLiveCapitalCeilingUsd`/`assertLiveCapitalCeilingUsd`
    // refuse both at boot), so this pins the guard itself for any caller
    // that reaches `sizingEquity` some other way.
    expect(() => sizingEquity(10_000, ceiling)).toThrow(/finite/);
  });
});

describe('buildTraderStep capital ceiling (#511)', () => {
  const CEILING_CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    // Unarmed: this fixture's universe declares no subclass, so sizing keeps
    // the pre-ADR-0018 geometry these expectations were written against.
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
  };

  function stepWithCeiling(capitalCeilingUsd?: number) {
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
      // `cash: 10_000`, no open positions, so portfolio equity is 10_000.
      accountState: FAKE_ACCOUNT_STATE,
      volatility: FAKE_VOLATILITY,
      getOpenPositions: async () => NO_POSITIONS,
      maxMarkAge: TEST_MAX_MARK_AGE,
      mode: 'paper',
      breakerState: NOOP_BREAKER_STATE,
      portfolioSnapshots: new Map(),
      config: CEILING_CONFIG,
      setupStore: new FixtureSetupStore(),
      // #568: no lot open in these cases, so nothing to look an exit fill up for.
      getExitFillSizes: async () => new Map<string, number>(),
      // #668: the Trader resolves flat-by-close through the instrument's own
      // venue calendar, so the step needs the same pair production builds once.
      sessionCalendars: {
        crypto: new AlwaysOpenCalendar(),
        stocks: new UsEquityRegularHoursCalendar(),
      },
      ...(capitalCeilingUsd === undefined ? {} : { capitalCeilingUsd }),
    });
  }

  async function sizeFor(capitalCeilingUsd?: number): Promise<number> {
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
    // THE acceptance criterion: equity 10,000 against a declared 1,000 must
    // size as if the account held 1,000. Asserted as a RATIO against the
    // unclamped size rather than an absolute, so it pins the clamp rather than
    // re-deriving `decide`'s arithmetic here.
    const unclamped = await sizeFor(undefined);
    const clamped = await sizeFor(1_000);

    expect(clamped).toBeCloseTo(unclamped / 10, 10);
  });

  it('does not inflate a size when the ceiling is above real equity', async () => {
    // A ceiling is a bound, never a target: a $1m declaration against a $10k
    // account must not size as if the money were there.
    expect(await sizeFor(1_000_000)).toBeCloseTo(await sizeFor(undefined), 10);
  });

  it('rejects instead of silently sizing off unclamped equity when a declared ceiling is non-finite (#569)', async () => {
    // `sizingEquity`'s own unit tests (above) pin the corrected behaviour
    // directly; this asserts the same guard is actually reached through the
    // real `buildTraderStep` composition, not merely the standalone
    // function. `sizeFor(undefined)` two tests up already establishes "no
    // ceiling declared" stays unclamped — this is the DEFINED-but-unusable
    // case, deliberately not the same input.
    await expect(sizeFor(Number.NaN)).rejects.toThrow(/finite/);
  });
});

/**
 * The diagnostic escalation wired into the step (#698), as corrected by #710's
 * review.
 *
 * `trader-diagnostic-alert.test.ts` pins the throttle's counting rules on their
 * own. These are the properties that only exist at the COMPOSITION: that the
 * step does not wait for the transport, that the durable log is not throttled
 * with the alert, and that the line carries the tick's own trace. Every one of
 * them was wrong or untested when the throttle's unit tests were fully green.
 */
/**
 * #748. The Trader now names three different in-process exits and `trader_log`
 * has a column for them — but the COMPOSITION is where that column gets its
 * value, and this repo's dominant defect class is a tested mechanism nothing
 * calls. `decide.test.ts` proves the intent carries `metadata.exit_reason`;
 * `sqlite-decision-record-stores.test.ts` proves the column round-trips. Only
 * this pins the wire between them: dropping `intent.metadata.exit_reason` from
 * `buildTraderSteps`' exit-path write leaves both of those green and every
 * released position in the soak indistinguishable from a flat-by-close.
 */
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
    // Unarmed: this fixture's universe declares no subclass, so sizing keeps
    // the pre-ADR-0018 geometry these expectations were written against.
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
  };

  it('records signal_decay on the row the exit-check path writes', async () => {
    const written: TraderDecisionRecord[] = [];
    // Momentum netting AGAINST the held long: RSI below 50 and a negative MACD
    // histogram is the `-1` the default criterion releases on.
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
      // Nothing exited yet — the whole 50 is still held. A non-empty map here
      // is the amount ALREADY closed (#568), so seeding it would leave zero to
      // release and the exit would correctly decline to fire.
      getExitFillSizes: async () => new Map<string, number>(),
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
    // The row, not the intent — this is the assertion the composition owes.
    expect(written[0]?.exit_reason).toBe('signal_decay');
    expect(written[0]?.intent_type).toBe('exit');
    // Attributed to the debate that OPENED the lot, not to a debate this tick
    // never ran — the tick path has no `DebateResult` at all.
    expect(written[0]?.debate_id).toBe('debate-that-opened-the-lot');
  });
});

/**
 * #826 — THE WIRE, not the mechanism.
 *
 * `decide.test.ts` proves `buildFlattenExit` degrades to an unpriced flatten
 * when the mark read fails, and `verdict/index.test.ts` proves Verdict lets
 * such an intent through. Neither says the live orchestrator ever REACHES that
 * behaviour: the tick path runs through `buildTraderSteps`, and if this root
 * did not thread `onUnpricedFlatten` the degradation would still happen but
 * nobody would be paged for it — which is precisely the "tested mechanism
 * nothing calls" shape this repo keeps shipping.
 *
 * So this drives the real `exitCheck` binding with a market-data double whose
 * `getMark` throws the way a stalled Alpaca does, inside the flat-by-close
 * window, and asserts BOTH halves at the composition: the exit intent, and the
 * page on the channel the composition root owns.
 */
describe('buildTraderSteps unpriced flatten escalation (#826)', () => {
  // 2026-07-28 is a Tuesday; the US close is 20:00 UTC and the config below
  // opens the flatten window at 19:55, so 19:56 is inside it.
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
  };

  function buildExitCheck(overrides: { exitValuationAlerts?: ExitValuationDegradedAlertChannel }) {
    return buildTraderSteps({
      marketData: {
        ...FAKE_MARKET_DATA,
        // The stall: bars still answer, the mark does not — the exact split
        // `FailoverDataSource` leaves in place by failing over bars only.
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
    // The dark name IS the exited name on this seam — that is what
    // distinguishes it from #841's two.
    expect(posted[0]?.unvalued_instruments).toEqual(['AAPL']);
    expect(posted[0]?.reason).toContain('timed out');
    expect(posted[0]?.reported_at).toEqual(INSIDE_WINDOW);
  });

  /**
   * The OTHER binding — the decision-path `trader` step.
   *
   * `buildTraderSteps` threads `onUnpricedFlatten` twice, and until this case
   * existed only the tick-path thread was pinned: deleting the `trader` bind
   * left all ~3900 tests green, which is this repo's dominant defect shape (a
   * mechanism that is tested and a wire that nothing holds).
   *
   * The debate is deliberately NEUTRAL. `routeDecision` decides flat-by-close
   * ABOVE its `neutral || !converged` skip — that ordering is the load-bearing
   * part of the branch's own comment — so a neutral debate is exactly the case
   * that reaches `buildFlattenExit` on this path, and it reaches it without the
   * pass needing a working equity read (the strict snapshot throws here, since
   * the same dark mark it captures is the one under test).
   */
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
    // The wire, which is what a deleted bind breaks — the intent above still
    // degrades without it.
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
  /**
   * A calendar that answers with a close already in the past — the fault
   * `session_end_in_past` exists to report, which a conforming implementation
   * cannot produce (both shipped ones return a close strictly after the
   * instant).
   */
  const BROKEN_STOCKS_CALENDAR: TradingCalendar = {
    isOpen: () => true,
    isTradingDay: () => true,
    sessionStart: (instant: Date) => instant,
    sessionEnd: () => new Date(NOW.getTime() - 60 * 60 * 1_000),
  };

  const CONFIG: TraderConfig = {
    conviction_floor: 0.5,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    // Unarmed: this fixture's universe declares no subclass, so sizing keeps
    // the pre-ADR-0018 geometry these expectations were written against.
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
        entry.message.includes('session_end_in_past'),
    );
  }

  it('does not wait for the alert transport before returning the intent', async () => {
    // The defect this pins is a SLOW transport, not a failing one — the failing
    // case was always caught. `buildTraderStep`'s return value is what Risk and
    // Execution act on, and the Telegram client retries 3x against a 10s
    // per-request timeout, so an awaited send could hold a flat-by-close exit
    // for ~31s of a 15-minute tick while the bell approaches. A channel that
    // never settles is that outage taken to its limit: the step must still
    // answer, and this test hangs rather than fails if it ever awaits again.
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

    // Reaching here at all is the assertion. The count proves the send was
    // still ISSUED rather than dropped — fire-and-forget, not fire-and-skip.
    expect(posted).toBe(1);
  });

  it('logs the condition on every tick while alerting on a bounded interval', async () => {
    // #710. The `error` log used to live inside the function the throttle
    // gates, so a condition present on every tick was logged on tick 1, again
    // on tick 9, and nowhere in between — while this module's docblock promised
    // an absent channel meant "no second copy", never "silent". Seven ticks in
    // eight had no durable record of a broken calendar.
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
    // ...and the run length in the line is what tells the operator it is not
    // clearing, which is the whole signal.
    expect(diagnosticLines(entries)[2]?.message).toContain('3 consecutive tick(s)');
    // The chat, sharing a channel with kill-threshold breaches, hears it once.
    expect(posted).toBe(1);
  });

  it('logs under the TICK trace, not a synthetic constant', async () => {
    // #710. `trace_id: 'trader-diagnostic'` was hardcoded, which severed the
    // line from the debate, the `trader_log` row and the verdict for the same
    // instrument on the same tick — the joins a soak post-mortem needs to
    // reconstruct what the Trader was looking at when it complained.
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
    // Fractions of the fixture's equity ($10,000, `FAKE_ACCOUNT_STATE`),
    // sized so none of them binds unless a test overrides one on purpose —
    // 10x/20x equity is "never" regardless of a test's own position sizes.
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
      // Required-but-nullable since #957: no producer here, said out loud.
      critic: undefined,
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.status).toBe('approved');
    expect(decision.order_intent?.instrument).toBe('AAPL');
    expect(decision.next_breaker_state).toHaveLength(2);
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
      // Required-but-nullable since #957: no producer here, said out loud.
      critic: undefined,
    });

    const decision = await step({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('circuit_breaker:portfolio');
  });

  it('#740: persists a below-viable-size refusal to risk_log with a binding_constraint distinct from a circuit-breaker refusal', async () => {
    // Verified against the actual persisted `risk_log` ROWS `riskLog.write`
    // receives (below), not the in-memory `RiskDecision.reasons` array — a
    // post-mortem reads the store, never the process's own memory. Two
    // DIFFERENT rejection causes are driven through the SAME riskLog sink so
    // the assertion can fail if they ever collapse onto one tag — a single
    // `toBe('min_viable_size')` plus a tautological `not.toBe` on an
    // unrelated literal would not catch that.
    const writes: unknown[] = [];
    const riskLog = { write: (record: unknown) => writes.push(record) };

    // Trimmed to £5 notional by the per-asset-class cap (0.0005 x the
    // $10,000 fixture equity = $5), which is below the £100 `min_viable_size`
    // floor — a dust residual that must refuse rather than forward.
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
      // Required-but-nullable since #957: no producer here, said out loud.
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

    // Same riskLog sink, a genuinely different rejection cause: the sticky
    // tripped-breaker scenario from the test immediately above.
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
      // Required-but-nullable since #957: no producer here, said out loud.
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
    // The property the ticket asks to be verified, not merely inspected:
    // two distinct rejection causes must not collapse onto the same
    // persisted binding_constraint tag.
    expect(sizeRow.binding_constraint).not.toBe(breakerRow.binding_constraint);
  });

  describe('#726: risk_log on the per-subclass cap gate throw', () => {
    // AAPL is deliberately absent from `subclass_of` — the D5 envelope is
    // declared (armed) but this instrument was never added to the pool file,
    // which is exactly the hole `perSubclassDeploymentCap` refuses to size
    // around.
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
        // Required-but-nullable since #957: no producer here, said out loud.
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
      // An operator reading this row alone must be able to tell which
      // instrument/subclass was missing without opening the code.
      expect(row.binding_constraint).toBe(
        'per_subclass_deployment_cap:unclassified_instrument:AAPL',
      );
    });

    it('still returns before the entry-gate loop on an exit, even with the same armed-but-unclassified config', async () => {
      // The sharpest edge on the throw: ADR-0014's flat-by-close reaches Risk
      // as an `exit`, and `evaluate()` returns before `ENTRY_CAP_GATES` (and
      // this gate) is ever entered. Pinned again here, at the binding level,
      // so the try/catch this fix adds around `evaluate()` cannot be the thing
      // that regresses it — the pipeline-level pin already lives in
      // `per-subclass-deployment-cap.test.ts`.
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
      // Guards the catch's own side effect the same way #507 guards
      // tick-loop.ts's: a SQLite failure (disk full, locked handle) writing
      // the diagnostic row must not replace the diagnostic itself. Without
      // the inner try/catch around `riskLog.write`, this would reject with
      // "boom" instead of "AAPL has no subclass" — the operator gets an
      // opaque store error instead of the actionable one.
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
        // Required-but-nullable since #957: no producer here, said out loud.
        critic: undefined,
        // max_pbo's bound is 0.05 (threshold-bounds.ts) — 0.5 crosses it, so
        // `resolveRiskConfig` throws on every `evaluate()` call.
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
    });

    it('proves by removal: with no channel injected, the step still refuses (fail-closed unaffected)', async () => {
      const step = buildStep({});

      await expect(
        step({ trace_id: TRACE_ID, intent: makeIntent({ intent_type: 'entry' }), clock: CLOCK }),
      ).rejects.toThrow(/in-code clamp/);
    });

    it('does not post — and does not throw — for an exit intent under the same bad table (#766)', async () => {
      // The empirical finding #766 asks for: RiskManagerImpl now skips the
      // live resolve entirely for an exit, so the flatten path never reaches
      // the clamp at all and this channel is never consulted for it.
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
    /**
     * Two held lots, one of which the feed will not price. Both are 'stocks'
     * so the per-class freshness bound cannot be the reason a case passes.
     */
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

    /** Prices AAPL; throws for DARK — the single unreadable name. */
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
        // Required-but-nullable since #957: no producer here, said out loud.
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

      // The whole point: an order still exists for the name that CAN be
      // valued. Before #841 this call rejected with the valuation refusal and
      // the flatten never reached Verdict at all.
      expect(decision.status).toBe('approved');
      expect(decision.order_intent?.instrument).toBe('AAPL');
      // And the fresh name is genuinely still IN the book that was valued —
      // 10 filled @ 100 — rather than the exit having been let through on an
      // empty view that skipped every position.
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
      // The reason has to name WHY, not merely that — `describeThrown` prints
      // the message alone, so a reason that loses the source text is a reason
      // the operator never reads.
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
      // The book values cleanly; it is the VOLATILITY read that fails — one
      // of the reads the degraded attempt deliberately skips. So the fallback
      // succeeds with nothing unvalued, and the real fault would vanish on
      // every exit tick if the original throw were dropped here.
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
      // And it is not miscast as a valuation degradation on the way out.
      expect(posted).toHaveLength(0);
    });

    it('does NOT degrade for an entry — the whole-book refusal still stands and still throws', async () => {
      const { channel, posted } = makeAlerts();
      const step = buildStep({ exitValuationAlerts: channel });

      // Unchanged behaviour: no view, no order, and the tick fails loudly for
      // #507's catch to record. Every consumer of `exposure_by_instrument`
      // reads an absent key as zero exposure, so an entry sized against a
      // book missing DARK would be sized against caps that are all too wide.
      await expect(
        step({
          trace_id: TRACE_ID,
          intent: makeIntent({ intent_type: 'entry', instrument: 'AAPL' }),
          clock: CLOCK,
        }),
      ).rejects.toThrow(/DARK/);
      // And the exit-only alert never fires for it.
      expect(posted).toHaveLength(0);
    });

    it('a degraded valuation cannot trip — or persist — the sticky drawdown breaker', async () => {
      // A partial view omits a held lot, which understates equity and so
      // OVERSTATES drawdown. Evaluating breakers off it could trip the sticky
      // hard-drawdown tier and write it to `breaker_state`, halting every new
      // entry on a number that was never true. Peak equity here is far above
      // the degraded equity (10,000 cash + 1,000 AAPL = 11,000 against a
      // 1,000,000 peak), which WOULD trip a 20% max drawdown if evaluated.
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
      // Nothing persisted from the degraded path either — the strict path is
      // the only writer of `breaker_state`.
      expect(saved).toHaveLength(0);
    });
  });

  /**
   * #957: the risk critic's CADENCE, which is the half that lives here rather
   * than in the producer. The producer answers; this step decides WHEN to ask,
   * and #955 specifies "every intent that reaches step 7" — every viable entry
   * that survived the exit bypass, the breaker gate and the `min_viable_size`
   * reject. Each test below is one of those survivals, or one of the exits
   * that must NOT be paid for.
   */
  describe('risk critic (#957)', () => {
    const BREAKER_CONFIG = {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    } as const;

    /** A producer that records what it was asked and answers with `verdict`. */
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

    /**
     * A DEGRADED snapshot, memoised for this trace the way the Trader's is.
     *
     * The only route to a non-empty `unvalued_instruments` on an entry: the
     * entry path asks `computePortfolioView` for a strict valuation, which
     * REFUSES rather than returning a partial view, so a stale mark aborts the
     * pass long before step 7. Seeding the per-trace memo puts the degraded
     * view in front of `evaluate()` directly, which is what makes the
     * `unvalued_book` gate reachable here at all.
     */
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
          daily_pnl: { crypto: known, stocks: known, portfolio: known },
          consecutive_losses: 0,
          unvalued_instruments: ['DARK'],
        },
        breakers: {
          portfolio_tripped: false,
          asset_class_tripped: { crypto: false, stocks: false },
          armed_breakers: [],
        },
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
        // Unconditional, not a conditional spread: `critic` is required-but-
        // nullable on `RiskStepDeps` (#957), so "no producer" is a value here.
        critic: overrides.critic,
        ...(overrides.riskLog === undefined ? {} : { riskLog: overrides.riskLog }),
      });
    }

    it('consults the critic on a viable entry, and shows it the book', async () => {
      const { critic, asks } = recordingCritic();

      await step({ critic })({ trace_id: TRACE_ID, intent: makeIntent(), clock: CLOCK });

      expect(asks).toHaveLength(1);
      expect(asks[0]?.instrument).toBe('AAPL');
      // The co-catalyst read ADR-0003 §1 names as the blind spot needs the
      // rest of the book, not just this intent.
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
      // ONE row, not one per evaluate pass — the dry run is discarded.
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
        // 10 x $100 = $1,000 of notional proposed.
        intent: makeIntent({ size: 10, entry: 100 }),
        clock: CLOCK,
      });

      expect(decision.status).toBe('approved');
      expect(decision.binding_constraint).toBe('risk_critic:trim');
      expect(decision.order_intent?.size).toBe(4);
    });

    it('no verdict leaves the decision on the mechanical steps, by record', async () => {
      // The fail-open path the ticket requires to stay intact: a producer-side
      // failure returns `undefined`, and the decision must stay
      // distinguishable from one the critic actually passed.
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
      // The fourth member of the population #955's cadence names, alongside
      // the exit bypass, the breaker gate and the min-viable floor: an entry
      // on a book that could not be fully valued is refused at
      // `unvalued_book` — ABOVE step 7 — so it must cost no call.
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
      // The positive half, and the reason the case above is evidence of
      // anything: the ONLY difference is the degraded snapshot. Without this,
      // a critic that never fired at all would pass the check above.
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
    // The second seam. `buildVerdictStep` re-derives the portfolio for gate
    // 5, so fixing only `buildRiskStep` would have left the flatten approved
    // at Risk and dead here — same refusal, same missing order, same silence.
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
      mode: 'paper',
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      logger: { log: vi.fn() },
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

/**
 * #847 — a decision pass must not abort before the Trader can flatten.
 *
 * #841 fixed the two seams that VALUE the book for an exit (`buildRiskStep`,
 * `buildVerdictStep`). What it could not reach was the pass whose Trader would
 * have produced the exit in the first place: `buildTraderStep` read the
 * whole-book portfolio view eagerly, before any intent existed, so one dark
 * held name aborted the pass AT the Trader and the flatten waited for the next
 * tick's `runExitCheckPass` — a bounded but real delay against ADR-0014's
 * flat-by-close.
 *
 * The read is still performed eagerly (it is also where `CircuitBreakers`
 * evaluates and persists its sticky tiers); only the FAILURE is deferred, to
 * the one branch that consumes equity.
 */
describe('#847: a dark mark must not suppress a newly decided flatten', () => {
  /** 2026-07-28 is a Tuesday; the US close is 20:00 UTC, so the window opens 19:55. */
  const INSIDE_FLATTEN_WINDOW = new Date('2026-07-28T19:56:00Z');
  const WINDOW_CLOCK: Clock = { now: () => INSIDE_FLATTEN_WINDOW };

  const RISK_CONFIG: RiskConfig = {
    // Fractions of the fixture's equity ($10,000, `FAKE_ACCOUNT_STATE`),
    // sized so none of them binds unless a test overrides one on purpose —
    // 10x/20x equity is "never" regardless of a test's own position sizes.
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

  /** Prices everything except DARK — the one held name the feed will not serve. */
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
      // Required-but-nullable since #957: no producer here, said out loud.
      critic: undefined,
      config: TRADER_CONFIG,
      setupStore: new FixtureSetupStore(),
      getExitFillSizes: async () => new Map<string, number>(),
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
      // Neutral, which was 92 of 94 debates in the soak — so this also pins
      // that the flatten is reached on the commonest branch of all.
      debate: makeDebate({ direction: 'neutral', synthesis: 'neutral', position: 'flat' }),
      clock: WINDOW_CLOCK,
    });

    expect(intent).not.toBeNull();
    expect(intent?.intent_type).toBe('exit');
    expect(intent?.side).toBe('sell');
    // Nothing was memoized: the strict read threw, so no entry later in this
    // trace can pick a partial observation up out of the B4 memo.
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

  /**
   * THE REGRESSION THAT WOULD COST THE MOST AND SHOW THE LEAST.
   *
   * An entry is sized off equity, and every exposure cap reads an absent
   * instrument as ZERO exposure — so a book that cannot be fully valued must
   * still refuse outright here. It refuses by THROWING (aborting the tick into
   * `tick-loop.ts`'s #507 catch), exactly as the eager read did, rather than
   * degrading to a partial view or turning into a quiet skip row.
   */
  it('still refuses to size an ENTRY when one held name is dark', async () => {
    const snapshots = new Map<string, never>();
    // MSFT is flat, so this is an entry; DARK is held and unpriceable, so the
    // whole-book valuation the sizing depends on cannot be produced.
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

  /**
   * WHY THE READ IS CAPTURED RATHER THAN MADE LAZY.
   *
   * `computeCurrentPortfolioAndBreakers` is not a pure observation: it runs
   * `CircuitBreakers.evaluate()` and persists the sticky tiers. A decision pass
   * is one of the few places that happens — the tick path performs no portfolio
   * read at all, and Verdict only re-derives on passes that produced an intent.
   * So deferring the READ (rather than only the failure) would silently stop
   * evaluating breakers on every no-trade decision bar, which was 92 of 94
   * debates in the soak. This pins the side effect on the emptiest pass there
   * is: neutral debate, flat book, no intent, no exception.
   */
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
    // The B4 memo is still populated on a healthy pass, so Risk gates the
    // entry against the same observation the Trader sized it against — and
    // `CircuitBreakers.evaluate()` ran (and persisted) on this pass.
    expect(snapshots.size).toBe(1);
  });
});
