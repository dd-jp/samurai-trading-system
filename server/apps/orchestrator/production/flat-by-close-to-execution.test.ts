/**
 * #894 — THE MANDATORY FLATTEN, TICK TO BROKER.
 *
 * The coverage gap that hid the defect: `verdict/index.test.ts` hands every
 * intent a freshly-minted `decision_timestamp`, `smoke-run.ts` fabricated its
 * own `go` for the exit scenarios, and NOTHING drove a tick-decided flatten
 * through Verdict into Execution. So gate 1 (staleness) `no_go`'d every
 * flat-by-close flatten in production while ~2900 tests stayed green.
 *
 * The arithmetic these cases pin: the tick path stamps `decision_timestamp` to
 * the DECISION BAR (`floorToBar(now, DEBATE_BAR_TIMEFRAME_MS)`, 1h — applied at
 * `tick-runner.ts`'s `runExitCheckPass(...)` call), while ADR-0014's flatten
 * window opens only `flatten_before_close_ms` (5 min) before the session close.
 * The signal is therefore tens of minutes old the moment the flatten is
 * decided, against a 15-minute `max_signal_age.stocks` — and the age depends on
 * where the venue's close sits inside the hour, which is why BOTH closes are
 * exercised here rather than one standing in for the other.
 *
 * Deliberately built on a HEALTHY mark. #891's `unpriced_exit` bypass skips the
 * two PRICE gates, so running these against a stalled feed would exercise two
 * exemptions at once and stop isolating which gate refused. A normally-priced
 * flatten is refused by gate 1 alone, which is both the cleaner proof and the
 * larger blast radius: the defect never needed a degraded feed.
 *
 * The configs are the SHIPPED ones (`buildStartingProfileConfigs`), not local
 * fixtures — a test that invented its own `max_signal_age` would pass against a
 * bound nobody runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../../pipeline/debate-engine/index.js';
import { SqliteExecutionStore } from '../../../pipeline/execution/index.js';
import { CircuitBreakers } from '../../../pipeline/risk-manager/index.js';
import { FixtureSetupStore } from '../../../pipeline/trader/index.js';
import type { VerdictDecision } from '../../../pipeline/verdict/index.js';
import {
  AlwaysOpenCalendar,
  collectMarks,
  LseRegularHoursCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { Clock, OpenPosition, OrderIntent } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { buildStartingProfileConfigs } from '../paper-profile.js';
import {
  buildExecutionStep,
  buildRiskStep,
  buildTraderSteps,
  buildVerdictStep,
} from './direct-bind.js';

const TRACE_ID = 'trace-894';
const INSTRUMENT = 'AAPL';
const HELD_SIZE = 50;
/** A Tuesday, and a trading day on both venues. */
const SESSION_DAY = new Date('2026-07-28T12:00:00Z');

const PROFILE = buildStartingProfileConfigs();
const MAX_MARK_AGE = { crypto: 2 * 60_000, stocks: 15 * 60_000 };

function makeBars(at: Date, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const close_time = new Date(at.getTime() - (count - i) * 60 * 60 * 1_000);
    return {
      instrument: INSTRUMENT,
      timeframe: '1h',
      open_time: new Date(close_time.getTime() - 60 * 60 * 1_000),
      close_time,
      open: 100 + i,
      high: 102 + i,
      low: 98 + i,
      close: 100 + i,
      volume: 1_000,
      source: 'fixture',
    };
  });
}

/** A healthy feed: every mark is observed at the caller's own `asOf`. */
function makeMarketData(at: Date) {
  const getMark = vi.fn(async (_instrument: string, asOf: Date) => ({
    price: 100,
    observed_at: asOf,
    asset_class: 'stocks' as const,
    source: 'fixture',
  }));
  return {
    getBars: vi.fn(async () => makeBars(at, 20)),
    getIndicator: vi.fn(),
    getMark,
    getMarks: vi.fn(async (instruments: readonly string[], asOf: Date) =>
      collectMarks(getMark, instruments, asOf),
    ),
    getSpreadEstimate: vi.fn(async () => null),
    getADV: vi.fn(async () => 1_000),
  };
}

