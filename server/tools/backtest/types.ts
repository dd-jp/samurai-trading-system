/**
 * Domain types & contracts for the Cost Model seam (ticket #87).
 * See docs/specs/cost-model-backtest-spec.md ("Module: Cost Model" —
 * Key Interfaces) and cross-spec-contracts.md.
 *
 * The Validation Library (MetricsSuite, splits, DSR/PBO/MinBTL, the
 * config-trial log) is ticket #89 and is declared in `validation-types.ts`;
 * `CostModel.capacityCeiling` is still undeclared (out of scope for #87 —
 * only `fill()` is required by that issue). `BacktestReport` carries the
 * subset `trial-execution.ts` (#244) actually populates — `metrics`/
 * `walk_forward`/`capacity_ceiling` arrive with the ticket that can honestly
 * fill them — see the note in `index.ts` on why #89 is not it.
 */

import type { TickOutcome } from '../../apps/orchestrator/index.js';
import type { DateRange } from './universe.js';

/** A request to fill an order against the cost model. */
export interface FillRequest {
  instrument: string;
  side: 'buy' | 'sell';
  /** Absolute units. */
  size: number;
  order_type: 'market' | 'limit';
  limit_price?: number;
  /** For dedup / join to the order intent. */
  idempotency_key: string;
}

/**
 * Market context the cost model prices a fill against. Assembled by the
 * caller (Execution's simulated broker adapter) from the Market Data
 * Service; the cost model never fetches this itself.
 */
export interface MarketState {
  /** Mid price at the bar. */
  mid: number;
  /**
   * Best-effort bid/ask spread estimate from MDS. `null`/`undefined` when
   * no bid/ask is available (e.g. historical stock bars) — the cost model
   * fallback-models the spread from `volatility` in that case
   * (cross-spec OPEN-GAP-A), so `spread` is best-effort/nullable at this
   * seam by design.
   */
  spread?: number | null;
  /** Liquidity proxy (bars-volume aggregation) from the MDS ADV helper. */
  adv: number;
  /** e.g. ATR or realized vol at the bar. */
  volatility: number;
  asset_class: 'crypto' | 'stocks';
  /**
   * Venue identity for the leg being priced, when it differs materially from
   * the plain asset-class default — e.g. LSE ETPs traded through Saxo vs a
   * US equity through Alpaca, both `asset_class: 'stocks'` (#1000,
   * ADR-0015:201/:207). `undefined` means "use the plain asset-class
   * config"; `CostConfig.venues` supplies the override when set. Stamped by
   * `SimulatedAdapterConfig.venue` (the Simulated adapter and the submit-time
   * snapshot) and `ReplayInstrument.venue` (the Stage 2 replay) — #1032 item 2.
   */
  venue?: CostVenue;
  /** = clock.now(); must be <= now (point-in-time). */
  timestamp: Date;
}

/** Transparent breakdown of the adverse cost components. */
export interface CostBreakdown {
  spread_cost: number;
  commission: number;
  slippage: number;
  /** sqrt-law term. */
  market_impact: number;
}

/**
 * Distinct type name to avoid colliding with Execution's persisted `Fill`
 * (execution-spec.md), which uses different field names (price/qty vs
 * fill_price/filled_size) and is the sole persisted record. The Simulated
 * adapter (this interface's one caller) maps this result onto Execution's
 * `Fill` as: Fill.price = fill_price, Fill.qty = filled_size,
 * Fill.cost_breakdown = cost_breakdown.
 */
export interface CostModelResult {
  /** mid moved adversely by the cost_breakdown components. */
  fill_price: number;
  /** May be < requested size in principle; #87 always fills the full request. */
  filled_size: number;
  cost_breakdown: CostBreakdown;
  /** Recorded when slippage stochastic mode is on — not implemented in #87. */
  seed?: number;
}

/**
 * Per-asset-class pessimistic cost parameters (config, not hard-coded
 * values — see spec "Out of Scope: Exact values"). Every field is a
 * non-negative rate/coefficient; the cost model additionally enforces a
 * structural non-zero floor beneath these values so a config cannot
 * construct a frictionless fill (Principle 1).
 */
export interface AssetClassCostConfig {
  /**
   * Fallback spread model when `MarketState.spread` is null/undefined:
   * fallback_spread = volatility * spreadVolatilityCoefficient.
   */
  spreadVolatilityCoefficient: number;
  /** Commission as a fraction of notional (size * mid). */
  commissionRate: number;
  /** slippage = volatility * slippageCoefficient (deterministic). */
  slippageCoefficient: number;
  /** market_impact = impactK * volatility * sqrt(size / adv). */
  impactK: number;
}

