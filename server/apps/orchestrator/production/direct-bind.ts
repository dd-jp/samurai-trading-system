/**
 * Production Composition Root: direct-bind TickSteps (ticket #234). See
 * ADR-0004, docs/specs/orchestrator-spec.md ("Module: Production Composition
 * Root"), closed wayfinder map #224.
 *
 * Binds `trader`/`risk`/`verdict`/`execution` — the four stages whose
 * exported function already matches its `TickSteps` method shape once its
 * own runtime dependencies are closed over. This module only wires; it does
 * not modify any stage's decision logic (#234 AC).
 *
 * `risk` and `verdict` need per-call inputs their native `RiskInput`/
 * `VerdictInput` require but `TickSteps.risk`/`TickSteps.verdict` don't
 * carry (`portfolio`, `breakers`, `correlation`, `cii`, `next_breaker_state`
 * for risk; `positionStore`/`breakers`/`approvals` context for verdict).
 * Those are assembled here from real sources where one exists
 * (`computePortfolioView`, `computeCorrelationEstimate`,
 * `CircuitBreakers.evaluate`, `CiiConsumer`) — and from an explicitly
 * injected seam where none does. `computePortfolioView`'s own doc comment
 * states `cash`/`peak_equity`/`daily_pnl_pct`/`consecutive_losses` have "no
 * in-repo data source" (the realized-PnL/fill-accounting tracker that would
 * compute them isn't built); `BrokerAdapter` exposes no account/balance
 * query either. Rather than inventing values for a data source that doesn't
 * exist, `AccountStateProvider` and `VolatilityReadingProvider` are left as
 * required constructor dependencies — real implementations are a follow-up,
 * not fabricated here.
 */

import type {
  BrokerAdapter,
  ExecutionConfig,
  FlattenOverfillAlertChannel,
  FlattenReconcileAlertChannel,
  ResidualExposureAlertChannel,
  SharedStore,
} from '../../../pipeline/execution/index.js';
import { ExecutionImpl } from '../../../pipeline/execution/index.js';
import type {
  BreakerEvalInput,
  BreakerStatePersistence,
  CircuitBreakers,
  PersistedBreakerState,
  RiskConfig,
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
  RiskManagerImpl,
} from '../../../pipeline/risk-manager/index.js';
import type { TraderConfig } from '../../../pipeline/trader/index.js';
import { decideWithReason } from '../../../pipeline/trader/index.js';
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
  RiskLogStore,
  SetupStore,
  TraderLogStore,
} from '../../../shared/index.js';
import { describeThrown, sanitizeLogText } from '../../../shared/index.js';
// Aliased: this module already imports a DIFFERENT `SharedStore` above (an
// unrelated `execution/index.js` interface, `ExecutionStepDeps.store`'s
// type) — the alias names which one `VerdictStepDeps.store` actually is,
// rather than leaning on `ConstructorParameters<typeof SqliteVerdictLogStore>`
// to dodge the collision (kimi-3-review/deepseek-review on #302's PR: that
// form only surfaces a shape mismatch at the `new SqliteVerdictLogStore(...)`
// call site, not here at the interface).
import type { SharedStore as VerdictLogDb } from '../../../shared/store/index.js';
import type { CostModel } from '../../../tools/backtest/index.js';
import { OrphanVerdictScanner } from '../orphan-verdict-scan.js';
import { SqliteAuditLog } from '../sqlite-audit-log.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
import type { TickSteps } from '../types.js';
import {
  type TraderDiagnosticAlert,
  type TraderDiagnosticAlertChannel,
  TraderDiagnosticThrottle,
} from './trader-diagnostic-alert.js';

/**
 * Account-level accounting scalars `computePortfolioView` needs but has no
 * in-repo source for (realized PnL / fill history isn't tracked yet). A
 * real implementation is a follow-up (findings, PR #234/#235); tests inject
 * a fake.
 */
export interface AccountStateProvider {
  getAccountState(asOf: Date): Promise<{
    cash: number;
    peak_equity: number;
    /**
     * Session-open equity and realized PnL per class (#332) — not a finished
     * percentage. `computePortfolioView` adds the unrealized term and divides,
     * so the marks it already holds are not fetched a second time.
     */
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }>;
}

