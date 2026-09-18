import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../../pipeline/debate-engine/index.js';
import {
  FilledZeroSizeThrottle,
  SqliteExecutionStore,
  UnrecordedVenuePositionThrottle,
} from '../../../pipeline/execution/index.js';
import { CircuitBreakers, type RiskDecision } from '../../../pipeline/risk-manager/index.js';
import { FixtureSetupStore } from '../../../pipeline/trader/index.js';
import type { VerdictDecision } from '../../../pipeline/verdict/index.js';
import {
  AlwaysOpenCalendar,
  collectMarks,
  LseRegularHoursCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { AssetClass, Clock, OpenPosition, OrderIntent } from '../../../shared/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { buildStartingProfileConfigs } from '../paper-profile.js';
import {
  buildExecutionStep,
  buildRiskStep,
  buildTraderSteps,
  buildVerdictStep,
} from './direct-bind.js';

const OPEN_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

const TRACE_ID = 'trace-894';
const INSTRUMENT = 'AAPL';
const HELD_SIZE = 50;
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
    getQuote: vi.fn(async () => null),
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
  readonly expectedSignalAgeMinutes: number;
}

interface DriveFlattenOptions {
  readonly verdictDelayMs?: number;
  readonly allowExtendedHours?: boolean;
  readonly decisionOffsetMs?: number;
  readonly session?: FlattenSession;
  readonly unresolvedFlattens?: () => Promise<readonly { readonly instrument: string }[]>;
}

interface FlattenSession {
  readonly db: ReturnType<typeof openSharedStore>;
  readonly store: SqliteExecutionStore;
}

async function driveFlatten(venue: Venue, opts: DriveFlattenOptions = {}) {
  const sessionEnd = venue.calendar.sessionEnd(SESSION_DAY);
  if (sessionEnd === null) throw new Error(`${venue.name}: calendar resolved no session close`);
  const now = new Date(sessionEnd.getTime() + (opts.decisionOffsetMs ?? -4 * 60_000));
  const decisionClock: Clock = { now: () => now };
  const verdictNow = new Date(now.getTime() + (opts.verdictDelayMs ?? 0));
  const verdictClock: Clock = { now: () => verdictNow };
  const bar = floorToBar(now, DEBATE_BAR_TIMEFRAME_MS);

  const session: FlattenSession =
    opts.session ??
    (() => {
      const fresh = openSharedStore(':memory:');
      return { db: fresh, store: new SqliteExecutionStore(fresh) };
    })();
  const { db, store } = session;
  if (opts.session === undefined) {
    const lot = heldLot(new Date(now.getTime() - 6 * 60 * 60 * 1_000));
    await store.writeAheadPosition(lot);
  }

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
    critic: undefined,
  };

  const { exitCheck } = buildTraderSteps({
    ...shared,
    config: PROFILE.traderConfig,
    setupStore: new FixtureSetupStore(),
    getExitFillSizes: (keys: readonly string[]) => store.getExitFillSizes(keys),
    getUnresolvedFlattens: opts.unresolvedFlattens ?? (() => store.getUnresolvedFlattens()),
    sessionCalendars,
  });

  const intent: OrderIntent | null = await exitCheck({
    trace_id: TRACE_ID,
    instrument: INSTRUMENT,
    clock: decisionClock,
    bar,
  });

  if (intent === null) throw new Error('the tick path produced no flatten intent');

  const riskDecision = await buildRiskStep({
    ...shared,
    config: PROFILE.riskConfig,
    correlationConfig: PROFILE.correlationConfig,
    ciiConsumer: { getScores: () => ({}) },
  })({ trace_id: TRACE_ID, intent, clock: verdictClock });

  const verdict: VerdictDecision = await buildVerdictStep({
    ...shared,
    tradingCalendar: venue.calendar,
    positionStore: store,
    config: opts.allowExtendedHours
      ? { ...PROFILE.verdictConfig, allow_extended_hours: true }
      : PROFILE.verdictConfig,
    approvals: { requestApproval: vi.fn(async () => 'approved' as const) },
    store: db,
  })({ trace_id: TRACE_ID, risk_decision: riskDecision, clock: verdictClock });

  const broker = makeBroker();
  const execution = await buildExecutionStep({
    clock: verdictClock,
    broker: broker as never,
    store,
    costModel: {} as never,
    marketData,
    config: PROFILE.executionConfig,
    sessionCalendars: OPEN_SESSION_CALENDARS,
    residualExposureAlerts: { postResidualExposureAlert: async () => {} },
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
    logger: { log: vi.fn() },
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
  })(verdict);

  return {
    now,
    verdictNow,
    bar,
    intent,
    riskDecision,
    verdict,
    execution,
    broker,
    sessionEnd,
    session,
  };
}

