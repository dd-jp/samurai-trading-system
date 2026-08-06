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

import type { CostModel } from '../../cost-model-backtest/index.js';
import type { BrokerAdapter, ExecutionConfig, SharedStore } from '../../execution/index.js';
import { ExecutionImpl } from '../../execution/index.js';
import type { MarketDataService, TradingCalendar } from '../../market-data-service/index.js';
import type { CiiConsumer } from '../../market-intelligence/index.js';
import type {
  BreakerEvalInput,
  CircuitBreakers,
  PersistedBreakerState,
  RiskConfig,
  SessionBasisByClass,
  VolatilityReading,
} from '../../risk-manager/index.js';
import {
  type CorrelationConfig,
  computeCorrelationEstimate,
  computePortfolioView,
  countryForInstrument,
  RiskManagerImpl,
} from '../../risk-manager/index.js';
import type { Clock, OpenPosition, SetupStore } from '../../shared/index.js';
// Aliased: this module already imports a DIFFERENT `SharedStore` above (an
// unrelated `execution/index.js` interface, `ExecutionStepDeps.store`'s
// type) — the alias names which one `VerdictStepDeps.store` actually is,
// rather than leaning on `ConstructorParameters<typeof SqliteVerdictLogStore>`
// to dodge the collision (kimi-3-review/deepseek-review on #302's PR: that
// form only surfaces a shape mismatch at the `new SqliteVerdictLogStore(...)`
// call site, not here at the interface).
import type { SharedStore as VerdictLogDb } from '../../shared/store/index.js';
import type { TraderConfig } from '../../trader/index.js';
import { decide } from '../../trader/index.js';
import type { ApprovalChannel, PositionStore, VerdictConfig } from '../../verdict/index.js';
import { LoggingVerdict, SqliteVerdictLogStore, VerdictImpl } from '../../verdict/index.js';
import { OrphanVerdictScanner } from '../orphan-verdict-scan.js';
import { SqliteAuditLog } from '../sqlite-audit-log.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
import type { TickSteps } from '../types.js';

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
   * #432: the same `SetupStore` instance `withOnTradeClose` labels through.
   * `decide` writes the setup at decision time and the close hook labels it
   * with the realized R — two halves of one table, so they must not be two
   * independently-constructed stores.
   */
  setupStore: SetupStore;
}

export function buildTraderStep(deps: TraderStepDeps): TickSteps['trader'] {
  return async ({ trace_id, instrument, debate, clock }) => {
    // TraderInput.equity is current portfolio equity (cash + mark-to-market
    // exposure) — the same figure the risk/verdict steps derive via
    // computeCurrentPortfolioAndBreakers, so this stays a single source
    // rather than a separately-injected scalar.
    const { portfolio } = await computeCurrentPortfolioAndBreakers(deps, clock);
    return decide({
      trace_id,
      instrument,
      debate,
      clock,
      marketData: deps.marketData,
      equity: portfolio.equity,
      config: deps.config,
      positionState: deps.getOpenPositions,
      setupStore: deps.setupStore,
    });
  };
}

/** Shared by risk and verdict: both need the portfolio-derived breaker state, fetched fresh at their own call time. */
interface BreakerStateDeps {
  marketData: MarketDataService;
  circuitBreakers: CircuitBreakers;
  accountState: AccountStateProvider;
  volatility: VolatilityReadingProvider;
  getOpenPositions: () => Promise<OpenPosition[]>;
  mode: 'live' | 'paper' | 'backtest';
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
  });
  const breakerInput: BreakerEvalInput = { portfolio, volatility, mode: deps.mode, clock };
  const breakers = deps.circuitBreakers.evaluate(breakerInput);
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
}

export function buildRiskStep(deps: RiskStepDeps): TickSteps['risk'] {
  const riskManager = new RiskManagerImpl(deps.config);

  return async ({ trace_id, intent, clock }) => {
    const { portfolio, breakers } = await computeCurrentPortfolioAndBreakers(deps, clock);
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

    // Red-team critic (#204) is pre-fetched by critic.ts outside evaluate();
    // not wired here — absent defaults to "pass" (mechanical steps remain
    // the safety net), same as any other caller that doesn't run it.
    return riskManager.evaluate({
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
  };
}

export interface VerdictStepDeps extends BreakerStateDeps {
  tradingCalendar: TradingCalendar;
  positionStore: PositionStore;
  config: VerdictConfig;
  approvals: ApprovalChannel;
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
  const verdict = new LoggingVerdict(new VerdictImpl(), new SqliteVerdictLogStore(deps.store));

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
    });
    return execution.execute(verdict);
  };
}

/**
 * Execution's OTHER two surfaces — `reconcile()` and `ingestFills()` — bound
 * for the fill-sync loop (src/orchestrator/fill-sync.ts).
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
