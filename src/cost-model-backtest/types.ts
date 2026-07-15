/**
 * Domain types & contracts for the Cost Model seam (ticket #87).
 * See docs/specs/cost-model-backtest-spec.md ("Module: Cost Model" — Key
 * Interface) and cross-spec-contracts.md. `Backtest.run` / `BacktestReport`
 * / the Validation Library are later tickets in epic #58 and are not
 * declared here yet; `CostModel.capacityCeiling` likewise (out of scope for
 * #87 — only `fill()` is required by the issue).
 */

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
