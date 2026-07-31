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
  VolatilityReading,
} from '../../risk-manager/index.js';
import {
  type CorrelationConfig,
  computeCorrelationEstimate,
  computePortfolioView,
  countryForInstrument,
  RiskManagerImpl,
} from '../../risk-manager/index.js';
import type { Clock, OpenPosition } from '../../shared/index.js';
import type { TraderConfig } from '../../trader/index.js';
import { decide } from '../../trader/index.js';
import type { ApprovalChannel, PositionStore, VerdictConfig } from '../../verdict/index.js';
import { VerdictImpl } from '../../verdict/index.js';
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
    daily_pnl_pct: number;
    consecutive_losses: number;
  }>;
}

/** Realized-vol reading for the volatility breaker tier — no in-repo indicator wired to it yet. */
export interface VolatilityReadingProvider {
  getVolatilityReading(asOf: Date): Promise<VolatilityReading>;
}

export interface TraderStepDeps extends BreakerStateDeps {
  config: TraderConfig;
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
    daily_pnl_pct: account.daily_pnl_pct,
    consecutive_losses: account.consecutive_losses,
  });
  const breakerInput: BreakerEvalInput = { portfolio, volatility, mode: deps.mode, clock };
  const breakers = deps.circuitBreakers.evaluate(breakerInput);
  return { portfolio, breakers };
}

export interface RiskStepDeps extends BreakerStateDeps {
  config: RiskConfig;
  correlationConfig: CorrelationConfig;
  ciiConsumer: CiiConsumer;
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
}

export function buildVerdictStep(deps: VerdictStepDeps): TickSteps['verdict'] {
  const verdict = new VerdictImpl();

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
