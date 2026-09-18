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

export interface AccountStateProvider {
  getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }>;
}

export interface VolatilityReadingProvider {
  getVolatilityReading(asOf: Date): Promise<VolatilityReading>;
}

export interface TraderStepDeps extends BreakerStateDeps {
  config: TraderConfig;
  arm?: TradingArm;
  getExitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  getUnresolvedFlattens: () => Promise<readonly UnresolvedFlatten[]>;
  setupStore: SetupStore;
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  traderLog?: TraderLogStore;
  capitalCeilingUsd?: CapitalCeilingUsd;
  traderDiagnosticAlerts?: TraderDiagnosticAlertChannel;
  logger?: Logger;
}

export function sizingEquity(
  equity: number,
  capitalCeilingUsd: CapitalCeilingUsd | undefined,
): number {
  return capitalCeilingUsd === undefined ? equity : Math.min(equity, capitalCeilingUsd);
}

export function buildTraderStep(deps: TraderStepDeps): TickSteps['trader'] {
  return buildTraderSteps(deps).trader;
}

function mostRecentDebateId(positions: readonly OpenPosition[], instrument: string): string | null {
  const held = positions.filter((lot) => lot.instrument === instrument);
  if (held.length === 0) return null;
  return mostRecentOpenLot(held).debate_id;
}

export function buildTraderSteps(deps: TraderStepDeps): {
  trader: TickSteps['trader'];
  exitCheck: TickSteps['exitCheck'];
} {
  const diagnosticThrottle = new TraderDiagnosticThrottle();

  const exitSkipThrottle = new ExitSkipWriteThrottle();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: statement order is individually documented as load-bearing — the equity read is captured eagerly and its failure deferred (#847, not laziness), the trader_log write happens for a null intent too (#328) and BEFORE the diagnostics escalation (the durable record must land before the audible copy), and exitSkipThrottle.clearEpisode must run on this path too, not only exitCheck's (#1128 round 3) — extraction risks silently reordering one of these
  const trader: TickSteps['trader'] = async ({ trace_id, instrument, debate, clock }) => {
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
        ...(deps.arm === undefined ? {} : { arm: deps.arm }),
        marketData: deps.marketData,
        equity: async () => {
          if (snapshot === null) throw snapshotError;
          return sizingEquity(snapshot.portfolio.equity, deps.capitalCeilingUsd);
        },
        config: deps.config,
        positionState: deps.getOpenPositions,
        exitFillSizes: deps.getExitFillSizes,
        unresolvedFlattens: deps.getUnresolvedFlattens,
        setupStore: deps.setupStore,
        sessionCalendars: deps.sessionCalendars,
        onUnpricedFlatten: (report) =>
          reportExitValuationDegraded(
            deps,
            'trader',
            { trace_id, instrument, clock },
            { unvalued_instruments: [report.instrument], reason: report.reason },
          ),
      });

    deps.traderLog?.write({
      trace_id,
      instrument,
      debate_id: debate.debate_id,
      intent_type: intent?.intent_type ?? null,
      exit_reason: intent?.metadata.exit_reason ?? null,
      skip_reason,
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

    if (intent?.intent_type === 'exit') exitSkipThrottle.clearEpisode(instrument);

    escalateTraderDiagnostics(
      deps,
      diagnosticThrottle,
      { trace_id, instrument, clock },
      diagnostics,
    );

    return intent;
  };

  const exitCheck: TickSteps['exitCheck'] = async ({ trace_id, instrument, bar, clock }) => {
    const positions = await deps.getOpenPositions();
    const { intent, skip_reason, decision_class, reason_detail, atr, diagnostics } =
      await checkExitsWithReason({
        trace_id,
        instrument,
        clock,
        bar,
        ...(deps.arm === undefined ? {} : { arm: deps.arm }),
        marketData: deps.marketData,
        config: deps.config,
        positionState: async () => positions,
        exitFillSizes: deps.getExitFillSizes,
        unresolvedFlattens: deps.getUnresolvedFlattens,
        sessionCalendars: deps.sessionCalendars,
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
    exitSkipThrottle.clearEpisode(instrument);
  } else if (skip_reason === 'no_open_position') {
    exitSkipThrottle.clearEpisode(instrument);
  } else if (skip_reason !== null) {
    let wrote = false;
    if (exitSkipThrottle.shouldWrite(instrument, skip_reason)) {
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

    void postTraderDiagnosticAlert(deps, trace_id, {
      instrument,
      diagnostic,
      consecutive_ticks,
      reported_at: clock.now(),
    }).catch(() => {});
  }
}

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

interface BreakerStateDeps {
  marketData: MarketDataService;
  circuitBreakers: CircuitBreakers;
  breakerState: BreakerStatePersistence;
  accountState: AccountStateProvider;
  volatility: VolatilityReadingProvider;
  getOpenPositions: () => Promise<OpenPosition[]>;
  mode: 'live' | 'paper' | 'backtest';
  maxMarkAge: Record<AssetClass, number>;
  portfolioSnapshots: Map<string, PortfolioSnapshot>;
  exitValuationAlerts?: ExitValuationDegradedAlertChannel;
  logger?: Logger;
}

export interface PortfolioSnapshot {
  portfolio: Awaited<ReturnType<typeof computePortfolioView>>;
  breakers: ReturnType<CircuitBreakers['evaluate']>;
  next_breaker_state: ReturnType<CircuitBreakers['getPersistedState']>;
}

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
  const next_breaker_state = deps.circuitBreakers.getPersistedState();
  deps.breakerState.save(next_breaker_state);
  return { portfolio, breakers, next_breaker_state };
}

interface ExitValuationDegradation {
  unvalued_instruments: readonly string[];
  reason: string;
}

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
    unvaluable_marks: 'exclude',
  });
  const next_breaker_state = deps.circuitBreakers.getPersistedState();
  return {
    portfolio,
    breakers: breakersFromStickyState(next_breaker_state),
    next_breaker_state,
  };
}

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