/**
 * Realized-vol reading for the volatility breaker tier. `./volatility-reading-provider.ts`'s
 * `MarketDataVolatilityReadingProvider` (#277) now implements this against
 * `MarketDataService.getIndicator` over the configured universe — it stays a
 * required constructor dependency here (not defaulted in `production.ts`)
 * because `AccountStateProvider`, injected alongside it into every
 * `BreakerStateDeps` call, still has no in-repo implementation; wiring both
 * into the composition root is a follow-up.
 */
export interface VolatilityReadingProvider {
  getVolatilityReading(asOf: Date): Promise<VolatilityReading>;
}

export interface TraderStepDeps extends BreakerStateDeps {
  config: TraderConfig;
  /**
   * #568: `SharedStore.getExitFillSizes`, bound to the SAME store
   * `getOpenPositions` reads. Held quantity is `filled_size` minus this, and
   * `executeExit` refuses any exit whose size does not match its own copy of
   * that derivation — so an unbound (or differently-bound) reader here does
   * not mis-trade quietly, it stops every exit at the guard.
   */
  getExitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  /**
   * #432: the same `SetupStore` instance `withOnTradeClose` labels through.
   * `decide` writes the setup at decision time and the close hook labels it
   * with the realized R — two halves of one table, so they must not be two
   * independently-constructed stores.
   */
  setupStore: SetupStore;
  /**
   * #668: when each asset class's venue closes, so the Trader can enforce
   * ADR-0014's flat-by-close through the instrument's own calendar.
   *
   * Required, matching `TraderInput.sessionCalendars`. An optional calendar
   * would let this root drop it and leave the flatten unarmed — which in a soak
   * log is indistinguishable from a market that simply never gave a setup, and
   * is this repo's dominant defect shape.
   */
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  /**
   * #328: the decision record. Optional so a test or backtest can stay silent,
   * supplied on the production path — without it, the two stages that decide
   * what to trade and how big leave nothing behind but a digest.
   */
  traderLog?: TraderLogStore;
  /**
   * The declared capital ceiling (#511, `ProductionConfig.capitalCeilingUsd`).
   * Undefined on every paper/backtest run and in every test — absent means "no
   * ceiling declared", never "a ceiling of zero". See `sizingEquity`.
   */
  capitalCeilingUsd?: number;
  /**
   * #698: where a degraded-but-continuing Trader condition is escalated.
   *
   * Optional, matching every other alert channel on this boundary: absent means
   * log-only, which is what tests and the backtest get. `production.ts` supplies
   * the logging default and `SAMURAI_ALERTS=telegram` replaces it with the
   * reachable-from-a-phone implementation.
   *
   * Optional here and NOT for the reason `sessionCalendars` is required: a
   * missing calendar changes what the system DOES, a missing alert channel only
   * changes who hears about it. The diagnostics still reach `trader_log` either
   * way.
   */
  traderDiagnosticAlerts?: TraderDiagnosticAlertChannel;
  /**
   * Where an undeliverable diagnostic alert is recorded, and the fallback sink
   * when no channel is wired. Optional for the same reason it is on the analysts
   * step: a test that supplies neither is silent by choice.
   */
  logger?: Logger;
}

/**
 * The equity the Trader may SIZE against — `min(declared ceiling, real equity)`
 * (#511).
 *
 * This is the place the ceiling binds, and it is the only place it needs to:
 * `decide` computes `size = (equity * riskFraction) / stopDistance`
 * (trader/decide.ts), so `equity` is the single input in the system that scales
 * a position with the account balance. The `RiskConfig` notional caps are
 * absolute dollars derived from the same ceiling at profile-build time, so they
 * cannot widen with a funded account on their own.
 *
 * **Applied here and NOT inside `computePortfolioView`**, which is the tempting
 * shortcut and would be wrong: that same `equity` is the denominator of
 * `drawdown_pct` and of the per-class daily PnL the loss breakers fire on.
 * Clamping the OBSERVATION would understate a real drawdown on an account
 * larger than the ceiling — quietly disarming the breakers in order to bound
 * position size. The observation stays true; only the sizing inlet is bounded.
 *
 * A non-finite ceiling cannot arrive here through the shipped entrypoint
 * (`assertLiveCapitalCeilingUsd` refuses one at boot, and
 * `buildProductionComponents` separately refuses `mode: 'live'` with no
 * ceiling declared at all) — but `Math.min` would propagate a `NaN` silently
 * if one somehow did, which is a fail-OPEN outcome on the money path: a
 * `NaN` ceiling reads as "no bound" all the way through `decide`'s sizing
 * arithmetic. So a DEFINED, non-finite ceiling throws here (#569) rather
 * than falling back to unclamped equity — `undefined` is unaffected and
 * still means "no ceiling declared", the correct reading for every paper/
 * backtest run and every test that leaves this field unset.
 */
