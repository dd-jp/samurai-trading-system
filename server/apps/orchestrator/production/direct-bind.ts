/**
 * Production Composition Root: direct-bind TickSteps (#234, ADR-0004).
 * Binds `trader`/`risk`/`verdict`/`execution` — this module only wires; it
 * does not modify any stage's decision logic.
 *
 * `risk` and `verdict` need per-call inputs their native inputs require but
 * `TickSteps` doesn't carry — assembled here from real sources where one
 * exists, and from an explicitly injected seam (`AccountStateProvider`,
 * `VolatilityReadingProvider`) where none does yet.
 */

import type {
  BrokerAdapter,
  ExecutionConfig,
  FilledZeroSizeThrottle,
  FlattenOverfillAlertChannel,
  FlattenReconcileAlertChannel,
  NonSterlingFeeAlertChannel,
  ResidualExposureAlertChannel,
  SharedStore,
  UnattributedFlattenFillAlertChannel,
  UnrecordedVenuePositionAlertChannel,
  UnrecordedVenuePositionThrottle,
} from '../../../pipeline/execution/index.js';
import { ExecutionImpl } from '../../../pipeline/execution/index.js';
import type {
  BreakerEvalInput,
  BreakerState,
  BreakerStatePersistence,
  CircuitBreakers,
  PersistedBreakerState,
  PortfolioView,
  RiskConfig,
  RiskCriticProducer,
  RiskCriticVerdict,
  RiskDecision,
  RiskThresholdSource,
  SessionBasisByClass,
  VolatilityReading,
} from '../../../pipeline/risk-manager/index.js';
import {
  type CorrelationConfig,
  computeCorrelationEstimate,
  computePortfolioView,
  countryForInstrument,
  PerSubclassCapUnresolvableError,
  RISK_CRITIC_SKIPPED_REASON,
  RiskManagerImpl,
} from '../../../pipeline/risk-manager/index.js';
import type {
  TraderConfig,
  TraderDiagnostic,
  UnresolvedFlatten,
} from '../../../pipeline/trader/index.js';
import {
  checkExitsWithReason,
  decideWithReason,
  mostRecentOpenLot,
} from '../../../pipeline/trader/index.js';
import type {
  ApprovalChannel,
  PositionStore,
  TradeChannelNotifier,
  VerdictConfig,
} from '../../../pipeline/verdict/index.js';
import {
  LoggingVerdict,
  NotifyingVerdict,
  SqliteVerdictLogStore,
  VerdictImpl,
} from '../../../pipeline/verdict/index.js';
import type {
  MarketDataService,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import type { CiiConsumer } from '../../../providers/market-intelligence/index.js';
import type {
  AssetClass,
  Clock,
  Logger,
  OpenPosition,
  OrderIntent,
  RiskLogStore,
  SetupStore,
  TraderLogStore,
  TradingArm,
} from '../../../shared/index.js';
import {
  describeThrown,
  isThresholdBoundViolation,
  safeLog,
  sanitizeLogText,
} from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { guardedStore } from '../../../shared/store/index.js';
import type { CostModel } from '../../../tools/backtest/index.js';
import { OrphanVerdictScanner } from '../orphan-verdict-scan.js';
import { SqliteAuditLog } from '../sqlite-audit-log.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
import type { TickSteps } from '../types.js';
import type { CapitalCeilingUsd } from './capital-ceiling.js';
import { ExitSkipWriteThrottle } from './exit-skip-write-throttle.js';
import type {
  ExitValuationDegradedAlert,
  ExitValuationDegradedAlertChannel,
} from './exit-valuation-alert.js';
import type { ThresholdClampAlertChannel } from './threshold-clamp-alert.js';
import {
  type TraderDiagnosticAlert,
  type TraderDiagnosticAlertChannel,
  TraderDiagnosticThrottle,
} from './trader-diagnostic-alert.js';

/**
 * Account-level accounting scalars `computePortfolioView` needs but has no
 * in-repo source for (realized PnL / fill history isn't tracked yet); tests
 * inject a fake
 */
export interface AccountStateProvider {
  getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    /**
     * Session-open equity and realized PnL per class (#332) — not a finished
     * percentage; `computePortfolioView` adds the unrealized term and divides
     */
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }>;
}

/**
 * Realized-vol reading for the volatility breaker tier.
 * `MarketDataVolatilityReadingProvider` (#277) implements this; kept a
 * required constructor dependency since `AccountStateProvider` alongside it
 * still has no in-repo implementation.
 */
export interface VolatilityReadingProvider {
  getVolatilityReading(asOf: Date): Promise<VolatilityReading>;
}

export interface TraderStepDeps extends BreakerStateDeps {
  config: TraderConfig;
  /**
   * Which arm of #753's measurement this bind decides for. Absent = `'live'`.
   * Reaches the idempotency key and `OrderIntentMetadata.arm` only — all
   * decision parameters still come from the one shared `config`.
   */
  arm?: TradingArm;
  /**
   * #568: `SharedStore.getExitFillSizes`, bound to the SAME store
   * `getOpenPositions` reads — `executeExit` refuses any exit whose size
   * doesn't match this same derivation
   */
  getExitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  /**
   * #1389: `SharedStore.getUnresolvedFlattens`, bound to the same store as
   * above (arm-scoped, migration 0050). Required — forgetting it restores
   * the second-flatten over-sell silently, on the money path.
   */
  getUnresolvedFlattens: () => Promise<readonly UnresolvedFlatten[]>;
  /**
   * #432: the same `SetupStore` instance `withOnTradeClose` labels through —
   * two halves of one table, must not be independently-constructed stores
   */
  setupStore: SetupStore;
  /**
   * #668: when each asset class's venue closes, for ADR-0014's flat-by-close.
   * Required — an optional calendar would leave the flatten unarmed in a way
   * indistinguishable from a market that never gave a setup.
   */
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  /** #328: the decision record. Optional so a test/backtest can stay silent. */
  traderLog?: TraderLogStore;
  /**
   * The declared capital ceiling (#511). Undefined on backtest/most tests;
   * defined on paper (since #1112) and live runs. On live it is NOT
   * currency-checked — the name asserts USD and the operator carries that
   * obligation. Absent means "no ceiling declared", never zero. See `sizingEquity`.
   */
  capitalCeilingUsd?: CapitalCeilingUsd;
  /**
   * #698: where a degraded-but-continuing Trader condition is escalated.
   * Optional — absent means log-only; a missing channel only changes who
   * hears about it, not what the system does.
   */
  traderDiagnosticAlerts?: TraderDiagnosticAlertChannel;
  /** Fallback sink for an undeliverable diagnostic alert, and this step's own logging */
  logger?: Logger;
}

