import type { DebateResult } from '../../../pipeline/debate-engine/index.js';
import { type ExecutionConfig, SqliteExecutionStore } from '../../../pipeline/execution/index.js';
import type { RiskConfig } from '../../../pipeline/risk-manager/index.js';
import { CircuitBreakers } from '../../../pipeline/risk-manager/index.js';
import { FixtureSetupStore, type TraderConfig } from '../../../pipeline/trader/index.js';
import type {
  ApprovalOutcome,
  VerdictConfig,
  VerdictDecision,
} from '../../../pipeline/verdict/index.js';
import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { Clock, LogEntry, Logger, OpenPosition, OrderIntent } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { OrphanVerdictScanner } from '../orphan-verdict-scan.js';
import { SqliteAuditLog } from '../sqlite-audit-log.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
import {
  buildExecutionStep,
  buildPersistence,
  buildRiskStep,
  buildTraderStep,
  buildVerdictStep,
  sizingEquity,
} from './direct-bind.js';
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

const FAKE_MARKET_DATA = {
  getBars: vi.fn(async () => makeBars(20)),
  getIndicator: vi.fn(),
  getMark: vi.fn(async () => ({
    price: 100,
    observed_at: NOW,
    asset_class: 'stocks' as const,
    source: 'fixture',
  })),
  getSpreadEstimate: vi.fn(async () => null),
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
      scale_in_conviction_delta: 0.1,
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
      scale_in_conviction_delta: 0.1,
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
      atr_timeframe: '1h',
      atr_lookback: 14,
      atr_k: 2,
      vol_floor_fraction: 0.002,
      non_converged_haircut: 0.5,
      reward_risk_multiple: 2,
      min_viable_notional: 10,
      scale_in_conviction_delta: 0.1,
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
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 0.01,
    scale_in_conviction_delta: 0.1,
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
describe('buildTraderStep diagnostic escalation (#698, #710)', () => {
  /**
   * A calendar that answers with a close already in the past — the fault
   * `session_end_in_past` exists to report, which a conforming implementation
   * cannot produce (both shipped ones return a close strictly after the
   * instant).
   */
  const BROKEN_STOCKS_CALENDAR: TradingCalendar = {
    isTradingDay: () => true,
    sessionStart: (instant: Date) => instant,
    sessionEnd: () => new Date(NOW.getTime() - 60 * 60 * 1_000),
  };

  const CONFIG: TraderConfig = {
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
    scale_in_conviction_delta: 0.1,
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
    max_position_size: 100_000,
    per_asset_cap: 100_000,
    per_asset_class_cap: { crypto: 100_000, stocks: 100_000 },
    portfolio_gross_cap: 200_000,
    concentration: { cap: 100_000, threshold: 0.9 },
    min_viable_size: 1,
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