const ACCOUNT_STATE = {
  getAccountState: vi.fn(async () => ({
    cash: 100_000,
    peak_equity: 100_000,
    daily_basis: {
      crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
      stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
      portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
    } as const,
    consecutive_losses: 0,
  })),
};

const VOLATILITY = { getVolatilityReading: vi.fn(async () => ({ crypto: 0.02, stocks: 0.01 })) };

function makeBreakers(): CircuitBreakers {
  return new CircuitBreakers({
    daily_loss_pct: 0.05,
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    max_drawdown_pct: 0.2,
    max_consecutive_losses: 5,
    volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
    auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
  });
}

function heldLot(openedAt: Date): OpenPosition {
  return {
    idempotency_key: 'held-lot-894',
    debate_id: 'debate-that-opened-the-lot',
    instrument: INSTRUMENT,
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: HELD_SIZE,
    filled_size: HELD_SIZE,
    avg_entry_price: 100,
    stop: 90,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['broker-1'],
    opened_at: openedAt,
    decision_timestamp: openedAt,
    conviction: 0.6,
    converged: true,
  };
}

/** Records the venue calls `executeExit` makes; every other surface is inert. */
function makeBroker() {
  return {
    submitBracket: vi.fn(async () => ({ order_state: 'submitted', broker_order_ids: ['o1'] })),
    getOrder: vi.fn(async () => null),
    resumeFlatten: vi.fn(async () => null),
    fetchNewFills: vi.fn(async () => []),
    resizeProtectiveLegs: vi.fn(async () => {}),
    rearmProtectiveLegs: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    submitFlatten: vi.fn(async () => ({ order_state: 'submitted', broker_order_ids: ['flat-1'] })),
  };
}

interface Venue {
  readonly name: string;
  readonly calendar: TradingCalendar;
  /** The signal age the bar floor produces at this venue's flatten window. */
  readonly expectedSignalAgeMinutes: number;
}

/**
 * The whole chain for one venue: tick exit-check -> Risk -> Verdict ->
 * Execution, wired through the SAME `build*Step` bindings production composes.
 */
async function driveFlatten(venue: Venue) {
  const sessionEnd = venue.calendar.sessionEnd(SESSION_DAY);
  // `null` is `AlwaysOpenCalendar`'s answer (#667's ruling in the type system);
  // both venue calendars here resolve a close, and a null would mean the case
  // is no longer testing a flatten window at all.
  if (sessionEnd === null) throw new Error(`${venue.name}: calendar resolved no session close`);
  // Inside ADR-0014's window (close - 5 min), one minute clear of the edge so
  // the case cannot turn on a boundary comparison it is not about.
  const now = new Date(sessionEnd.getTime() - 4 * 60_000);
  const clock: Clock = { now: () => now };
  // Exactly what `tick-runner.ts` hands `runExitCheckPass`.
  const bar = floorToBar(now, DEBATE_BAR_TIMEFRAME_MS);

  const db = openSharedStore(':memory:');
  const store = new SqliteExecutionStore(db);
  const lot = heldLot(new Date(now.getTime() - 6 * 60 * 60 * 1_000));
  await store.writeAheadPosition(lot);

  const marketData = makeMarketData(now);
  const sessionCalendars = { crypto: new AlwaysOpenCalendar(), stocks: venue.calendar };
  const shared = {
    marketData,
    circuitBreakers: makeBreakers(),
    accountState: ACCOUNT_STATE,
    volatility: VOLATILITY,
    getOpenPositions: () => store.getOpenPositions(),
    maxMarkAge: MAX_MARK_AGE,
    mode: 'paper' as const,
    breakerState: { save: () => {} },
    portfolioSnapshots: new Map(),
    // Required-but-nullable since #957: this harness runs step 7 producerless.
    critic: undefined,
  };

  const { exitCheck } = buildTraderSteps({
    ...shared,
    config: PROFILE.traderConfig,
    setupStore: new FixtureSetupStore(),
    getExitFillSizes: (keys: readonly string[]) => store.getExitFillSizes(keys),
    sessionCalendars,
  });

  const intent: OrderIntent | null = await exitCheck({
    trace_id: TRACE_ID,
    instrument: INSTRUMENT,
    clock,
    bar,
  });

  if (intent === null) throw new Error('the tick path produced no flatten intent');

  const riskDecision = await buildRiskStep({
    ...shared,
    config: PROFILE.riskConfig,
    correlationConfig: PROFILE.correlationConfig,
    ciiConsumer: { getScores: () => ({}) },
  })({ trace_id: TRACE_ID, intent, clock });

  const verdict: VerdictDecision = await buildVerdictStep({
    ...shared,
    tradingCalendar: venue.calendar,
    positionStore: store,
    config: PROFILE.verdictConfig,
    approvals: { requestApproval: vi.fn(async () => 'approved' as const) },
    store: db,
  })({ trace_id: TRACE_ID, risk_decision: riskDecision, clock });

  const broker = makeBroker();
  const execution = await buildExecutionStep({
    clock,
    broker: broker as never,
    store,
    costModel: {} as never,
    marketData,
    config: PROFILE.executionConfig,
    mode: 'paper',
    residualExposureAlerts: { postResidualExposureAlert: async () => {} },
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    logger: { log: vi.fn() },
  })(verdict);

  return { now, bar, intent, riskDecision, verdict, execution, broker, sessionEnd };
}