const VENUES: readonly Venue[] = [
  { name: 'US', calendar: new UsEquityRegularHoursCalendar(), expectedSignalAgeMinutes: 56 },
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

        expect(intent.metadata.exit_reason).toBe('flatten');
        expect(intent.decision_timestamp).toEqual(bar);
        const signalAgeMs = now.getTime() - intent.decision_timestamp.getTime();
        expect(signalAgeMs / 60_000).toBe(venue.expectedSignalAgeMinutes);
        expect(signalAgeMs).toBeGreaterThan(PROFILE.verdictConfig.max_signal_age.stocks);
      });

      it('is not refused by Verdict, and submits a flatten at the venue', async () => {
        const { intent, verdict, execution, broker } = await driveFlatten(venue);

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

        expect(intent.metadata.mandatory_flatten).toBe(true);
      });

      it('is not refused by Verdict when decided_at goes stale mid-pipeline (#1190)', async () => {
        const { intent, verdictNow, verdict, execution, broker } = await driveFlatten(venue, {
          verdictDelayMs: PROFILE.verdictConfig.max_signal_age.stocks + 60_000,
          allowExtendedHours: true,
        });

        const signalAgeMs = verdictNow.getTime() - intent.decided_at.getTime();
        expect(signalAgeMs).toBeGreaterThan(PROFILE.verdictConfig.max_signal_age.stocks);

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
    });
  }
});

describe('#1388: a mandatory flatten verdicted after the close still reaches Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const venue of VENUES) {
    describe(`${venue.name} close`, () => {
      it('is not refused by Verdict when verdicted 10s after the bell, and submits at the venue', async () => {
        const { verdictNow, sessionEnd, verdict, execution, broker, intent } = await driveFlatten(
          venue,
          { verdictDelayMs: 4 * 60_000 + 10_000 },
        );

        expect(verdictNow.getTime()).toBeGreaterThan(sessionEnd.getTime());
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
    });
  }

  it('still refuses an entry with market_closed after the close — the exemption does not widen to entries', async () => {
    const venue = VENUES[0];
    const sessionEnd = venue.calendar.sessionEnd(SESSION_DAY);
    if (sessionEnd === null) throw new Error(`${venue.name}: calendar resolved no session close`);
    const verdictAt = new Date(sessionEnd.getTime() + 10_000);
    const clock: Clock = { now: () => verdictAt };

    const entryIntent: OrderIntent = {
      idempotency_key: 'entry-1388',
      instrument: INSTRUMENT,
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      size: 10,
      entry: 100,
      stop: 95,
      target: 110,
      time_in_force: 'day',
      decision_timestamp: verdictAt,
      decided_at: verdictAt,
      metadata: {
        debate_id: 'debate-1388-entry',
        conviction: 0.7,
        converged: true,
        sizing: {
          base_risk_fraction: 0.01,
          conviction_multiplier: 1,
          vol_floor_factor: 1,
          non_converged_haircut: 1,
          cosine_multiplier: 1,
        },
        cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
      },
    };
    const riskDecision: RiskDecision = {
      status: 'approved',
      order_intent: entryIntent,
      modifications: null,
      binding_constraint: null,
      reasons: [],
      risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
      warnings: [],
      next_breaker_state: [],
    };

    const db = openSharedStore(':memory:');
    const store = new SqliteExecutionStore(db);
    const marketData = makeMarketData(verdictAt);

    const verdict = await buildVerdictStep({
      marketData,
      circuitBreakers: makeBreakers(),
      accountState: ACCOUNT_STATE,
      volatility: VOLATILITY,
      getOpenPositions: () => store.getOpenPositions(),
      maxMarkAge: MAX_MARK_AGE,
      mode: 'paper' as const,
      breakerState: { save: () => {} },
      portfolioSnapshots: new Map(),
      tradingCalendar: venue.calendar,
      positionStore: store,
      config: PROFILE.verdictConfig,
      approvals: { requestApproval: vi.fn(async () => 'approved' as const) },
      store: db,
    })({ trace_id: TRACE_ID, risk_decision: riskDecision, clock });

    expect(verdict.status).toBe('no_go');
    expect(verdict.no_go_reason).toBe('market_closed');
  });
});

describe('#1389: a lot held past the bell is still flattened inside the grace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const venue of VENUES) {
    describe(`${venue.name} close`, () => {
      it('decides the mandatory flatten 10s AFTER the close and submits it at the venue', async () => {
        const { intent, now, sessionEnd, verdict, execution, broker } = await driveFlatten(venue, {
          decisionOffsetMs: 10_000,
        });

        expect(now.getTime()).toBeGreaterThan(sessionEnd.getTime());
        expect(intent.metadata.exit_reason).toBe('flatten');
        expect(intent.metadata.mandatory_flatten).toBe(true);
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

      it('does not re-flatten across the bell: the post-close drive dedupes against the in-window one', async () => {
        const noneInFlight = async () => [];

        const inWindow = await driveFlatten(venue, { unresolvedFlattens: noneInFlight });
        expect(inWindow.execution.status).toBe('submitted');
        expect(inWindow.broker.submitFlatten).toHaveBeenCalledTimes(1);

        const afterBell = await driveFlatten(venue, {
          decisionOffsetMs: 10_000,
          session: inWindow.session,
          unresolvedFlattens: noneInFlight,
        });

        expect(afterBell.intent.idempotency_key).toBe(inWindow.intent.idempotency_key);
        expect(afterBell.verdict.status).toBe('no_go');
        expect(afterBell.verdict.no_go_reason).toBe('dedup');
        expect(afterBell.broker.submitFlatten).not.toHaveBeenCalled();
      });

      it('skips the flatten entirely while an unresolved flatten for the instrument is in flight', async () => {
        const inWindow = await driveFlatten(venue);
        expect(inWindow.broker.submitFlatten).toHaveBeenCalledTimes(1);

        await expect(
          driveFlatten(venue, { decisionOffsetMs: 10_000, session: inWindow.session }),
        ).rejects.toThrow('the tick path produced no flatten intent');
      });
    });
  }
});
