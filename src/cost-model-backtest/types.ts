/**
 * Domain types & contracts for the Cost Model seam (ticket #87) and the
 * Backtest Harness seam (ticket #88).
 * See docs/specs/cost-model-backtest-spec.md ("Module: Cost Model" and
 * "Module: Backtest Harness" — Key Interfaces) and cross-spec-contracts.md.
 *
 * The Validation Library (MetricsSuite, splits, DSR/PBO/MinBTL, the
 * config-trial log) is ticket #89 and is declared in `validation-types.ts`;
 * `CostModel.capacityCeiling` is still undeclared (out of scope for #87 —
 * only `fill()` is required by that issue). `BacktestReport` therefore lands
 * here in its #88-fillable subset only: the metrics/walk-forward/
 * capacity-ceiling fields the spec lists arrive with the ticket that can
 * honestly populate them — see the note in `index.ts` on why #89 is not it.
 */

import type { TickOutcome } from '../orchestrator/index.js';
import type { SimulatedClock } from '../shared/index.js';
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

export interface CostConfig {
  crypto: AssetClassCostConfig;
  stocks: AssetClassCostConfig;
}

/** Seam 1 (partial — #87 scope): deterministic, pessimistic fill pricing. */
export interface CostModel {
  fill(request: FillRequest, marketState: MarketState): CostModelResult;
}

/**
 * The ordered bar timestamps the replay steps through. Sourced from the
 * Market Data Service's historical store (cross-spec contract #5: strictly
 * point-in-time and survivorship-free); the harness consumes the timeline,
 * it does not build it.
 */
export interface ReplayTimeline {
  /** Ascending, de-duplicated bar timestamps within `window` (inclusive). */
  barTimestamps(window: DateRange): Promise<readonly Date[]>;
}

/** Configuration for one replay. See spec "Module: Backtest Harness". */
export interface BacktestConfig {
  /**
   * Hash of the full strategy/param/feature config — the `config_trials` key
   * and the DSR/MinBTL trial identity. The harness records it on the report;
   * the trial log itself is the Validation Library's ticket.
   */
  config_hash: string;
  window: DateRange;
  /**
   * Survivorship-free: delisted names included. Asserted against the
   * `InstrumentRegistry` before the first bar is stepped.
   */
  universe: string[];
  /**
   * Asset-class pessimistic cost params. Part of the run's config identity
   * (covered by `config_hash`), but consumed by the caller's stage wiring —
   * Execution's Simulated adapter builds the `CostModel` from it. The harness
   * drives the tick loop and does not construct stages, so it carries this
   * value rather than reading it.
   */
  cost_config: CostConfig;
  /**
   * Reproducibility seed, recorded on the report. The only stochastic
   * consumer the spec defines is the cost model's opt-in seeded slippage
   * mode, which #87 did not implement — so today a replay's determinism rests
   * on the injected clock and sequential ordering, and the seed is carried
   * for the run's identity and for that mode when it lands.
   */
  seed: number;
}

/**
 * #88-fillable subset of the spec's `BacktestReport`. `metrics`,
 * `walk_forward` and `capacity_ceiling` are the Validation Library's ticket.
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

/**
 * Seam 2 (partial — #88 scope). Deterministic given seed + clock (and the
 * analysts' response cache).
 *
 * Async where the spec writes it sync: the tick loop it drives is
 * `TickRunner.runInstrument`, which is `Promise`-returning per
 * orchestrator-spec, so a synchronous `run` cannot await the pipeline.
 */
export interface Backtest {
  run(config: BacktestConfig, clock: SimulatedClock): Promise<BacktestReport>;
}