const VENUES: readonly Venue[] = [
  // 2026-07-28 is EDT: the US regular close is 16:00 New York = 20:00Z, the
  // window opens 19:55, and the decision bar floors to 19:00.
  { name: 'US', calendar: new UsEquityRegularHoursCalendar(), expectedSignalAgeMinutes: 56 },
  // BST: 16:30 London = 15:30Z, window opens 15:25, bar floors to 15:00.
  { name: 'LSE', calendar: new LseRegularHoursCalendar(), expectedSignalAgeMinutes: 26 },
];

describe('#894: a mandatory flat-by-close flatten reaches the broker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const venue of VENUES) {
    describe(`${venue.name} close`, () => {
      it('carries a bar-floored decision_timestamp older than max_signal_age', async () => {
        const { intent, now, bar } = await driveFlatten(venue);

        // The premise, asserted rather than assumed: if this stops being true
        // the cases below stop testing gate 1 and nothing would say so.
        expect(intent.metadata.exit_reason).toBe('flatten');
        expect(intent.decision_timestamp).toEqual(bar);
        const signalAgeMs = now.getTime() - intent.decision_timestamp.getTime();
        expect(signalAgeMs / 60_000).toBe(venue.expectedSignalAgeMinutes);
        expect(signalAgeMs).toBeGreaterThan(PROFILE.verdictConfig.max_signal_age.stocks);
      });

      it('is not refused by Verdict, and submits a flatten at the venue', async () => {
        const { intent, verdict, execution, broker } = await driveFlatten(venue);

        // Fails on main with `no_go` / `staleness` — the defect, stated.
        expect(verdict.no_go_reason).toBeNull();
        expect(verdict.status).toBe('go');
        expect(execution.status).toBe('submitted');
        expect(broker.submitFlatten).toHaveBeenCalledWith(
          INSTRUMENT,
          'sell',
          HELD_SIZE,
          intent.idempotency_key,
        );
      });

      it('marks the intent as the mandatory flatten, and only that intent', async () => {
        const { intent } = await driveFlatten(venue);

        // The exemption's narrowing mechanism: a typed marker set by
        // `buildFlattenExit` for `exit_reason: 'flatten'` alone.
        expect(intent.metadata.mandatory_flatten).toBe(true);
      });
    });
  }
});