/**
 * The equity the Trader may size against — `min(declared ceiling, real
 * equity)` (#511). Bounds only the sizing inlet, not the resulting notional
 * (`riskFraction / stopDistance` isn't itself capped at 1) and not the
 * `RiskConfig` fraction-based caps, which multiply live `portfolio.equity` separately.
 *
 * Applied here and NOT inside `computePortfolioView`: that same `equity` is
 * the denominator of `drawdown_pct`, so clamping the observation would
 * understate a real drawdown and quietly disarm the breakers.
 *
 * The parameter is the `CapitalCeilingUsd` brand, not a `number`, so a `NaN`
 * ceiling can't silently propagate as "no bound" through `decide`'s sizing (#569).
 */
export function sizingEquity(
  equity: number,
  capitalCeilingUsd: CapitalCeilingUsd | undefined,
): number {
  return capitalCeilingUsd === undefined ? equity : Math.min(equity, capitalCeilingUsd);
}

export function buildTraderStep(deps: TraderStepDeps): TickSteps['trader'] {
  return buildTraderSteps(deps).trader;
}

/**
 * `TraderOutcome` carries no `debate_id` for a skip, so it's recomputed here
 * from the same `positions` snapshot via the exported `mostRecentOpenLot`
 * (decide.ts) rather than a second selection that could drift from it
 */
function mostRecentDebateId(positions: readonly OpenPosition[], instrument: string): string | null {
  const held = positions.filter((lot) => lot.instrument === instrument);
  if (held.length === 0) return null;
  return mostRecentOpenLot(held).debate_id;
}

/**
 * The Trader's two step bindings (#743) — `trader` (decision-path) and
 * `exitCheck` (tick-path) — share ONE diagnostic throttle. Two throttles
 * would each see gaps the other filled and under-count consecutive ticks (#698/#710).
 */
