/**
 * Domain types for the Risk Manager (Stage 4) core check pipeline.
 * See docs/specs/risk-manager-spec.md ("Key Interfaces", "Module: Check
 * Pipeline") and docs/specs/cross-spec-contracts.md. Implementation ticket
 * #76 — the pipeline only. `PortfolioView` computation is #78; breaker-trip
 * computation is #77 — both are consumed here as pre-built inputs.
 */
import type { Clock } from '../shared/clock.js';
import type { OrderIntent } from '../shared/types.js';

/**
 * Pre-computed breaker trip state, tiered per risk-manager-spec.md
 * ("Module: Circuit Breakers"). Computing *when* a breaker trips is #77;
 * the pipeline here only reads the current armed/tripped state and halts
 * new entries accordingly. Exits are never gated by breakers.
 */
export interface BreakerState {
  portfolio_tripped: boolean;
  asset_class_tripped: {
    crypto: boolean;
    stocks: boolean;
  };
  /** Human/audit-facing names of every currently armed breaker, e.g. 'portfolio_drawdown_hard'. */
  armed_breakers: string[];
}

/**
 * Accounting view over the shared store (#78). Consumed here read-only —
 * the pipeline never computes exposure/drawdown itself.
 */
export interface PortfolioView {
  equity: number;
  peak_equity: number;
  drawdown_pct: number;
  exposure_by_instrument: Record<string, number>;
  exposure_by_class: { crypto: number; stocks: number };
  gross_exposure: number;
  daily_pnl_pct: number;
  consecutive_losses: number;
}

/** A predefined correlated-asset group for the v1 static concentration check. */
export interface ConcentrationBucket {
  name: string;
  instruments: string[];
  /** Max combined notional exposure across every instrument in this bucket. */
  cap: number;
}

/**
 * Static, config-driven thresholds the pipeline trims/rejects against.
 * Exact values are tuned in paper trading (risk-manager-spec.md "Out of
 * Scope: Exact limit values") — this is the shape, not the numbers.
 */
export interface RiskConfig {
  /** Max notional exposure for a single trade. */
  max_position_size: number;
  /** Max total notional exposure to one instrument. */
  per_asset_cap: number;
  /** Max total notional exposure per asset-class bucket. */
  per_asset_class_cap: { crypto: number; stocks: number };
  /** Max total gross notional exposure across the portfolio. */
  portfolio_gross_cap: number;
  concentration_buckets: ConcentrationBucket[];
  /** Below this notional, a trimmed intent is dust and must be rejected. */
  min_viable_size: number;
}

export interface RiskInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  intent: OrderIntent;
  clock: Clock;
  portfolio: PortfolioView;
  breakers: BreakerState;
  /** Selects manual vs auto re-arm for the hard breaker (consumed by #77, not this pipeline). */
  mode: 'live' | 'backtest';
}

export interface RiskDecision {
  status: 'approved' | 'rejected';
  /** Possibly trimmed; present iff approved. */
  order_intent: OrderIntent | null;
  modifications: {
    original_size: number;
    final_size: number;
    stop_tightened: boolean;
  } | null;
  /** Which check step trimmed/killed the intent, e.g. 'per_asset_class_cap', 'circuit_breaker:portfolio'. */
  binding_constraint: string | null;
  /** Machine tags + human text (audit). */
  reasons: string[];
  risk_snapshot: {
    /** Per instrument / class / portfolio. */
    exposure: Record<string, number>;
    drawdown_pct: number;
    armed_breakers: string[];
  };
}

/** Single test seam. Fully deterministic given its inputs. */
export interface RiskManager {
  evaluate(input: RiskInput): RiskDecision;
}