export function sizingEquity(equity: number, capitalCeilingUsd: number | undefined): number {
  if (capitalCeilingUsd === undefined) return equity;
  if (!Number.isFinite(capitalCeilingUsd)) {
    throw new Error(
      `sizingEquity: capitalCeilingUsd must be a finite number when declared, but it is ` +
        `${String(capitalCeilingUsd)}. Refusing to size against unclamped equity.`,
    );
  }
  return Math.min(equity, capitalCeilingUsd);
}

export function buildTraderStep(deps: TraderStepDeps): TickSteps['trader'] {
  // #698. Per-step rather than per-tick: the counter's entire job is to relate
  // THIS tick to the ones before it, so it has to outlive the closure body. Held
  // here for the same reason `buildAnalystsStep` holds `consecutiveSkips` — one
  // running orchestrator, in memory, restart-clean.
  const diagnosticThrottle = new TraderDiagnosticThrottle();

  return async ({ trace_id, instrument, debate, clock }) => {
    // TraderInput.equity is current portfolio equity (cash + mark-to-market
    // exposure) — the same OBSERVATION Risk gates against this tick, not
    // merely the same derivation: the snapshot is memoized per trace so the
    // two stages cannot see two different portfolios (B4).
    const { portfolio } = await snapshotForTick(deps, clock, trace_id);
    const { intent, skip_reason, atr, diagnostics } = await decideWithReason({
      trace_id,
      instrument,
      debate,
      clock,
      marketData: deps.marketData,
      // #511: bounded by the declared capital ceiling on a live run, verbatim
      // portfolio equity everywhere else.
      equity: sizingEquity(portfolio.equity, deps.capitalCeilingUsd),
      config: deps.config,
      positionState: deps.getOpenPositions,
      // #568: the same store the lots came from, so the exit the Trader sizes
      // and the exit `executeExit` validates are computed off ONE fill record.
      exitFillSizes: deps.getExitFillSizes,
      setupStore: deps.setupStore,
      // #668: the same pair every other session-boundary consumer reads (the
      // daily-PnL boundary #331/#332, the volatility reading #386), threaded
      // through rather than rebuilt — two literals would be two calendars and
      // two places for an override to be applied to only one.
      sessionCalendars: deps.sessionCalendars,
    });

    // Written for a null intent too (#328). `TickOutcome.final_stage` records
    // where a tick stopped and never why, and "why did nothing trade for six
    // hours" is the likeliest question a soak produces. A skip is a decision.
    deps.traderLog?.write({
      trace_id,
      instrument,
      debate_id: debate.debate_id,
      intent_type: intent?.intent_type ?? null,
      // The actual reason, since #475. This used to be the constant
      // `'decide() returned no intent'` for all thirteen distinct skip paths,
      // which made every quiet tick look identical: "the conviction floor is
      // too high" and "the market data feed is returning NaN marks" wrote the
      // same row. The sizing/precedent columns still say how far it got, which
      // remains what distinguishes "sized then rejected" from "never reached
      // sizing".
      skip_reason,
      sizing: intent?.metadata.sizing ?? null,
      cosine_precedent: intent?.metadata.cosine_precedent ?? null,
      // Real since #475. The column has existed since migration 0016 and was
      // written as a hardcoded null — the value was computed inside
      // `buildBracket` and never left it. It is what explains a stop distance,
      // so without it a soak cannot tell a wide stop from a volatile instrument.
      atr,
      entry: intent?.entry ?? null,
      stop: intent?.stop ?? null,
      size: intent?.size ?? null,
      created_at: clock.now(),
    });

    // #698: escalate anything the decision noticed but did not treat as fatal.
    //
    // AFTER the `trader_log` write on purpose — the durable record is the thing
    // that must not be lost, and it lands whether or not a transport is
    // reachable. The alert is the audible copy, not the record.
    //
    // Every diagnostic is fed to the throttle, not only the ones that alert:
    // `observe` is what CLEARS a run, so skipping the call on a healthy tick
    // would leave a recovered condition counting from where it left off.
    //
    // The two halves are throttled differently (#710). The LOG is written for
    // every observation, because it is the durable record and a condition
    // present on every tick must appear on every tick; the ALERT is throttled,
    // because it lands in the chat that also carries kill-threshold breaches
    // (ADR-0008 §1). These were one call until the #710 review, which meant the
    // log inherited the alert's throttle and went quiet for seven ticks in
    // eight while this file's own docblock promised it never did.
    for (const observed of diagnosticThrottle.observe(instrument, diagnostics)) {
      const { diagnostic, consecutive_ticks } = observed;
      deps.logger?.log({
        trace_id,
        stage: 'trader',
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

      // NOT awaited (#710). `postSkipAlert` on the analysts step can await
      // because it runs before any order exists; this step's return value is
      // what Risk and Execution act on, so awaiting a Telegram send here puts
      // the transport in front of the order — including the flat-by-close exit,
      // whose whole point is landing before the bell. The Telegram client's
      // defaults are `maxAttempts: 3` against a 10s per-request timeout with
      // 0.5s/1s backoff, so a black-holed send holds the intent for ~31s of a
      // 15-minute tick before the broker has seen it — and that client's own
      // comment ("a send is not on the tick's critical path") is only true
      // because of this line.
      //
      // This is #669's defect shape, in a different place: a slow call inside a
      // per-instrument step delaying work that is not its own.
      void postTraderDiagnosticAlert(deps, trace_id, {
        instrument,
        diagnostic,
        consecutive_ticks,
        reported_at: clock.now(),
      }).catch(() => {
        // Unreachable via the transport, which is already caught inside. The
        // only way through here is `logger.log` itself throwing, and a floating
        // rejection would take the orchestrator down on an unattended soak —
        // the exact degraded-to-stopped inversion #698 exists to prevent. There
        // is nowhere to report it: the thing that would report it is what broke.
      });
    }

    return intent;
  };
}

/**
 * Posts one diagnostic alert, and never lets the transport take the tick down
 * with it (#698).
 *
 * Stronger than the posture `postSkipAlert` takes on the analysts step, and the
 * difference is WHERE in the tick each one sits. `postSkipAlert` runs before any
 * order exists, so awaiting it delays nothing that has money on it. This runs
 * inside the step whose return value Risk and Execution act on, so the caller
 * does not await it at all — catching the transport's errors is necessary but no
 * longer sufficient once a *slow* transport can delay a flatten exit (#710).
 *
 * The caller logs every diagnostic at `error` before deciding whether to call
 * this, so the condition is never silent even in a log-only deployment, and
 * never silent on the ticks between two throttled alerts either.
 *
 * `traceId` is the TICK's, not a synthetic constant. It is what joins this line
 * to the debate, the `trader_log` row and the verdict for the same instrument on
 * the same tick, which is the only way a soak post-mortem reconstructs what the
 * Trader was looking at when it complained.
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

/** Shared by risk and verdict: both need the portfolio-derived breaker state, fetched fresh at their own call time. */
interface BreakerStateDeps {
  marketData: MarketDataService;
  circuitBreakers: CircuitBreakers;
  /**
   * Where the sticky breakers' state lands after every evaluation, so a
   * tripped hard-drawdown breaker or kill switch survives a restart (#203,
   * review 2026-08-06 B1). Required, not optional: an omitted persistence
   * seam is exactly the wired-but-skippable shape that left `breaker_state`
   * unwritten for the life of the project.
   */
  breakerState: BreakerStatePersistence;
  accountState: AccountStateProvider;
  volatility: VolatilityReadingProvider;
  getOpenPositions: () => Promise<OpenPosition[]>;
  mode: 'live' | 'paper' | 'backtest';
  /**
   * #640: how old a valuation mark may be before `computePortfolioView`
   * refuses to value the book. Lives here rather than on `RiskStepDeps`
   * because the portfolio snapshot is computed once per tick and shared by
   * the trader and risk binds — putting the bound on one of them would leave
   * the other valuing the same book under no bound at all.
   */
  maxMarkAge: Record<AssetClass, number>;
  /**
   * Per-tick memo (review 2026-08-06 B4): the Trader computes the portfolio
   * snapshot, Risk reuses it, so both stages size and gate against ONE
   * observation of account state instead of two that can disagree mid-tick.
   * Verdict never reads this — gate 5's fire-time re-check is specced to see
   * current breaker state, not the tick's earlier snapshot (verdict-spec.md).
   * Shared across the trader/risk binds via the composition root's single
   * `breakerStateDeps` object; keyed by `trace_id`, consumed by Risk.
   */
  portfolioSnapshots: Map<string, PortfolioSnapshot>;
}

/** One tick's portfolio + breaker observation — see `BreakerStateDeps.portfolioSnapshots`. */
export interface PortfolioSnapshot {
  portfolio: Awaited<ReturnType<typeof computePortfolioView>>;
  breakers: ReturnType<CircuitBreakers['evaluate']>;
}

/**
 * Bounds the memo against ticks whose Risk stage never ran (a null intent
 * leaves the Trader's entry unconsumed). 64 is far above any concurrent
 * instrument count; eviction is oldest-first insertion order.
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
    cash: account.cash,
    peak_equity: account.peak_equity,
    daily_basis: account.daily_basis,
    consecutive_losses: account.consecutive_losses,
    max_mark_age: deps.maxMarkAge,
  });
  const breakerInput: BreakerEvalInput = { portfolio, volatility, mode: deps.mode, clock };
  const breakers = deps.circuitBreakers.evaluate(breakerInput);
  // Persist the sticky tiers immediately: `evaluate` is where a trip becomes
  // real, and a restart between this call and any later persist point would
  // silently re-arm the one mechanism ADR-0007 left standing.
  deps.breakerState.save(deps.circuitBreakers.getPersistedState());
  return { portfolio, breakers };
}

/**
 * The single member `buildRiskStep` actually calls, rather than the whole
 * `CiiConsumer` class.
 *
 * Depending on the class made every test double structurally impossible —
 * `CiiConsumer` carries private `cache`, `inFlight`, `provider` and `clock`
 * fields, so a `{ getScores }` stub can never satisfy it and the only way to
 * exercise `buildRiskStep` was to construct a real consumer with a real
 * provider. `Pick` rather than a fresh interface so a change to the class's
 * signature still propagates here instead of quietly diverging.
 */
export type CiiScoreSource = Pick<CiiConsumer, 'getScores'>;

export interface RiskStepDeps extends BreakerStateDeps {
  config: RiskConfig;
  correlationConfig: CorrelationConfig;
  ciiConsumer: CiiScoreSource;
  /**
   * #433: the live `risk_thresholds` table, read at every `evaluate()`.
   * Optional so a test or a backtest can stay on the static config, and
   * supplied on the production path — without it, the Feedback Loop's
   * defensive auto-tightening writes a row nothing honours.
   */
  thresholds?: RiskThresholdSource;
  /** #328: the decision record. Same optionality rationale as `traderLog`. */
  riskLog?: RiskLogStore;
}

export function buildRiskStep(deps: RiskStepDeps): TickSteps['risk'] {
  const riskManager = new RiskManagerImpl(deps.config, deps.thresholds);

  return async ({ trace_id, intent, clock }) => {
    // Reuses the Trader's snapshot for this trace (B4) and consumes it — Risk
    // is the memo's last reader; Verdict re-derives fresh by spec.
    const { portfolio, breakers } = await snapshotForTick(deps, clock, trace_id);
    deps.portfolioSnapshots.delete(trace_id);
    const next_breaker_state: PersistedBreakerState[] = deps.circuitBreakers.getPersistedState();

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

    // Red-team critic (#204), check-pipeline step 7, has NO PRODUCER anywhere
    // in the tree — `critic.ts` does not exist; only `critic-store.ts` (the
    // consumer side) does. The verdict is therefore always absent, which
    // defaults to "pass", so nothing distinguishes "the critic passed" from
    // "the critic was never consulted". The mechanical steps remain the safety
    // net. Do not read this comment as "wiring pending" — the step has never
    // run in any environment. See docs/reviews/triage-2026-08-06.md F-5.
    const daily = portfolio.daily_pnl;
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
        // Null pct rather than 0 when unknown (#333). Recording an absent
        // figure as flat here would reintroduce, in the audit trail, the exact
        // confusion the breaker's tagged union exists to prevent.
        daily_pnl_portfolio_pct: daily.portfolio.known ? daily.portfolio.pct : null,
        daily_pnl_crypto_pct: daily.crypto.known ? daily.crypto.pct : null,
        daily_pnl_stocks_pct: daily.stocks.known ? daily.stocks.pct : null,
        daily_pnl_unknown_reason: daily.portfolio.known ? null : daily.portfolio.reason,
      },
      created_at: clock.now(),
    };

    let decision: RiskDecision;
    try {
      decision = riskManager.evaluate({
        trace_id,
        intent,
        clock,
        portfolio,
        breakers,
        next_breaker_state,
        correlation,
        cii,
        mode: deps.mode,
      });
    } catch (error) {
      // #726: `perSubclassDeploymentCap` (risk-manager/index.ts) is the only
      // entry gate that throws rather than returning a decision — deliberately,
      // per that gate's own doc comment, so a half-populated pool file cannot
      // look like a quiet market with no setups. But a throw skips the
      // `riskLog.write` below entirely, so the refused instrument left NO
      // `risk_log` row at all, only the durable-but-separate `audit_log` row
      // and log line #507's catch in `tick-loop.ts` produces one level up.
      // This is the fix: write the row HERE, from the catch, naming the
      // unresolved subclass when the error is the one this gate throws — then
      // RE-THROW UNCHANGED. The throw itself must still reach #507's catch;
      // this only adds a durable record beside it, it does not replace it.
      const binding_constraint =
        error instanceof PerSubclassCapUnresolvableError
          ? error.bindingConstraint
          : `risk_evaluate_error:${intent.instrument}`;
      deps.riskLog?.write({
        ...riskLogBase,
        status: 'error',
        binding_constraint,
        reasons: [describeThrown(error)],
        original_size: null,
        final_size: null,
        stop_tightened: false,
      });
      throw error;
    }

    // Written on rejection too — the case that has no downstream record at all
    // today, since a rejected intent never reaches Verdict.
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
   * #465: where notable verdicts go. Absent = no verdict alerting, which is
   * `log-only` mode and every test. `NotifyingVerdict` filters before sending
   * — see `notable-verdict.ts` for why every no-go would be ~300 messages a
   * day at ADR-0008's cadence.
   */
  verdictAlerts?: TradeChannelNotifier;
  /**
   * Backs the `LoggingVerdict` decorator's `verdict_log` write (#302). Same
   * shared handle every other Sqlite* store in this composition root reads/
   * writes through — see `buildPersistence` below. `VerdictLogDb` is this
   * file's own import alias for `shared/store/index.js`'s `SharedStore`
   * (see the import above for why it's aliased, not the bare name).
   */
  store: VerdictLogDb;
}

/**
 * `LoggingVerdict` wraps `VerdictImpl` so every `decide()` call persists a
 * `verdict_log` row via `SqliteVerdictLogStore` (#302) — without this, the
 * table stays permanently empty and `OrphanVerdictScanner`'s query can never
 * find a row to report on. `NotifyingVerdict` (notifying-verdict.ts) stays
 * unwired here deliberately: #307 is the open ticket deciding whether one
 * decorator or two is the right shape once both are live; this ticket wires
 * only the one #302 needs.
 */
export function buildVerdictStep(deps: VerdictStepDeps): TickSteps['verdict'] {
  // #465: `NotifyingVerdict` OUTSIDE `LoggingVerdict`, so the row is written
  // before anyone is told. A notification about a verdict that failed to
  // persist would point an operator at a `verdict_log` entry that is not there.
  const logging = new LoggingVerdict(new VerdictImpl(), new SqliteVerdictLogStore(deps.store));
  const verdict =
    deps.verdictAlerts === undefined ? logging : new NotifyingVerdict(logging, deps.verdictAlerts);

  return async ({ trace_id, risk_decision, clock }) => {
    // Gate 5's fire-time re-check needs current breaker state, not the
    // snapshot risk_decision.risk_snapshot carries from Risk's earlier call
    // in this same tick — Verdict may fire enough later for a breaker to
    // have tripped or cleared in between (verdict-spec.md gate 5).
    const { breakers } = await computeCurrentPortfolioAndBreakers(deps, clock);

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
  mode: 'live' | 'paper' | 'backtest';
  /** The #525 fallback alert — see `ExecutionInput.residualExposureAlerts`. */
  residualExposureAlerts: ResidualExposureAlertChannel;
  /** The #527 over-fill warning — see `ExecutionInput.flattenOverfillAlerts`. */
  flattenOverfillAlerts: FlattenOverfillAlertChannel;
  /** The #519 unresolved-flatten escalation — see `ExecutionInput.flattenReconcileAlerts`. */
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  /** #573's local diagnostic trace — see `ExecutionInput.logger`'s decision doc. */
  logger: Logger;
}

/**
 * `TickSteps.execution(verdict)` carries no `trace_id` (unlike every other
 * step) — `ExecutionInput.trace_id` is fixed at construction. Rather than
 * share one process-scoped trace_id across every execution (losing
 * per-order correlation in broker/audit logs), a fresh `ExecutionImpl` is
 * constructed per call using `verdict.idempotency_key` — a stable,
 * per-order identifier already unique to this lot — as its `trace_id`.
 * `ExecutionImpl` only holds references, so constructing one per call is
 * cheap.
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
      mode: deps.mode,
      residualExposureAlerts: deps.residualExposureAlerts,
      flattenOverfillAlerts: deps.flattenOverfillAlerts,
      flattenReconcileAlerts: deps.flattenReconcileAlerts,
      logger: deps.logger,
    });
    return execution.execute(verdict);
  };
}

/**
 * Execution's OTHER two surfaces — `reconcile()` and `ingestFills()` — bound
 * for the fill-sync loop (server/apps/orchestrator/fill-sync.ts).
 *
 * Separate from `buildExecutionStep` because these are not tick steps: they
 * are not driven by a verdict, take no input, and run on their own cadence
 * (ADR-0004 §3's posture for `runDailyCycle` — a lifecycle the composition
 * root owns, not a `TickSteps` member). Sharing `ExecutionStepDeps` keeps the
 * dependency list in one place, so a new Execution dependency cannot be
 * wired into the tick path and forgotten on the polling path.
 *
 * `trace_id` is a fixed synthetic string rather than a per-order key: a poll
 * spans every open lot at once, so no single order id describes it. The two
 * surfaces get distinct ids so a reconcile and an ingest are separable in the
 * audit trail.
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
    mode: deps.mode,
    residualExposureAlerts: deps.residualExposureAlerts,
    flattenOverfillAlerts: deps.flattenOverfillAlerts,
    flattenReconcileAlerts: deps.flattenReconcileAlerts,
    logger: deps.logger,
  });
}

export interface PersistenceInstances {
  auditLog: SqliteAuditLog;
  currentTickStore: SqliteCurrentTickStore;
  /** `scan(store, alertChannel, logger)` is a startup-time call, not part of construction (ADR-0004 §3). */
  orphanScanner: OrphanVerdictScanner;
}

export function buildPersistence(
  store: ConstructorParameters<typeof SqliteAuditLog>[0],
): PersistenceInstances {
  return {
    auditLog: new SqliteAuditLog(store),
    currentTickStore: new SqliteCurrentTickStore(store),
    orphanScanner: new OrphanVerdictScanner(),
  };
}