/**
 * Distinguishes cost-model legs that share `asset_class` but face different
 * venue economics — e.g. Saxo's LSE ETPs vs Alpaca's US equities, both
 * `'stocks'` (ADR-0015:201/:207). Deliberately NOT `BrokerVenue`
 * (`pipeline/execution/broker-state-store.ts`): that type enumerates the
 * adapters that journal brackets, and only the venues whose cost economics
 * diverge from their asset-class default belong here — a narrower identity
 * scoped to the cost seam alone (#1000).
 */
export type CostVenue = 'saxo';

/**
 * The structural non-zero floor beneath a `CostConfig`'s spread/commission
 * (Principle 1, cost-model-backtest-spec.md:148): even the most optimistic
 * config cannot construct a frictionless fill. Calibration-addressable
 * (#1000) rather than the hard-coded module constants it replaces — a
 * `CostConfig` MAY supply this to override `DEFAULT_COST_FLOORS`
 * (`cost-model.ts`). `CostModelImpl` throws if either rate is not a finite
 * number > 0, so a zero (or `NaN`) floor stays structurally unrepresentable
 * rather than merely the current default's behaviour.
 */
export interface CostFloors {
  /** Floor on half-spread, as a fraction of `MarketState.mid`. */
  minHalfSpreadRate: number;
  /** Floor on commission, as a fraction of notional (size * mid). */
  minCommissionRate: number;
}

export interface CostConfig {
  crypto: AssetClassCostConfig;
  stocks: AssetClassCostConfig;
  /**
   * Structural floor override (#1000) — omit to get `DEFAULT_COST_FLOORS`,
   * the same 1bp/1bp values every existing config relied on as a hard-coded
   * constant before this field existed, so omitting it changes nothing.
   * Present so the floor is calibration-addressable without substituting a
   * whole `CostModel` (the reason `ZeroCostModel` exists in
   * `cost-attribution.test.ts`).
   */
  floors?: CostFloors;
  /**
   * Per-venue override of `AssetClassCostConfig` fields, layered onto the
   * asset-class base when `MarketState.venue` matches a key here — e.g.
   * `{ saxo: { commissionRate: 0.0008 } }` for ADR-0015:201's 8bps-per-side
   * Saxo Classic tier. A key with no `MarketState` anywhere in a run setting
   * that `venue` is inert, not an error.
   */
  venues?: Partial<Record<CostVenue, Partial<AssetClassCostConfig>>>;
}

/** Seam 1 (partial — #87 scope): deterministic, pessimistic fill pricing. */
export interface CostModel {
  fill(request: FillRequest, marketState: MarketState): CostModelResult;
}

/**
 * The ordered bar timestamps a replay steps through. Sourced from the
 * Market Data Service's historical store (cross-spec contract #5: strictly
 * point-in-time and survivorship-free); the replay driver consumes the
 * timeline, it does not build it.
 */
export interface ReplayTimeline {
  /** Ascending, de-duplicated bar timestamps within `window` (inclusive). */
  barTimestamps(window: DateRange): Promise<readonly Date[]>;
}

/**
 * The record `trial-execution.ts` (#244) writes per config to `ConfigTrialLog`.
 * `metrics`, `walk_forward` and `capacity_ceiling` are the Validation
 * Library's ticket and are not populated here.
 */
export interface BacktestReport {
  config_hash: string;
  seed: number;
  /**
   * Every instrument-pass outcome, in replay order (bar-ascending, then
   * `TickPlan` order). This is the deterministic trade record: same seed +
   * same clock + same fixtures reproduce it exactly.
   */
  tick_outcomes: TickOutcome[];
  /**
   * Attestation that the no-lookahead audit ran and passed.
   *
   * The spec types this `'passed' | 'failed'`. A returned report can only
   * ever say `'passed'`: a detected violation throws `LookaheadViolationError`
   * out of `run` and produces no report at all. That is the point — a report
   * carrying `lookahead_audit: 'failed'` alongside a usable trade list is a
   * warning a caller can ignore, and the spec is explicit that a violation
   * fails the run instead. `'failed'` would only ever describe a persisted
   * failed-run record, which is not this ticket's scope.
   */
  lookahead_audit: 'passed';
}
