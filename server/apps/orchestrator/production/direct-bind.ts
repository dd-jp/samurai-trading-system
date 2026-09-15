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
  FilledZeroSizeThrottle,
  FlattenOverfillAlertChannel,
  FlattenReconcileAlertChannel,
  NonSterlingFeeAlertChannel,
  ResidualExposureAlertChannel,
  SharedStore,
  UnattributedFlattenFillAlertChannel,
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
   * Which arm of #753's measurement this bind decides for. Absent = `'live'`.
   *
   * The ONE field the control arm's bind sets that the live arm's does not, and
   * it changes no decision logic: it reaches `TraderInput.arm`, which reaches
   * the intent's idempotency key (so the two arms cannot dedupe each other's
   * orders away) and `OrderIntentMetadata.arm` (so the decision records say who
   * decided). The conviction floor, the frozen ADR-0018 D3 bracket, the stop,
   * the sizing and the exit rules all come from `config` — the SAME
   * `TraderConfig` object both arms are built over, which is what makes #753's
   * "asserted, not configured twice" structural.
   */
  arm?: TradingArm;
  /**
   * #568: `SharedStore.getExitFillSizes`, bound to the SAME store
   * `getOpenPositions` reads. Held quantity is `filled_size` minus this, and
   * `executeExit` refuses any exit whose size does not match its own copy of
   * that derivation — so an unbound (or differently-bound) reader here does
   * not mis-trade quietly, it stops every exit at the guard.
   */
  getExitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  /**
   * #1389: `SharedStore.getUnresolvedFlattens`, bound to the SAME store
   * `getOpenPositions` and `getExitFillSizes` read — which is also what makes
   * it arm-scoped (migration 0050). A cross-arm read here would have each arm
   * blocking the other's flatten for an instrument they both hold, which is
   * every instrument in a matched control.
   *
   * Required, matching `TraderInput.unresolvedFlattens`: forgetting it restores
   * the second-flatten over-sell silently, on the money path.
   */
  getUnresolvedFlattens: () => Promise<readonly UnresolvedFlatten[]>;
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
   * Undefined on every backtest run and in most tests; defined on paper runs
   * too since #1112, at `LIVE_BOOK_SIZING_USD` (paper-profile.ts — the GBP
   * book converted, #1180) and on live runs at
   * `SAMURAI_LIVE_MAX_CAPITAL_USD`.
   *
   * On paper that conversion is what makes the ceiling commensurable with the
   * `portfolio.equity` it is clamped against — the whole of #1180. On live it
   * is NOT enforced: the value is whatever the operator typed, and nothing
   * checks its currency. The name asserts USD and `live-profile.ts`'s docblock
   * states the obligation the operator carries because of it; treat that as a
   * convention this type documents, not an invariant it guarantees.
   *
   * Absent means "no ceiling declared", never "a ceiling of zero". See
   * `sizingEquity`.
   */
  capitalCeilingUsd?: CapitalCeilingUsd;
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
 * This is the place the ceiling binds for the TRADER's sizing inlet, but it is
 * not the only equity-scaled inlet in the system: `decide` computes
 * `size = (equity * riskFraction) / stopDistance` (trader/decide.ts) against
 * THIS function's return, so the EQUITY the Trader sizes against cannot exceed
 * the declared ceiling — `riskFraction / stopDistance` is not itself bounded
 * by 1 (see the `vol_floor_fraction` caveat below), so this does not bound the
 * resulting notional, only its equity input. The `RiskConfig` notional caps
 * are a separate path — since #886
 * they are FRACTIONS (`RISK_CAP_EQUITY_FRACTIONS`, paper-profile.ts), not the
 * absolute-dollar figures `riskCapsFor` (deleted) once derived from a ceiling
 * at profile-build time — and `risk-manager/index.ts` multiplies them against
 * live `portfolio.equity` at EVALUATE time, not against this function's
 * clamped return. They therefore track a funded account's real balance
 * directly and DO widen with it: #1135 (open) is exactly this gap — the
 * generic per-asset/per-class/gross/concentration caps resolve against raw
 * broker equity, not the #1112-corrected sizing ceiling this function
 * enforces.
 *
 * **Applied here and NOT inside `computePortfolioView`**, which is the tempting
 * shortcut and would be wrong: that same `equity` is the denominator of
 * `drawdown_pct` and of the per-class daily PnL the loss breakers fire on.
 * Clamping the OBSERVATION would understate a real drawdown on an account
 * larger than the ceiling — quietly disarming the breakers in order to bound
 * position size. The observation stays true; only the sizing inlet is bounded.
 *
 * `Math.min` would propagate a `NaN` ceiling silently — a fail-OPEN outcome
 * on the money path, since `NaN` reads as "no bound" all the way through
 * `decide`'s sizing arithmetic (#569). That is why the parameter is the
 * `CapitalCeilingUsd` brand and not a `number`: `toCapitalCeilingUsd`
 * (capital-ceiling.ts) is the only way to mint one, and it refuses anything
 * that is not positive and finite. `undefined` still means "no ceiling
 * declared", the correct reading for every paper/backtest run and every test
 * that leaves this field unset.
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
 * `TraderOutcome` carries no `debate_id` field for a skip, so a skip row's
 * attribution is recomputed here from the same `positions` snapshot
 * `checkExitsWithReason` was given, via the exported `mostRecentOpenLot`
 * (decide.ts, #1128 review round 1) rather than a second copy of its
 * most-recently-OPENED-lot selection that could silently drift from it.
 */
function mostRecentDebateId(positions: readonly OpenPosition[], instrument: string): string | null {
  const held = positions.filter((lot) => lot.instrument === instrument);
  if (held.length === 0) return null;
  return mostRecentOpenLot(held).debate_id;
}

/**
 * The Trader's TWO step bindings (#743) — the decision-path `trader` and the
 * tick-path `exitCheck` — built together over ONE dependency set and, more
 * importantly, ONE diagnostic throttle. The throttle's job is counting
 * CONSECUTIVE ticks a condition persisted (#698/#710), and after the split
 * most ticks report through `exitCheck` while at most one per bar reports
 * through `trader`: two throttles would each see gaps the other filled and
 * both would under-count, so a broken calendar's "N consecutive ticks" would
 * reset every debate bar.
 */
export function buildTraderSteps(deps: TraderStepDeps): {
  trader: TickSteps['trader'];
  exitCheck: TickSteps['exitCheck'];
} {
  // #698. Per-step-set rather than per-tick: the counter's entire job is to
  // relate THIS tick to the ones before it, so it has to outlive the closure
  // body. Held here for the same reason `buildAnalystsStep` holds
  // `consecutiveSkips` — one running orchestrator, in memory, restart-clean.
  const diagnosticThrottle = new TraderDiagnosticThrottle();

  // #1128 (review round 1): the exit-check skip write gate — see
  // `exit-skip-write-throttle.ts` for why "differs from the last WRITTEN
  // reason" alone cannot bound volume (a persistent fault, or a flapping
  // indicator read, both look "changed" on every tick under a naive
  // comparison). Restart-clean and in-memory, matching `diagnosticThrottle`
  // above; cleared at this instrument's episode boundaries below.
  const exitSkipThrottle = new ExitSkipWriteThrottle();

  const trader: TickSteps['trader'] = async ({ trace_id, instrument, debate, clock }) => {
    // TraderInput.equity is current portfolio equity (cash + mark-to-market
    // exposure) — the same OBSERVATION Risk gates against this tick, not
    // merely the same derivation: the snapshot is memoized per trace so the
    // two stages cannot see two different portfolios (B4).
    //
    // #847 — CAPTURE-AND-RETHROW, not laziness. The read stays EAGER and
    // unconditional: `computeCurrentPortfolioAndBreakers` is not a pure
    // observation, it also runs `circuitBreakers.evaluate()` and persists the
    // sticky tiers, and a decision pass is one of the few places that happens
    // (the tick path deliberately performs no portfolio read at all). Making
    // the read lazy would have skipped breaker evaluation on every no-trade
    // bar — 92 of 94 debates in the soak — which is a silent live-money
    // regression that ships green.
    //
    // What IS deferred is the FAILURE. When the strict whole-book valuation
    // refuses (one held instrument's mark dark or stale), the throw is held
    // here and re-raised, unwrapped, from inside `buildBracket` — so an ENTRY
    // or scale-in still aborts the tick into #507's catch exactly as before,
    // while `routeDecision`'s flat-by-close branch, which never reads equity,
    // now gets to run. Before this, one dark name aborted the whole decision
    // pass and delayed a newly decided flatten by a tick (ADR-0014).
    //
    // Re-raised UNWRAPPED on purpose: `snapshotForExit` downstream
    // discriminates on the original `StaleMarkError`/`AggregateError` to
    // decide whether a degraded valuation explains the refusal.
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
        // #753. Conditional spread under `exactOptionalPropertyTypes`: omitted
        // rather than passed as `undefined` on the live bind, which is the
        // pre-#753 behaviour and the value `TraderInput.arm` defaults to.
        ...(deps.arm === undefined ? {} : { arm: deps.arm }),
        marketData: deps.marketData,
        // #511: bounded by the declared capital ceiling whenever one is
        // declared (live always; paper since #1112), verbatim portfolio
        // equity only on backtest and undeclared tests.
        //
        // #847: either the STRICT whole-book equity or the strict read's own
        // throw — never a partial figure. A degraded view omits a held
        // instrument, and every exposure cap reads an absent instrument as ZERO
        // exposure, so sizing against one would silently over-size.
        equity: async () => {
          if (snapshot === null) throw snapshotError;
          return sizingEquity(snapshot.portfolio.equity, deps.capitalCeilingUsd);
        },
        config: deps.config,
        positionState: deps.getOpenPositions,
        // #568: the same store the lots came from, so the exit the Trader sizes
        // and the exit `executeExit` validates are computed off ONE fill record.
        exitFillSizes: deps.getExitFillSizes,
        // #1389. Bound on BOTH trader binds for the reason `onUnpricedFlatten`
        // is: `routeDecision`'s holding branch reaches the flatten too, so a
        // guard on only the tick path would leave every debate-bar flatten
        // unguarded.
        unresolvedFlattens: deps.getUnresolvedFlattens,
        setupStore: deps.setupStore,
        // #668: the same pair every other session-boundary consumer reads (the
        // daily-PnL boundary #331/#332, the volatility reading #386), threaded
        // through rather than rebuilt — two literals would be two calendars and
        // two places for an override to be applied to only one.
        sessionCalendars: deps.sessionCalendars,
        // #826. Wired on BOTH trader binds — the decision path can reach the
        // flatten too (`routeDecision`'s holding branch), so a hook on only the
        // tick path would go quiet for exactly the exits a debate bar decides.
        onUnpricedFlatten: (report) =>
          reportExitValuationDegraded(
            deps,
            'trader',
            { trace_id, instrument, clock },
            { unvalued_instruments: [report.instrument], reason: report.reason },
          ),
      });

    // Written for a null intent too (#328). `TickOutcome.final_stage` records
    // where a tick stopped and never why, and "why did nothing trade for six
    // hours" is the likeliest question a soak produces. A skip is a decision.
    deps.traderLog?.write({
      trace_id,
      instrument,
      debate_id: debate.debate_id,
      intent_type: intent?.intent_type ?? null,
      // #748. Null on an entry, a scale-in and every skip — the field is set
      // exactly when there is an exit, and on THIS path it is the flatten or
      // the direction flip rather than a decay (the decay runs on the tick
      // path, which is the other writer below).
      exit_reason: intent?.metadata.exit_reason ?? null,
      // The actual reason, since #475. This used to be the constant
      // `'decide() returned no intent'` for all thirteen distinct skip paths,
      // which made every quiet tick look identical: "the conviction floor is
      // too high" and "the market data feed is returning NaN marks" wrote the
      // same row. The sizing/precedent columns still say how far it got, which
      // remains what distinguishes "sized then rejected" from "never reached
      // sizing".
      skip_reason,
      // #1109. Distinguishes "the debate said no" from "the debate produced
      // nothing usable" for the same `skip_reason` string — see
      // `TraderDecisionClass`'s docblock for the full three-way split and
      // migration 0042 for why it lands as two typed columns rather than one.
      decision_class,
      reason_detail,
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

    // #1128 (review round 3, finding 3): a debate-bar decision can ALSO fire
    // the exit — `routeDecision`'s holding branch reaches `buildExitIntent`
    // for both the flat-by-close flatten and a debate-reversal
    // `direction_flip` (decide.ts) — not only `exitCheck`'s own tick-path
    // flatten/decay/`exit_held_quantity_diverged` handling below. The same
    // "a lot can close and reopen inside one tick gap with no exitCheck ever
    // observing it flat in between" argument `exitCheck`'s own clear (below)
    // is built on applies identically here: whichever binding's decision
    // actually closes the lot is the one that has to clear this instrument's
    // tick-path episode state, or a reopened lot's first tick-path skip row
    // can read as an unchanged repeat of the CLOSED lot's last-written
    // reason and stay wrongly suppressed. `intent_type === 'exit'` is the one
    // value shared by both the flatten and the direction-flip branches (see
    // `exit_reason` above); a null intent or an entry/scale-in leaves nothing
    // to clear.
    if (intent?.intent_type === 'exit') exitSkipThrottle.clearEpisode(instrument);

    // #698: escalate anything the decision noticed but did not treat as fatal.
    // #1089's control-arm valuation refusal is one of these now (`decide.ts`
    // pushes a `TraderDiagnostic` with `asset_class: undefined` from inside
    // `buildBracket`, right where it decides to skip) — a durable row (written
    // just above) plus the real alert transport below, rather than a bespoke
    // log line with no consumer. See `TraderDiagnostic.asset_class` for why
    // that field is optional and `buildControlArmStep`'s catch in
    // `control-arm.ts` (now also `error`-level) for the pass this is paired
    // with.
    //
    // AFTER the `trader_log` write on purpose — the durable record is the thing
    // that must not be lost, and it lands whether or not a transport is
    // reachable. The alert is the audible copy, not the record.
    escalateTraderDiagnostics(
      deps,
      diagnosticThrottle,
      { trace_id, instrument, clock },
      diagnostics,
    );

    return intent;
  };

  const exitCheck: TickSteps['exitCheck'] = async ({ trace_id, instrument, bar, clock }) => {
    // No `snapshotForTick` here, deliberately: an exit sizes to the held
    // quantity, never to equity, so the tick path skips the account/portfolio
    // read entirely — the cheapness of the cheap path is the point of #743.
    //
    // Read once and memoized into `positionState` below (#1128) rather than
    // passed through as `deps.getOpenPositions` directly: `mostRecentDebateId`
    // needs the same snapshot `routeExitCheck` filters internally, and a
    // second real call here would double the store read `checkExitsWithReason`
    // already makes exactly once.
    const positions = await deps.getOpenPositions();
    const { intent, skip_reason, decision_class, reason_detail, atr, diagnostics } =
      await checkExitsWithReason({
        trace_id,
        instrument,
        clock,
        bar,
        // #753 — see the decision bind above. The exit intent's idempotency key
        // needs the arm for the same reason the entry's does: both arms flatten
        // the same instrument on the same bar.
        ...(deps.arm === undefined ? {} : { arm: deps.arm }),
        marketData: deps.marketData,
        config: deps.config,
        positionState: async () => positions,
        exitFillSizes: deps.getExitFillSizes,
        // #1389, and THIS is the binding that matters most, for the same
        // reason `onUnpricedFlatten`'s note below gives: the mandatory flatten
        // is decided here on nearly every occurrence.
        unresolvedFlattens: deps.getUnresolvedFlattens,
        sessionCalendars: deps.sessionCalendars,
        // #826, and THIS is the binding that matters most: the mandatory
        // flat-by-close flatten is decided on the tick path (`routeExitCheck`'s
        // first branch), so an unpriced flatten during an Alpaca stall is
        // overwhelmingly raised here rather than on the decision path above.
        onUnpricedFlatten: (report) =>
          reportExitValuationDegraded(
            deps,
            'trader',
            { trace_id, instrument, clock },
            { unvalued_instruments: [report.instrument], reason: report.reason },
          ),
      });

    // A fired flatten IS a decision and is recorded like one, attributed to
    // the debate that opened the lot, on every occurrence — an exit is never
    // volume noise.
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
      // #1128 (review round 1): the exit just fired, so this instrument's
      // skip-episode is over. Cleared HERE rather than left for the next
      // `no_open_position` observation, because a position can close and
      // reopen inside one tick gap with no exit-check ever observing the
      // instrument flat in between.
      exitSkipThrottle.clearEpisode(instrument);
    } else if (skip_reason === 'no_open_position') {
      // #1128: no lot is open, so there is no lot — and no debate — to
      // attribute a row to, and `trader_log.debate_id` is `NOT NULL`
      // (migration 0016). This never writes, but it IS an episode boundary
      // exactly like a fired exit above: a position that goes flat by
      // reconciliation rather than through this exitCheck's own intent still
      // clears here, so a lot reopened with the same first skip reason as
      // before is a new episode, not a suppressed repeat.
      exitSkipThrottle.clearEpisode(instrument);
    } else if (skip_reason !== null) {
      // #1128: `classifyExitCheckSkip`'s `decision_class` used to be computed
      // and thrown away here. Durable now, but CHANGE-ONLY for most reasons —
      // #743 measured ~30 exit-check calls per bar per instrument (2-minute
      // tick, 1h bar; tick-runner.ts's own count is "~29 of 30 passes" idle),
      // and a row per call would bury the decision records the table exists
      // to hold under a flat/held instrument repeating its last tick's
      // answer.
      let wrote = false;
      if (exitSkipThrottle.shouldWrite(instrument, skip_reason)) {
        // Every other exit-path skip fires with at least one lot open, so its
        // debate_id is always derivable here (see `no_open_position` above
        // for the one reason that is not).
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

/**
 * The #698/#710 diagnostic reporting, shared verbatim by both Trader step
 * bindings (#743).
 *
 * Every diagnostic is fed to the throttle, not only the ones that alert:
 * `observe` is what CLEARS a run, so skipping the call on a healthy tick
 * would leave a recovered condition counting from where it left off.
 *
 * The two halves are throttled differently (#710). The LOG is written for
 * every observation, because it is the durable record and a condition
 * present on every tick must appear on every tick; the ALERT is throttled,
 * because it lands in the chat that also carries kill-threshold breaches
 * (ADR-0008 §1). These were one call until the #710 review, which meant the
 * log inherited the alert's throttle and went quiet for seven ticks in
 * eight while this file's own docblock promised it never did.
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
   * Verdict never reads this — the `breaker` gate (5)'s fire-time re-check is specced to see
   * current breaker state, not the tick's earlier snapshot (verdict-spec.md).
   * Shared across the trader/risk binds via the composition root's single
   * `breakerStateDeps` object; keyed by `trace_id`, consumed by Risk.
   */
  portfolioSnapshots: Map<string, PortfolioSnapshot>;
  /**
   * #841: where an EXIT priced against a partly-valued book is escalated.
   * On `BreakerStateDeps` rather than on `RiskStepDeps` because BOTH tick
   * stages that re-derive the portfolio can hit the condition on the same
   * tick — Risk when it sizes and records the exit, Verdict when the `breaker` gate (5)
   * re-checks breakers — and a channel on only one of them would leave the
   * other seam silent, which is the hole this alert exists to close.
   *
   * Absent = log-only; both seams write an `error`-level line of their own
   * first. See `exit-valuation-alert.ts`.
   */
  exitValuationAlerts?: ExitValuationDegradedAlertChannel;
  /**
   * Sink for the `error`-level lines both seams above write, and (on
   * `RiskStepDeps`) for #726's guarded `riskLog.write` failure. Optional the
   * same way every logger in this file is: a test can stay silent, the
   * production path supplies the real one.
   */
  logger?: Logger;
}

/** One tick's portfolio + breaker observation — see `BreakerStateDeps.portfolioSnapshots`. */
export interface PortfolioSnapshot {
  portfolio: Awaited<ReturnType<typeof computePortfolioView>>;
  breakers: ReturnType<CircuitBreakers['evaluate']>;
  /**
   * The persisted tiers as of THIS observation (#1019's folded gap 2), read
   * in the same synchronous step as `breakers` rather than by the caller
   * after its `await`.
   *
   * `circuitBreakers` is ONE instance shared by every instrument's bind, and
   * since #1013 sibling instruments run concurrently. A caller that awaited
   * the snapshot and then called `getPersistedState()` could therefore read
   * state another instrument's `evaluate()` had advanced in between, and
   * write it into this instrument's `risk_log` row as `next_breaker_state`.
   * That never bypassed a gate — the gating `breakers` value is the one
   * captured here, before any interleaving window — but it made the audit
   * trail non-attributable per instrument, which is the whole point of a
   * per-instrument row. Captured beside `breakers` there is no window at all.
   */
  next_breaker_state: ReturnType<CircuitBreakers['getPersistedState']>;
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
    clock,
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
  //
  // Read ONCE and both persisted and carried on the snapshot (#1019 gap 2) —
  // see `PortfolioSnapshot.next_breaker_state`. Two reads either side of this
  // `save` would be two chances for a sibling instrument's `evaluate()` to
  // land in between.
  const next_breaker_state = deps.circuitBreakers.getPersistedState();
  deps.breakerState.save(next_breaker_state);
  return { portfolio, breakers, next_breaker_state };
}

/** One tick's exit valuation, and what it had to leave out to produce one (#841). */
export interface ExitValuationDegradation {
  /** The held instruments left unvalued — never empty when this object exists. */
  unvalued_instruments: readonly string[];
  /** The strict refusal's own message, naming each dark instrument and why. */
  reason: string;
}

/**
 * The breaker state a DEGRADED valuation is allowed to report (#841).
 *
 * Read off the sticky tiers rather than produced by `CircuitBreakers.evaluate()`,
 * and that is the whole point: a partial view omits a held position, which
 * understates `gross_exposure`, understates `equity`, and therefore
 * OVERSTATES `drawdown_pct`. Feeding it to `evaluate()` could trip the hard
 * drawdown breaker — a STICKY tier, persisted to `breaker_state` and reloaded
 * at boot — off a mark that was merely late. That would halt every new entry
 * on the strength of a number that was never true, and write a false
 * `armed_breakers` into `risk_log` beside it.
 *
 * So the degraded path evaluates nothing and persists nothing; it reports
 * what is already known to be tripped. The stateless tiers (daily loss,
 * volatility, the per-class ones) read as NOT tripped, which is the right
 * direction of error here: on the exit path an un-tripped breaker lets the
 * flatten through, and ADR-0014's flat-by-close is the invariant being
 * protected. An entry can never see this state — `buildRiskStep` asks for a
 * degraded snapshot only for an exit intent.
 *
 * Both sticky tiers are account-wide, so a trip on either sets the per-class
 * flags too, exactly as `evaluate()`'s portfolio tier does.
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
 * whatever CAN be valued instead of refusing the book (#841).
 *
 * No volatility read and no `evaluate()`/`save()` — see
 * `breakersFromStickyState`. Never memoized into `portfolioSnapshots` either:
 * that memo exists so the Trader and Risk gate one ENTRY against one
 * observation, and a partial view must never become the observation an entry
 * is sized against.
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
    // The one call site in the tree that opts in. See
    // `PortfolioAccountingInput.unvaluable_marks`.
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
 * be produced, and a partial one — plus the report that says so — when it
 * cannot.
 *
 * Strict FIRST, always. A tick whose book values cleanly takes exactly the
 * path it took before this ticket, memo included, so the exit and any entry
 * in the same trace still gate against one observation. Degrading is a
 * fallback from a throw, never a mode.
 *
 * A throw the degraded attempt CANNOT explain is re-raised unchanged. The
 * degraded attempt does not perform every read the strict one does — no
 * volatility reading, no `evaluate()`/`save()` — so it can succeed while the
 * real fault (a volatility outage, a failing `breaker_state` write) is still
 * there. If it comes back with nothing unvalued, marks were not the problem,
 * and swallowing the original would make a persistent non-mark fault
 * invisible on every exit tick: the same silence this ticket exists to
 * remove, relocated. Re-raising aborts the tick into #507's catch exactly as
 * it did before this ticket. The cost is the narrow case of a feed that
 * recovered between the two reads, which now aborts one tick rather than
 * proceeding — no worse than the pre-ticket behaviour.
 *
 * `computeStrict` is passed in rather than chosen here because the two seams
 * derive the strict view differently BY SPEC: Risk consumes the per-trace
 * memo (B4 — one observation shared with the Trader), Verdict re-derives
 * fresh (the `breaker` gate, 5, must see current breaker state). Picking one here would
 * silently change the other seam's semantics.
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
 * Makes a degraded exit valuation audible (#841): an `error`-level line
 * always, and the operator escalation when a transport is wired.
 *
 * Not throttled, and not latched once per process the way #766's clamp alert
 * is — see `exit-valuation-alert.ts` for why. Guarded like every other alert
 * post in this file: a transport that throws must not take down the exit it
 * was raised beside, which would reinstate the exact suppression this ticket
 * removes.
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
      message:
        seam === 'trader'
          ? // #826: a different condition, so a different line — this one is
            // not about the rest of the book, it is about the exited name
            // having no price of its own.
            `mandatory flatten sent with NO mark: ${instrument} — the flat-by-close exit went ` +
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
  /**
   * #766: where the catch below escalates a clamp trip — `resolveRiskConfig`
   * throwing on an out-of-bound `risk_thresholds` row. Absent = log-only,
   * same optionality rationale as `traderDiagnosticAlerts` below (no
   * log-only form: this catch already logs at `error`).
   */
  thresholdClampAlerts?: ThresholdClampAlertChannel;
  /**
   * #957: check-pipeline step 7's producer (`risk-manager/critic.ts`).
   *
   * `undefined` is a real, safe state rather than a gap: without a producer
   * every decision keeps the explicit `risk_critic: skipped` reason it has
   * carried since the step was specced, and the mechanical steps remain the
   * safety net. A test or a programmatic root stays offline that way.
   *
   * REQUIRED but nullable, unlike `riskLog`/`thresholds`, and the asymmetry is
   * the point — the same argument `evaluateSmokeGate`'s
   * `llmRateLimiterSnapshot` makes (smoke-run.ts). Optional, deleting the one
   * `critic:` line in `production.ts` would compile, pass every test, and
   * silently return step 7 to the never-run state review F-5 recorded. Passing
   * `undefined` has to be a written choice at the call site, so forgetting it
   * is a COMPILE error rather than a quietly disarmed model check in front of
   * live money.
   */
  critic: RiskCriticProducer | undefined;
}

/**
 * Asks the critic producer for a verdict, and NEVER throws (#957).
 *
 * The producer already fails open internally, but it is a public seam any
 * implementation may satisfy, and a throw from here would reach
 * `buildRiskStep`'s catch — which writes a `risk_log` `error` row and re-throws
 * to abort the tick. That would turn "the critic was unreachable" into "the
 * risk stage crashed", inverting the fail-open posture ADR-0003 and #640
 * settled. The guarantee is enforced at the boundary, where it holds.
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
  // #766: sent once per process, not once per instrument crash. Every
  // instrument's tick reaches this same `evaluate()` while a bad
  // `risk_thresholds` row stands, so an un-latched alert would post once per
  // instrument per tick for as long as the row persists — exactly the
  // flooding `ALERT_REPEAT_EVERY_DIAGNOSTICS` exists to avoid for
  // `traderDiagnosticAlerts`, and there is no useful SECOND page here: the
  // fix is always "correct the one offending row", which does not change
  // between instruments or ticks. Reset is a process restart, which is also
  // when an operator who acted on the first page would expect the state to
  // be re-announced.
  let clampAlertSent = false;

  return async ({ trace_id, intent, clock }) => {
    // Reuses the Trader's snapshot for this trace (B4) and consumes it — Risk
    // is the memo's last reader; Verdict re-derives fresh by spec.
    //
    // #841: an EXIT falls back to a PARTIAL valuation when the whole book
    // cannot be priced, instead of aborting the tick. `computePortfolioView`
    // enumerates every held instrument, so one dark or stale name used to
    // suppress the flatten of the ENTIRE book — including names whose marks
    // were fresh — leaving leveraged ETPs (ADR-0016) on overnight against
    // ADR-0014's flat-by-close invariant. Sizing an entry needs the whole
    // book priced; flattening a position already held does not, and
    // `evaluate()` below returns at `intent_type === 'exit'` before any gate
    // reads `portfolio` at all.
    //
    // The ENTRY path is untouched: `snapshotForTick` still refuses outright,
    // and `RiskManagerImpl.evaluate` refuses any entry whose view carries a
    // non-empty `unvalued_instruments` besides.
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
    // Taken off the snapshot, not re-read here (#1019 gap 2) — see
    // `PortfolioSnapshot.next_breaker_state` for what a second read after the
    // `await` above could attribute to this instrument.
    const next_breaker_state: PersistedBreakerState[] = snapshot.next_breaker_state;

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

    // Red-team critic (#204), check-pipeline step 7: the producer is
    // `risk-manager/critic.ts`, built by #957 and supplied on `deps.critic`.
    // It runs BELOW, between two `evaluate()` calls — see `criticVerdictFor`.
    // Without a producer (a test, a programmatic root) the verdict stays
    // absent and every decision keeps its explicit `risk_critic: skipped`
    // reason, with the mechanical steps as the safety net, exactly as before
    // (docs/reviews/triage-2026-08-06.md F-5).
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

      // TWO PASSES, and the first one is what fixes the cadence.
      //
      // #955 specifies the critic firing on every intent that REACHES step 7 —
      // every viable entry that survived the exit bypass, the unvalued-book
      // refusal, the breaker gate and the `min_viable_size` reject. Nothing
      // outside `evaluate()` knows which of those an intent will survive, and
      // `evaluate()` must stay pure and synchronous (#642), so it cannot ask
      // the model itself. So: evaluate once with NO verdict — cheap, pure, no
      // I/O — and let the pipeline itself answer the question. Reaching step 7
      // with no verdict is exactly what pushes `RISK_CRITIC_SKIPPED_REASON`,
      // so that reason IS the "step 7 was reached" signal, read from the same
      // exported constant the pipeline pushes.
      //
      // Only the SECOND decision is logged and returned; the dry run is
      // discarded, so one intent still produces exactly one `risk_log` row.
      const dryRun = evaluateWith();
      const reachedCritic = dryRun.reasons.includes(RISK_CRITIC_SKIPPED_REASON);
      const verdict =
        reachedCritic && deps.critic !== undefined
          ? await criticVerdictFor(deps, { trace_id, intent, portfolio, clock })
          : undefined;
      decision = verdict === undefined ? dryRun : evaluateWith(verdict);
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

      // #766: the live-read half of #638's clamp tripping is otherwise
      // audible only as this catch's log line one layer up and #507's crash
      // record — see `ThresholdClampAlertChannel`'s doc for why that is not
      // enough for an unattended run. Checked with `isThresholdBoundViolation`
      // rather than `instanceof ThresholdBoundViolationError`: TWO OR MORE
      // crossings in one `risk_thresholds` read throw a plain `Error`
      // (threshold-bounds.ts), which an `instanceof` check would miss on
      // exactly the more alarming case. Latched — see `clampAlertSent` above
      // — and never blocks the re-throw below: a failed post costs the page,
      // not the refusal.
      if (!clampAlertSent && isThresholdBoundViolation(error)) {
        clampAlertSent = true;
        deps.thresholdClampAlerts?.postThresholdClampAlert({
          trace_id,
          where: 'live-read',
          message: describeThrown(error),
          reported_at: clock.now(),
        });
      }

      // Guarded the same way #507's own side effects are guarded
      // (tick-loop.ts): this write must not itself throw and replace the
      // original error before it reaches #507's catch one layer up — that
      // would trade "3USL has no subclass" for an opaque SQLite failure and
      // destroy the exact diagnostic this fix exists to preserve. A failure
      // here is logged, not silently dropped, then the ORIGINAL error still
      // propagates unconditionally via the outer `throw error;` below.
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
   * writes through — see `buildPersistence` below. The raw handle, not the
   * execution `SharedStore` port `ExecutionStepDeps.store` carries.
   */
  store: StoreHandle;
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
  const logging = new LoggingVerdict(
    new VerdictImpl(),
    // #837 M9: the Verdict stage owns `verdict_log` and nothing else.
    new SqliteVerdictLogStore(guardedStore(deps.store, 'verdict')),
  );
  const verdict =
    deps.verdictAlerts === undefined ? logging : new NotifyingVerdict(logging, deps.verdictAlerts);

  return async ({ trace_id, risk_decision, clock }) => {
    // The `breaker` gate (5)'s fire-time re-check needs current breaker state, not the
    // snapshot risk_decision.risk_snapshot carries from Risk's earlier call
    // in this same tick — Verdict may fire enough later for a breaker to
    // have tripped or cleared in between (verdict-spec.md's `breaker` gate, 5).
    //
    // #841: the SECOND seam that refused an exit over a book it could not
    // fully value. Fixing only `buildRiskStep` would have left the flatten
    // approved at Risk and dead here — same refusal, same suppressed order,
    // same silence. An exit therefore degrades here too; the fallback reports
    // the sticky breaker tiers rather than evaluating new ones off a partial
    // view (`breakersFromStickyState`), which is what keeps a late mark from
    // tripping — and persisting — the hard drawdown breaker.
    //
    // Keyed off the intent Risk approved. `order_intent` is null only on a
    // rejection, which never reaches Verdict; the `?.` is for the type, and
    // an absent one takes the strict path.
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
  /** The #525 fallback alert — see `ExecutionInput.residualExposureAlerts`. */
  residualExposureAlerts: ResidualExposureAlertChannel;
  /** The #527 over-fill warning — see `ExecutionInput.flattenOverfillAlerts`. */
  flattenOverfillAlerts: FlattenOverfillAlertChannel;
  /** The #519 unresolved-flatten escalation — see `ExecutionInput.flattenReconcileAlerts`. */
  flattenReconcileAlerts: FlattenReconcileAlertChannel;
  /** #573's local diagnostic trace — see `ExecutionInput.logger`'s decision doc. */
  logger: Logger;
  /** #1087's per-lot throttle — see `ExecutionInput.filledZeroSizeThrottle`. */
  filledZeroSizeThrottle: FilledZeroSizeThrottle;
  /**
   * #1214's session gate on the residual re-flatten — see
   * `ExecutionInput.sessionCalendars`. The SAME pair `TraderStepDeps` takes
   * (`sessionCalendars` above), threaded from the one instance the
   * composition root builds: two calendar objects is two places for a future
   * override to reach only one of them, and the two surfaces would then
   * disagree about when the venue is open.
   */
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  /** #1465's non-sterling-fee page — see `ExecutionInput.nonSterlingFeeAlerts`. Optional, same as there. */
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
  /** #1506's unattributed-flatten-fill page — see `ExecutionInput.unattributedFlattenFillAlerts`. Optional, same as there. */
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel;
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
      residualExposureAlerts: deps.residualExposureAlerts,
      flattenOverfillAlerts: deps.flattenOverfillAlerts,
      flattenReconcileAlerts: deps.flattenReconcileAlerts,
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
    residualExposureAlerts: deps.residualExposureAlerts,
    flattenOverfillAlerts: deps.flattenOverfillAlerts,
    flattenReconcileAlerts: deps.flattenReconcileAlerts,
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
  /** `scan(store, alertChannel, logger)` is a startup-time call, not part of construction (ADR-0004 §3). */
  orphanScanner: OrphanVerdictScanner;
}

export function buildPersistence(
  store: ConstructorParameters<typeof SqliteAuditLog>[0],
): PersistenceInstances {
  return {
    // #837 M9: both are the Orchestrator's own tables (`audit_log`,
    // `current_tick`), declared on the handle rather than on the caller.
    auditLog: new SqliteAuditLog(guardedStore(store, 'orchestrator')),
    currentTickStore: new SqliteCurrentTickStore(guardedStore(store, 'orchestrator')),
    orphanScanner: new OrphanVerdictScanner(),
  };
}