type CiiScoreSource = Pick<CiiConsumer, 'getScores'>;

export interface RiskStepDeps extends BreakerStateDeps {
  config: RiskConfig;
  correlationConfig: CorrelationConfig;
  ciiConsumer: CiiScoreSource;
  thresholds?: RiskThresholdSource;
  riskLog?: RiskLogStore;
  thresholdClampAlerts?: ThresholdClampAlertChannel;
  critic: RiskCriticProducer | undefined;
}

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
  let clampAlertSent = false;

  return async ({ trace_id, intent, clock }) => {
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

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: guarded the same way #507's own side effects are guarded (tick-loop.ts) — the riskLog write is wrapped so a write failure cannot replace the original error before it reaches #507's catch (the outer `throw error;` must always run), and clampAlertSent is a one-shot latch that must not double-post — extraction risks separating either guard from the write/throw it protects
    function recordRiskEvaluationError(error: unknown): void {
      const binding_constraint =
        error instanceof PerSubclassCapUnresolvableError
          ? error.bindingConstraint
          : `risk_evaluate_error:${intent.instrument}`;

      if (!clampAlertSent && isThresholdBoundViolation(error)) {
        clampAlertSent = true;
        deps.thresholdClampAlerts?.postThresholdClampAlert({
          trace_id,
          where: 'live-read',
          message: describeThrown(error),
          reported_at: clock.now(),
        });
      }

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
  verdictAlerts?: TradeChannelNotifier;
  store: StoreHandle;
}

export function buildVerdictStep(deps: VerdictStepDeps): TickSteps['verdict'] {
  const logging = new LoggingVerdict(
    new VerdictImpl(),
    new SqliteVerdictLogStore(guardedStore(deps.store, 'verdict')),
  );
  const verdict =
    deps.verdictAlerts === undefined ? logging : new NotifyingVerdict(logging, deps.verdictAlerts);

  return async ({ trace_id, risk_decision, clock }) => {
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
  residualExposureAlerts: ResidualExposureAlertChannel;
  flattenOverfillAlerts: FlattenOverfillAlertChannel;
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  unrecordedVenuePositionAlerts: UnrecordedVenuePositionAlertChannel;
  unrecordedVenuePositionThrottle: UnrecordedVenuePositionThrottle;
  logger: Logger;
  filledZeroSizeThrottle: FilledZeroSizeThrottle;
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel;
}

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
  orphanScanner: OrphanVerdictScanner;
}

export function buildPersistence(
  store: ConstructorParameters<typeof SqliteAuditLog>[0],
): PersistenceInstances {
  return {
    auditLog: new SqliteAuditLog(guardedStore(store, 'orchestrator')),
    currentTickStore: new SqliteCurrentTickStore(guardedStore(store, 'orchestrator')),
    orphanScanner: new OrphanVerdictScanner(),
  };
}