export function buildTraderSteps(deps: TraderStepDeps): {
  trader: TickSteps['trader'];
  exitCheck: TickSteps['exitCheck'];
} {
  // #698: per-step-set, not per-tick — the counter relates this tick to the
  // ones before it, so it must outlive the closure body
  const diagnosticThrottle = new TraderDiagnosticThrottle();

  // #1128: the exit-check skip write gate — see `exit-skip-write-throttle.ts`
  // for why "differs from the last written reason" alone can't bound volume
  const exitSkipThrottle = new ExitSkipWriteThrottle();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: statement order is individually documented as load-bearing — the equity read is captured eagerly and its failure deferred (#847, not laziness), the trader_log write happens for a null intent too (#328) and BEFORE the diagnostics escalation (the durable record must land before the audible copy), and exitSkipThrottle.clearEpisode must run on this path too, not only exitCheck's (#1128 round 3) — extraction risks silently reordering one of these
  const trader: TickSteps['trader'] = async ({ trace_id, instrument, debate, clock }) => {
    // TraderInput.equity is the same portfolio OBSERVATION Risk gates
    // against this tick — memoized per trace so the two stages can't see two
    // different portfolios (B4)
    //
    // #847: capture-and-rethrow, not laziness. The read stays eager since
    // `computeCurrentPortfolioAndBreakers` also runs breaker evaluation and
    // persists sticky tiers — a lazy read would skip that on every no-trade
    // bar. Only the FAILURE is deferred: a strict-valuation throw is held and
    // re-raised, unwrapped, from inside `buildBracket`, so an entry still
    // aborts the tick (#507) while a flat-by-close branch that never reads
    // equity gets to run (ADR-0014)
    let snapshot: PortfolioSnapshot | null = null;
    let snapshotError: unknown = null;
    try {
      snapshot = await snapshotForTick(deps, clock, trace_id);
    } catch (error) {
      snapshotError = error;
    }
    const { intent, skip_reason, decision_class, reason_detail, atr, diagnostics } =
      await decideWithReason({
        trace_id,
        instrument,
        debate,
        clock,
        // #753: omitted rather than `undefined`, matching `TraderInput.arm`'s default
        ...(deps.arm === undefined ? {} : { arm: deps.arm }),
        marketData: deps.marketData,
        // #847: either the strict whole-book equity or the strict read's own
        // throw — never a partial figure, since every exposure cap reads an
        // absent instrument as zero exposure
        equity: async () => {
          if (snapshot === null) throw snapshotError;
          return sizingEquity(snapshot.portfolio.equity, deps.capitalCeilingUsd);
        },
        config: deps.config,
        positionState: deps.getOpenPositions,
        // #568: the same store the lots came from, so the Trader's sizing and
        // `executeExit`'s validation compute off ONE fill record
        exitFillSizes: deps.getExitFillSizes,
        // #1389: bound on both trader binds — `routeDecision`'s holding
        // branch reaches the flatten too
        unresolvedFlattens: deps.getUnresolvedFlattens,
        setupStore: deps.setupStore,
        sessionCalendars: deps.sessionCalendars,
        // #826: wired on both trader binds, since the decision path can also
        // reach the flatten (`routeDecision`'s holding branch)
        onUnpricedFlatten: (report) =>
          reportExitValuationDegraded(
            deps,
            'trader',
            { trace_id, instrument, clock },
            { unvalued_instruments: [report.instrument], reason: report.reason },
          ),
      });

    // Written for a null intent too (#328) — a skip is a decision, and
    // `TickOutcome.final_stage` records where a tick stopped but never why
    deps.traderLog?.write({
      trace_id,
      instrument,
      debate_id: debate.debate_id,
      intent_type: intent?.intent_type ?? null,
      // #748: null on entry/scale-in/skip — set exactly when there's an
      // exit, and on this path that's the flatten or direction flip
      exit_reason: intent?.metadata.exit_reason ?? null,
      // The actual reason, since #475 — used to be one constant for all 13 skip paths
      skip_reason,
      // #1109: distinguishes "the debate said no" from "produced nothing
      // usable" for the same `skip_reason` string (see `TraderDecisionClass`)
      decision_class,
      reason_detail,
      sizing: intent?.metadata.sizing ?? null,
      cosine_precedent: intent?.metadata.cosine_precedent ?? null,
      atr,
      entry: intent?.entry ?? null,
      stop: intent?.stop ?? null,
      size: intent?.size ?? null,
      created_at: clock.now(),
    });

    // #1128: a debate-bar decision can also fire the exit (`routeDecision`'s
    // holding branch), not only `exitCheck`'s own tick-path handling — so
    // whichever binding closes the lot must clear this instrument's episode
    // state, or a reopened lot's first skip row reads as a suppressed repeat
    if (intent?.intent_type === 'exit') exitSkipThrottle.clearEpisode(instrument);

    // #698: escalate anything noticed but not fatal. AFTER the trader_log
    // write on purpose — the durable record must land regardless of transport
    escalateTraderDiagnostics(
      deps,
      diagnosticThrottle,
      { trace_id, instrument, clock },
      diagnostics,
    );

    return intent;
  };

  const exitCheck: TickSteps['exitCheck'] = async ({ trace_id, instrument, bar, clock }) => {
    // No `snapshotForTick` here: an exit sizes to held quantity, never
    // equity, so the tick path skips the account read entirely (#743)
    // Memoized into `positionState` below rather than passed through
    // directly, since `mostRecentDebateId` needs the same snapshot (#1128)
    const positions = await deps.getOpenPositions();
    const { intent, skip_reason, decision_class, reason_detail, atr, diagnostics } =
      await checkExitsWithReason({
        trace_id,
        instrument,
        clock,
        bar,
        // #753: see the decision bind above — both arms flatten the same instrument on the same bar
        ...(deps.arm === undefined ? {} : { arm: deps.arm }),
        marketData: deps.marketData,
        config: deps.config,
        positionState: async () => positions,
        exitFillSizes: deps.getExitFillSizes,
        unresolvedFlattens: deps.getUnresolvedFlattens,
        sessionCalendars: deps.sessionCalendars,
        // #826: this is the binding that matters most — the mandatory
        // flat-by-close flatten is decided on the tick path, so an unpriced
        // flatten during a stall is overwhelmingly raised here
        onUnpricedFlatten: (report) =>
          reportExitValuationDegraded(
            deps,
            'trader',
            { trace_id, instrument, clock },
            { unvalued_instruments: [report.instrument], reason: report.reason },
          ),
      });

    recordExitCheckOutcome(deps, exitSkipThrottle, positions, {
      trace_id,
      instrument,
      clock,
      intent,
      skip_reason,
      decision_class,
      reason_detail,
      atr,
    });

    escalateTraderDiagnostics(
      deps,
      diagnosticThrottle,
      { trace_id, instrument, clock },
      diagnostics,
    );

    return intent;
  };

  return { trader, exitCheck };
}

// The three branches are mutually exclusive outcomes of one
// `checkExitsWithReason` call, not an ordered sequence — see the inline
// comments for why each branch's own throttle bookkeeping is shaped as it is.
function recordExitCheckOutcome(
  deps: TraderStepDeps,
  exitSkipThrottle: ExitSkipWriteThrottle,
  positions: readonly OpenPosition[],
  tick: {
    trace_id: string;
    instrument: string;
    clock: Clock;
    intent: Awaited<ReturnType<typeof checkExitsWithReason>>['intent'];
    skip_reason: Awaited<ReturnType<typeof checkExitsWithReason>>['skip_reason'];
    decision_class: Awaited<ReturnType<typeof checkExitsWithReason>>['decision_class'];
    reason_detail: Awaited<ReturnType<typeof checkExitsWithReason>>['reason_detail'];
    atr: Awaited<ReturnType<typeof checkExitsWithReason>>['atr'];
  },
): void {
  const { trace_id, instrument, clock, intent, skip_reason, decision_class, reason_detail, atr } =
    tick;

  // A fired flatten IS a decision and is recorded like one — an exit is never volume noise
  if (intent !== null) {
    deps.traderLog?.write({
      trace_id,
      instrument,
      debate_id: intent.metadata.debate_id,
      intent_type: intent.intent_type,
      exit_reason: intent.metadata.exit_reason ?? null,
      skip_reason: null,
      decision_class: null,
      reason_detail: null,
      sizing: intent.metadata.sizing,
      cosine_precedent: intent.metadata.cosine_precedent,
      atr: null,
      entry: intent.entry,
      stop: intent.stop,
      size: intent.size,
      created_at: clock.now(),
    });
    // #1128: cleared here rather than on the next observation, since a
    // position can close and reopen in one tick gap with no exit-check
    // ever observing it flat in between
    exitSkipThrottle.clearEpisode(instrument);
  } else if (skip_reason === 'no_open_position') {
    // #1128: no lot open means no debate to attribute a row to
    // (`trader_log.debate_id` is NOT NULL), but it's still an episode
    // boundary, same as a fired exit above
    exitSkipThrottle.clearEpisode(instrument);
  } else if (skip_reason !== null) {
    // #1128: change-only for most reasons — #743 measured ~30 exit-check
    // calls per bar per instrument, and a row per call would bury the
    // decision records under a flat/held instrument repeating its answer
    let wrote = false;
    if (exitSkipThrottle.shouldWrite(instrument, skip_reason)) {
      // Every other exit-path skip fires with at least one lot open (see
      // `no_open_position` above for the one exception)
      const debate_id = mostRecentDebateId(positions, instrument);
      if (debate_id !== null) {
        deps.traderLog?.write({
          trace_id,
          instrument,
          debate_id,
          intent_type: null,
          exit_reason: null,
          skip_reason,
          decision_class,
          reason_detail,
          sizing: null,
          cosine_precedent: null,
          atr,
          entry: null,
          stop: null,
          size: null,
          created_at: clock.now(),
        });
        wrote = true;
      }
    }
    exitSkipThrottle.record(instrument, skip_reason, wrote);
  }
}

/**
 * The #698/#710 diagnostic reporting, shared by both Trader step bindings.
 * Every diagnostic feeds the throttle (even non-alerting ones, since
 * `observe` is what clears a run), but the log writes on EVERY observation
 * while the alert is throttled separately (#710) — they used to be one call,
 * and the log inherited the alert's throttle and went quiet for 7 ticks in 8.
 */
function escalateTraderDiagnostics(
  deps: TraderStepDeps,
  diagnosticThrottle: TraderDiagnosticThrottle,
  tick: { trace_id: string; instrument: string; clock: Clock },
  diagnostics: readonly TraderDiagnostic[],
): void {
  const { trace_id, instrument, clock } = tick;
  for (const observed of diagnosticThrottle.observe(instrument, diagnostics)) {
    const { diagnostic, consecutive_ticks } = observed;
    deps.logger?.log({
      trace_id,
      stage: 'trader',
      event: 'trader_diagnostic_persistent',
      level: 'error',
      message:
        `trader: ${instrument} reported ${diagnostic.kind} on ` +
        `${consecutive_ticks} consecutive tick(s) — ${diagnostic.detail}`,
      payload: {
        instrument,
        kind: diagnostic.kind,
        asset_class: diagnostic.asset_class,
        consecutive_ticks,
      },
    });

    if (!observed.alert) continue;

    // NOT awaited (#710): this step's return value is what Risk and
    // Execution act on, so awaiting a slow send here would put the transport
    // in front of the order — including the flat-by-close exit
    void postTraderDiagnosticAlert(deps, trace_id, {
      instrument,
      diagnostic,
      consecutive_ticks,
      reported_at: clock.now(),
    }).catch(() => {
      // Unreachable except if `logger.log` itself throws — a floating
      // rejection would take the orchestrator down on an unattended soak
    });
  }
}

/**
 * Posts one diagnostic alert, never letting the transport take the tick down
 * with it (#698). The caller already logs at `error` before calling this, so
 * the condition is never silent even log-only. `traceId` is the tick's own,
 * so a soak post-mortem can join this line to the debate/verdict for the same tick.
 */
async function postTraderDiagnosticAlert(
  deps: TraderStepDeps,
  traceId: string,
  alert: TraderDiagnosticAlert,
): Promise<void> {
  const { diagnostic } = alert;
  if (deps.traderDiagnosticAlerts === undefined) return;
  try {
    await deps.traderDiagnosticAlerts.postTraderDiagnosticAlert(alert);
  } catch (error) {
    deps.logger?.log({
      trace_id: traceId,
      stage: 'trader',
      event: 'trader_diagnostic_alert_send_failed',
      level: 'error',
      message:
        'trader diagnostic alert could not be delivered — the condition is still present and ' +
        'nobody has been told',
      payload: {
        instrument: alert.instrument,
        kind: diagnostic.kind,
        error: sanitizeLogText(error instanceof Error ? error.message : String(error)),
      },
    });
  }
}

/** Shared by risk and verdict: both need the portfolio-derived breaker state, fetched fresh at their own call time */
interface BreakerStateDeps {
  marketData: MarketDataService;
  circuitBreakers: CircuitBreakers;
  /**
   * Where the sticky breakers' state lands after every evaluation, so a
   * tripped hard-drawdown breaker survives a restart (#203). Required — an
   * omitted seam is what left `breaker_state` unwritten for the life of the project.
   */
  breakerState: BreakerStatePersistence;
  accountState: AccountStateProvider;
  volatility: VolatilityReadingProvider;
  getOpenPositions: () => Promise<OpenPosition[]>;
  mode: 'live' | 'paper' | 'backtest';
  /**
   * #640: how old a valuation mark may be before the book is refused. Lives
   * here (not `RiskStepDeps`) since the trader and risk binds share one
   * snapshot per tick.
   */
  maxMarkAge: Record<AssetClass, number>;
  /**
   * Per-tick memo (B4): the Trader computes the portfolio snapshot, Risk
   * reuses it, so both gate against ONE observation. Verdict never reads
   * this — its breaker re-check is specced to see current state, not the
   * tick's earlier snapshot.
   */
  portfolioSnapshots: Map<string, PortfolioSnapshot>;
  /**
   * #841: where an exit priced against a partly-valued book is escalated.
   * On `BreakerStateDeps` since both Risk and Verdict can hit this on the
   * same tick. Absent = log-only; both seams also write an `error` line first.
   */
  exitValuationAlerts?: ExitValuationDegradedAlertChannel;
  /** Sink for the `error` lines both seams above write, and #726's guarded `riskLog.write` failure */
  logger?: Logger;
}

/** One tick's portfolio + breaker observation — see `BreakerStateDeps.portfolioSnapshots` */
export interface PortfolioSnapshot {
  portfolio: Awaited<ReturnType<typeof computePortfolioView>>;
  breakers: ReturnType<CircuitBreakers['evaluate']>;
  /**
   * The persisted tiers as of THIS observation (#1019), read in the same
   * synchronous step as `breakers` rather than after the caller's `await` —
   * `circuitBreakers` is one instance shared across concurrently-running
   * instruments (#1013), so a later read could attribute another
   * instrument's advanced state to this one's `risk_log` row
   */
  next_breaker_state: ReturnType<CircuitBreakers['getPersistedState']>;
}

/**
 * Bounds the memo against ticks whose Risk stage never ran. 64 is far above
 * any concurrent instrument count; eviction is oldest-first insertion order.
 */
const MAX_SNAPSHOT_ENTRIES = 64;

async function snapshotForTick(
  deps: BreakerStateDeps,
  clock: Clock,
  trace_id: string,
): Promise<PortfolioSnapshot> {
  const cached = deps.portfolioSnapshots.get(trace_id);
  if (cached !== undefined) return cached;
  const snapshot = await computeCurrentPortfolioAndBreakers(deps, clock);
  deps.portfolioSnapshots.set(trace_id, snapshot);
  for (const key of deps.portfolioSnapshots.keys()) {
    if (deps.portfolioSnapshots.size <= MAX_SNAPSHOT_ENTRIES) break;
    deps.portfolioSnapshots.delete(key);
  }
  return snapshot;
}

async function computeCurrentPortfolioAndBreakers(deps: BreakerStateDeps, clock: Clock) {
  const asOf = clock.now();
  const [positions, account, volatility] = await Promise.all([
    deps.getOpenPositions(),
    deps.accountState.getAccountState(asOf),
    deps.volatility.getVolatilityReading(asOf),
  ]);
  const portfolio = await computePortfolioView({
    positions,
    marketData: deps.marketData,
    asOf,
    clock,
    cash: account.cash,
    peak_equity: account.peak_equity,
    daily_basis: account.daily_basis,
    consecutive_losses: account.consecutive_losses,
    max_mark_age: deps.maxMarkAge,
  });
  const breakerInput: BreakerEvalInput = { portfolio, volatility, mode: deps.mode, clock };
  const breakers = deps.circuitBreakers.evaluate(breakerInput);
  // Persist the sticky tiers immediately: a restart between this call and a
  // later persist point would silently re-arm ADR-0007's mechanism. Read
  // ONCE and both persisted and carried on the snapshot (#1019) — see
  // `PortfolioSnapshot.next_breaker_state`
  const next_breaker_state = deps.circuitBreakers.getPersistedState();
  deps.breakerState.save(next_breaker_state);
  return { portfolio, breakers, next_breaker_state };
}

/** One tick's exit valuation, and what it had to leave out to produce one (#841) */
interface ExitValuationDegradation {
  /** The held instruments left unvalued — never empty when this object exists */
  unvalued_instruments: readonly string[];
  /** The strict refusal's own message, naming each dark instrument and why */
  reason: string;
}

/**
 * The breaker state a DEGRADED valuation is allowed to report (#841). Read
 * off the sticky tiers rather than produced by `evaluate()`: a partial view
 * understates `equity` and overstates `drawdown_pct`, so feeding it to
 * `evaluate()` could trip the hard-drawdown breaker off a mark that was
 * merely late. The stateless tiers read as NOT tripped instead — on the exit
 * path an un-tripped breaker lets the flatten through, protecting
 * ADR-0014's flat-by-close. An entry never sees this state.
 */
function breakersFromStickyState(state: readonly PersistedBreakerState[]): BreakerState {
  const armed_breakers: string[] = [];
  let tripped = false;
  for (const row of state) {
    if (!row.tripped) continue;
    tripped = true;
    armed_breakers.push(row.reason ?? row.tier);
  }
  return {
    portfolio_tripped: tripped,
    asset_class_tripped: { crypto: tripped, stocks: tripped },
    armed_breakers,
  };
}

/**
 * The same observation as `computeCurrentPortfolioAndBreakers`, but valuing
 * whatever CAN be valued instead of refusing the book (#841). No volatility
 * read and no `evaluate()`/`save()` — see `breakersFromStickyState`. Never
 * memoized: a partial view must never become the observation an entry is sized against.
 */
async function degradedPortfolioForExit(
  deps: BreakerStateDeps,
  clock: Clock,
): Promise<PortfolioSnapshot> {
  const asOf = clock.now();
  const [positions, account] = await Promise.all([
    deps.getOpenPositions(),
    deps.accountState.getAccountState(asOf),
  ]);
  const portfolio = await computePortfolioView({
    positions,
    marketData: deps.marketData,
    asOf,
    clock,
    cash: account.cash,
    peak_equity: account.peak_equity,
    daily_basis: account.daily_basis,
    consecutive_losses: account.consecutive_losses,
    max_mark_age: deps.maxMarkAge,
    // The one call site in the tree that opts in — see `PortfolioAccountingInput.unvaluable_marks`
    unvaluable_marks: 'exclude',
  });
  const next_breaker_state = deps.circuitBreakers.getPersistedState();
  return {
    portfolio,
    breakers: breakersFromStickyState(next_breaker_state),
    next_breaker_state,
  };
}

/**
 * The EXIT path's valuation (#841): the strict whole-book view when one can
 * be produced, a partial one (plus the report that says so) when it cannot.
 * Strict FIRST, always — degrading is a fallback from a throw, never a mode.
 *
 * A throw the degraded attempt CANNOT explain is re-raised unchanged: the
 * degraded attempt skips the volatility read and `evaluate()`/`save()`, so
 * it can succeed while the real (non-mark) fault is still there.
 *
 * `computeStrict` is passed in since Risk and Verdict derive the strict view
 * differently by spec (Risk reuses the per-trace memo, Verdict re-derives fresh).
 */
async function snapshotForExit(
  deps: BreakerStateDeps,
  clock: Clock,
  computeStrict: () => Promise<PortfolioSnapshot>,
): Promise<{ snapshot: PortfolioSnapshot; degradation: ExitValuationDegradation | null }> {
  try {
    return { snapshot: await computeStrict(), degradation: null };
  } catch (error) {
    const reason = describeThrown(error);
    const snapshot = await degradedPortfolioForExit(deps, clock);
    const unvalued_instruments = snapshot.portfolio.unvalued_instruments;
    if (unvalued_instruments.length === 0) throw error;
    return { snapshot, degradation: { unvalued_instruments, reason } };
  }
}

/**
 * Makes a degraded exit valuation audible (#841): an `error` line always,
 * plus operator escalation when a transport is wired. Not throttled or
 * latched (unlike #766's clamp alert — see `exit-valuation-alert.ts`).
 * Guarded like every alert post here: a throwing transport must not take
 * down the exit it was raised beside.
 */
function reportExitValuationDegraded(
  deps: BreakerStateDeps,
  seam: ExitValuationDegradedAlert['seam'],
  context: { trace_id: string; instrument: string; clock: Clock },
  degradation: ExitValuationDegradation,
): void {
  const { trace_id, instrument, clock } = context;
  const logger = deps.logger;
  if (logger !== undefined) {
    safeLog(logger, {
      trace_id,
      stage: seam,
      event: 'exit_valuation_degraded',
      level: 'error',
      // #826: a different condition, so a different line — 'trader' is about
      // the exited name having no price of its own, not the rest of the book
      message:
        seam === 'trader'
          ? `mandatory flatten sent with NO mark: ${instrument} — the flat-by-close exit went ` +
            'out unpriced rather than being missed (ADR-0014)'
          : `exit valued on a partly-valued book: ${instrument} — ` +
            `${degradation.unvalued_instruments.length} held instrument(s) could not be valued`,
      payload: {
        instrument,
        seam,
        unvalued_instruments: degradation.unvalued_instruments,
        reason: sanitizeLogText(degradation.reason),
      },
    });
  }
  try {
    deps.exitValuationAlerts?.postExitValuationDegradedAlert({
      instrument,
      seam,
      unvalued_instruments: degradation.unvalued_instruments,
      reason: degradation.reason,
      reported_at: clock.now(),
    });
  } catch (error) {
    if (logger !== undefined) {
      safeLog(logger, {
        trace_id,
        stage: seam,
        event: 'exit_valuation_alert_send_failed',
        level: 'error',
        message:
          'exit-valuation-degraded alert could not be delivered — the exit still went out on a ' +
          'partly-valued book and nobody has been paged',
        payload: { instrument, seam, error: sanitizeLogText(describeThrown(error)) },
      });
    }
  }
}

/**
 * The single member `buildRiskStep` actually calls, rather than the whole
 * `CiiConsumer` class — depending on the class made a `{ getScores }` test
 * stub impossible (private fields). `Pick`, not a fresh interface, so a
 * signature change still propagates here.
 */
type CiiScoreSource = Pick<CiiConsumer, 'getScores'>;

export interface RiskStepDeps extends BreakerStateDeps {
  config: RiskConfig;
  correlationConfig: CorrelationConfig;
  ciiConsumer: CiiScoreSource;
  /**
   * #433: the live `risk_thresholds` table, read at every `evaluate()`.
   * Optional so a test/backtest can stay on the static config.
   */
  thresholds?: RiskThresholdSource;
  /** #328: the decision record. Same optionality rationale as `traderLog`. */
  riskLog?: RiskLogStore;
  /** #766: where the catch below escalates a clamp trip. Absent = log-only. */
  thresholdClampAlerts?: ThresholdClampAlertChannel;
  /**
   * #957: check-pipeline step 7's producer. `undefined` is a safe state —
   * every decision keeps its `risk_critic: skipped` reason and the mechanical
   * steps remain the safety net. REQUIRED but nullable so omitting it at a
   * call site is a compile error, not a silently disarmed model check.
   */
  critic: RiskCriticProducer | undefined;
}

/**
 * Asks the critic producer for a verdict, and NEVER throws (#957): a throw
 * here would reach `buildRiskStep`'s catch and abort the tick, turning
 * "critic unreachable" into "risk stage crashed" (ADR-0003, #640)
 */
async function criticVerdictFor(
  deps: RiskStepDeps,
  context: { trace_id: string; intent: OrderIntent; portfolio: PortfolioView; clock: Clock },
): Promise<RiskCriticVerdict | undefined> {
  const { trace_id, intent, portfolio, clock } = context;
  try {
    return await deps.critic?.produce({
      trace_id,
      intent,
      portfolio: {
        equity: portfolio.equity,
        gross_exposure: portfolio.gross_exposure,
        held: Object.entries(portfolio.exposure_by_instrument).map(([instrument, notional]) => ({
          instrument,
          notional,
        })),
      },
      asOf: clock.now(),
    });
  } catch (error) {
    if (deps.logger) {
      safeLog(deps.logger, {
        trace_id,
        stage: 'risk',
        event: 'risk_critic_producer_threw',
        level: 'warn',
        message:
          'risk critic producer threw; the decision proceeds on the mechanical steps with ' +
          'risk_critic: skipped',
        payload: { instrument: intent.instrument, error: describeThrown(error) },
      });
    }
    return undefined;
  }
}

export function buildRiskStep(deps: RiskStepDeps): TickSteps['risk'] {
  const riskManager = new RiskManagerImpl(deps.config, deps.thresholds);
  // #766: latched per process, not per instrument — the fix is always
  // "correct the offending row", which doesn't change between ticks
  let clampAlertSent = false;

  return async ({ trace_id, intent, clock }) => {
    // Reuses the Trader's snapshot for this trace (B4); Risk is its last
    // reader. #841: an EXIT falls back to a PARTIAL valuation instead of
    // aborting — flattening a held position doesn't need the whole book
    // priced, unlike sizing an entry, which `RiskManagerImpl.evaluate` still
    // refuses on any `unvalued_instruments`
    async function resolveSnapshot() {
      const { snapshot, degradation } =
        intent.intent_type === 'exit'
          ? await snapshotForExit(deps, clock, () => snapshotForTick(deps, clock, trace_id))
          : { snapshot: await snapshotForTick(deps, clock, trace_id), degradation: null };
      const { portfolio, breakers } = snapshot;
      deps.portfolioSnapshots.delete(trace_id);
      if (degradation !== null) {
        reportExitValuationDegraded(
          deps,
          'risk',
          { trace_id, instrument: intent.instrument, clock },
          degradation,
        );
      }
      // Taken off the snapshot, not re-read (#1019 gap 2) — see
      // `PortfolioSnapshot.next_breaker_state`
      const next_breaker_state: PersistedBreakerState[] = snapshot.next_breaker_state;
      return { portfolio, breakers, next_breaker_state };
    }
    const { portfolio, breakers, next_breaker_state } = await resolveSnapshot();

    const otherInstruments = Object.keys(portfolio.exposure_by_instrument).filter(
      (instrument) => instrument !== intent.instrument,
    );
    const correlation = await computeCorrelationEstimate({
      instrument: intent.instrument,
      otherInstruments,
      marketData: deps.marketData,
      asOf: clock.now(),
      config: deps.correlationConfig,
    });

    const heldCountries = [intent.instrument, ...otherInstruments]
      .map((instrument) => countryForInstrument(instrument))
      .filter((country): country is string => country !== null);
    const cii = deps.ciiConsumer.getScores(heldCountries);

    const daily = portfolio.daily_pnl;
    function dailyPnlLogFields() {
      // Null pct rather than 0 when unknown (#333) — 0 would read as flat
      return {
        daily_pnl_portfolio_pct: daily.portfolio.known ? daily.portfolio.pct : null,
        daily_pnl_crypto_pct: daily.crypto.known ? daily.crypto.pct : null,
        daily_pnl_stocks_pct: daily.stocks.known ? daily.stocks.pct : null,
        daily_pnl_unknown_reason: daily.portfolio.known ? null : daily.portfolio.reason,
      };
    }
    const riskLogBase = {
      trace_id,
      instrument: intent.instrument,
      breakers: {
        portfolio_tripped: breakers.portfolio_tripped,
        crypto_tripped: breakers.asset_class_tripped.crypto,
        stocks_tripped: breakers.asset_class_tripped.stocks,
        armed_breakers: breakers.armed_breakers,
      },
      portfolio: {
        equity: portfolio.equity,
        drawdown_pct: portfolio.drawdown_pct,
        gross_exposure: portfolio.gross_exposure,
        consecutive_losses: portfolio.consecutive_losses,
        ...dailyPnlLogFields(),
      },
      created_at: clock.now(),
    };

    // #955: the critic must fire only on intents that reach step 7, but
    // `evaluate()` is pure/synchronous (#642) and can't know that in advance
    // So evaluate once with no verdict — reaching step 7 is what pushes
    // `RISK_CRITIC_SKIPPED_REASON`, which doubles as the "reached it" signal
    // — then evaluate again with the critic's verdict if it did. Only the
    // second decision is logged/returned
    async function evaluateWithCriticTwoPass(): Promise<RiskDecision> {
      const evaluateWith = (critic?: RiskCriticVerdict): RiskDecision =>
        riskManager.evaluate({
          trace_id,
          intent,
          clock,
          portfolio,
          breakers,
          next_breaker_state,
          correlation,
          cii,
          mode: deps.mode,
          ...(critic === undefined ? {} : { critic }),
        });

      const dryRun = evaluateWith();
      const reachedCritic = dryRun.reasons.includes(RISK_CRITIC_SKIPPED_REASON);
      const verdict =
        reachedCritic && deps.critic !== undefined
          ? await criticVerdictFor(deps, { trace_id, intent, portfolio, clock })
          : undefined;
      return verdict === undefined ? dryRun : evaluateWith(verdict);
    }

    // #726: `perSubclassDeploymentCap` throws rather than returning a
    // decision (deliberately, per its own doc comment), which skips the
    // `riskLog.write` below. This writes that row from the catch, naming the
    // unresolved subclass, then re-throws unchanged so #507's catch still
    // sees it
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: guarded the same way #507's own side effects are guarded (tick-loop.ts) — the riskLog write is wrapped so a write failure cannot replace the original error before it reaches #507's catch (the outer `throw error;` must always run), and clampAlertSent is a one-shot latch that must not double-post — extraction risks separating either guard from the write/throw it protects
    function recordRiskEvaluationError(error: unknown): void {
      const binding_constraint =
        error instanceof PerSubclassCapUnresolvableError
          ? error.bindingConstraint
          : `risk_evaluate_error:${intent.instrument}`;

      // #766: `isThresholdBoundViolation`, not `instanceof
      // ThresholdBoundViolationError` — two or more crossings in one read
      // throw a plain `Error` (threshold-bounds.ts), which `instanceof`
      // would miss on the more alarming case
      if (!clampAlertSent && isThresholdBoundViolation(error)) {
        clampAlertSent = true;
        deps.thresholdClampAlerts?.postThresholdClampAlert({
          trace_id,
          where: 'live-read',
          message: describeThrown(error),
          reported_at: clock.now(),
        });
      }

      // Guarded like #507's own side effects: must not throw and replace the
      // original error before it reaches #507's catch
      try {
        deps.riskLog?.write({
          ...riskLogBase,
          status: 'error',
          binding_constraint,
          reasons: [describeThrown(error)],
          original_size: null,
          final_size: null,
          stop_tightened: false,
        });
      } catch (logError) {
        if (deps.logger) {
          safeLog(deps.logger, {
            trace_id,
            stage: 'risk',
            event: 'risk_log_write_failed',
            level: 'error',
            message: `risk_log write failed for a gate throw on ${intent.instrument}`,
            payload: {
              instrument: intent.instrument,
              binding_constraint,
              original_error: describeThrown(error),
              log_error: describeThrown(logError),
            },
          });
        }
      }
    }

    let decision: RiskDecision;
    try {
      decision = await evaluateWithCriticTwoPass();
    } catch (error) {
      recordRiskEvaluationError(error);
      throw error;
    }

    // Written on rejection too — a rejected intent never reaches Verdict
    deps.riskLog?.write({
      ...riskLogBase,
      status: decision.status,
      binding_constraint: decision.binding_constraint,
      reasons: decision.reasons,
      original_size: decision.modifications?.original_size ?? null,
      final_size: decision.modifications?.final_size ?? null,
      stop_tightened: decision.modifications?.stop_tightened ?? false,
    });

    return decision;
  };
}

export interface VerdictStepDeps extends BreakerStateDeps {
  tradingCalendar: TradingCalendar;
  positionStore: PositionStore;
  config: VerdictConfig;
  approvals: ApprovalChannel;
  /**
   * #465: where notable verdicts go. Absent = log-only. `NotifyingVerdict`
   * filters before sending (see `notable-verdict.ts`).
   */
  verdictAlerts?: TradeChannelNotifier;
  /**
   * Backs `LoggingVerdict`'s `verdict_log` write (#302) — the same shared
   * handle every Sqlite* store here reads/writes through
   */
  store: StoreHandle;
}

/**
 * `LoggingVerdict` wraps `VerdictImpl` so every `decide()` persists a
 * `verdict_log` row (#302); without it `OrphanVerdictScanner` never finds a
 * row. `NotifyingVerdict` stays unwired here — #307 is deciding whether one
 * decorator or two is right once both are live.
 */
export function buildVerdictStep(deps: VerdictStepDeps): TickSteps['verdict'] {
  // #465: `NotifyingVerdict` OUTSIDE `LoggingVerdict`, so the row is written
  // before anyone is told
  const logging = new LoggingVerdict(
    new VerdictImpl(),
    // #837 M9: the Verdict stage owns `verdict_log` and nothing else
    new SqliteVerdictLogStore(guardedStore(deps.store, 'verdict')),
  );
  const verdict =
    deps.verdictAlerts === undefined ? logging : new NotifyingVerdict(logging, deps.verdictAlerts);

  return async ({ trace_id, risk_decision, clock }) => {
    // Re-checks current breaker state rather than reusing Risk's snapshot —
    // Verdict can fire late enough for a breaker to trip/clear in between
    // (verdict-spec.md gate 5). #841: an exit degrades to the sticky breaker
    // tiers (`breakersFromStickyState`) rather than a partial re-evaluation,
    // for the same reason as `buildRiskStep`'s fallback
    //
    // `order_intent` is null only on a rejection, which never reaches Verdict
    const isExit = risk_decision.order_intent?.intent_type === 'exit';
    const { snapshot, degradation } = isExit
      ? await snapshotForExit(deps, clock, () => computeCurrentPortfolioAndBreakers(deps, clock))
      : { snapshot: await computeCurrentPortfolioAndBreakers(deps, clock), degradation: null };
    const { breakers } = snapshot;
    if (degradation !== null && risk_decision.order_intent !== null) {
      reportExitValuationDegraded(
        deps,
        'verdict',
        { trace_id, instrument: risk_decision.order_intent.instrument, clock },
        degradation,
      );
    }

    return verdict.decide({
      trace_id,
      risk_decision,
      clock,
      marketData: deps.marketData,
      tradingCalendar: deps.tradingCalendar,
      positionStore: deps.positionStore,
      breakers,
      config: deps.config,
      mode: deps.mode,
      approvals: deps.approvals,
    });
  };
}

export interface ExecutionStepDeps {
  clock: Clock;
  broker: BrokerAdapter;
  store: SharedStore;
  costModel: CostModel;
  marketData: MarketDataService;
  config: ExecutionConfig;
  /** The #525 fallback alert — see `ExecutionInput.residualExposureAlerts` */
  residualExposureAlerts: ResidualExposureAlertChannel;
  /** The #527 over-fill warning — see `ExecutionInput.flattenOverfillAlerts` */
  flattenOverfillAlerts: FlattenOverfillAlertChannel;
  /** The #519 unresolved-flatten escalation — see `ExecutionInput.flattenReconcileAlerts` */
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  /** #1550's unrecorded-venue-position page — see `ExecutionInput.unrecordedVenuePositionAlerts` */
  unrecordedVenuePositionAlerts: UnrecordedVenuePositionAlertChannel;
  /** #1550's per-instrument page throttle — see `ExecutionInput.unrecordedVenuePositionThrottle` */
  unrecordedVenuePositionThrottle: UnrecordedVenuePositionThrottle;
  /** #573's local diagnostic trace — see `ExecutionInput.logger`'s decision doc */
  logger: Logger;
  /** #1087's per-lot throttle — see `ExecutionInput.filledZeroSizeThrottle` */
  filledZeroSizeThrottle: FilledZeroSizeThrottle;
  /**
   * #1214's session gate on the residual re-flatten. The SAME pair
   * `TraderStepDeps` takes, from one instance — two objects would let a
   * future override reach only one, and the surfaces would disagree about
   * when the venue is open.
   */
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  /** #1465's non-sterling-fee page — see `ExecutionInput.nonSterlingFeeAlerts`. Optional, same as there. */
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
  /** #1506's unattributed-flatten-fill page — see `ExecutionInput.unattributedFlattenFillAlerts`. Optional, same as there. */
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel;
}

/**
 * `TickSteps.execution(verdict)` carries no `trace_id` (unlike every other
 * step), so a fresh `ExecutionImpl` is built per call using
 * `verdict.idempotency_key` as its `trace_id`, preserving per-order
 * correlation in broker/audit logs. Cheap: `ExecutionImpl` only holds
 * references.
 */
export function buildExecutionStep(deps: ExecutionStepDeps): TickSteps['execution'] {
  return (verdict) => {
    const execution = new ExecutionImpl({
      trace_id: verdict.idempotency_key,
      clock: deps.clock,
      broker: deps.broker,
      store: deps.store,
      costModel: deps.costModel,
      marketData: deps.marketData,
      config: deps.config,
      residualExposureAlerts: deps.residualExposureAlerts,
      flattenOverfillAlerts: deps.flattenOverfillAlerts,
      flattenReconcileAlerts: deps.flattenReconcileAlerts,
      unrecordedVenuePositionAlerts: deps.unrecordedVenuePositionAlerts,
      unrecordedVenuePositionThrottle: deps.unrecordedVenuePositionThrottle,
      logger: deps.logger,
      filledZeroSizeThrottle: deps.filledZeroSizeThrottle,
      sessionCalendars: deps.sessionCalendars,
      ...(deps.nonSterlingFeeAlerts === undefined
        ? {}
        : { nonSterlingFeeAlerts: deps.nonSterlingFeeAlerts }),
      ...(deps.unattributedFlattenFillAlerts === undefined
        ? {}
        : { unattributedFlattenFillAlerts: deps.unattributedFlattenFillAlerts }),
    });
    return execution.execute(verdict);
  };
}

/**
 * Execution's OTHER two surfaces — `reconcile()` and `ingestFills()` — bound
 * for the fill-sync loop. Separate from `buildExecutionStep`: not driven by a
 * verdict, run on their own cadence (ADR-0004 §3). Shares `ExecutionStepDeps`
 * so a new dependency can't be wired into the tick path and forgotten here.
 * `trace_id` is a fixed synthetic string since a poll spans every open lot,
 * not one order.
 */
export function buildExecutionSurface(deps: ExecutionStepDeps, traceId: string): ExecutionImpl {
  return new ExecutionImpl({
    trace_id: traceId,
    clock: deps.clock,
    broker: deps.broker,
    store: deps.store,
    costModel: deps.costModel,
    marketData: deps.marketData,
    config: deps.config,
    residualExposureAlerts: deps.residualExposureAlerts,
    flattenOverfillAlerts: deps.flattenOverfillAlerts,
    flattenReconcileAlerts: deps.flattenReconcileAlerts,
    unrecordedVenuePositionAlerts: deps.unrecordedVenuePositionAlerts,
    unrecordedVenuePositionThrottle: deps.unrecordedVenuePositionThrottle,
    logger: deps.logger,
    filledZeroSizeThrottle: deps.filledZeroSizeThrottle,
    sessionCalendars: deps.sessionCalendars,
    ...(deps.nonSterlingFeeAlerts === undefined
      ? {}
      : { nonSterlingFeeAlerts: deps.nonSterlingFeeAlerts }),
    ...(deps.unattributedFlattenFillAlerts === undefined
      ? {}
      : { unattributedFlattenFillAlerts: deps.unattributedFlattenFillAlerts }),
  });
}

export interface PersistenceInstances {
  auditLog: SqliteAuditLog;
  currentTickStore: SqliteCurrentTickStore;
  /** `scan(store, alertChannel, logger)` is a startup-time call, not part of construction (ADR-0004 §3) */
  orphanScanner: OrphanVerdictScanner;
}

export function buildPersistence(
  store: ConstructorParameters<typeof SqliteAuditLog>[0],
): PersistenceInstances {
  return {
    // #837 M9: both are the Orchestrator's own tables (`audit_log`,
    // `current_tick`), declared on the handle rather than on the caller
    auditLog: new SqliteAuditLog(guardedStore(store, 'orchestrator')),
    currentTickStore: new SqliteCurrentTickStore(guardedStore(store, 'orchestrator')),
    orphanScanner: new OrphanVerdictScanner(),
  };
}
