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

/**
 * Point-in-time pairwise correlation of one instrument against every other
 * held instrument with sufficient return history (ticket #50, v2 of the
 * concentration check — replaces the v1 static `ConcentrationBucket` list).
 * Computed outside `evaluate()` by `computeCorrelationEstimate` (correlation.ts)
 * and consumed here as pre-built data, mirroring `PortfolioView`/`BreakerState`.
 *
 * An instrument pair with insufficient overlapping history is simply absent
 * from `correlations` rather than assigned a value — that omission IS the
 * warm-up fallback: the pipeline treats an absent entry as "not correlated"
 * rather than guessing.
 */
export interface CorrelationEstimate {
  /** Keyed by the OTHER instrument; value is its correlation with the intent's instrument. */
  correlations: Record<string, number>;
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
  /** v2 dynamic concentration check (#50) — caps combined exposure across the intent's instrument and every instrument correlated with it. */
  concentration: {
    /** Max combined notional exposure across the intent's instrument and everything correlated with it. */
    cap: number;
    /** |correlation| at/above which another instrument counts as concentrated risk with this one. */
    threshold: number;
  };
  /** Below this notional, a trimmed intent is dust and must be rejected. */
  min_viable_size: number;
  /** CII soft signal (#205): absolute WorldMonitor CII level (0-100) above which a warning fires. Unpinned, tuned in paper trading. */
  cii_threshold: number;
}

/** The red-team critic's verdict on one gated `OrderIntent` (ADR-0003, #204). Produced *outside* `evaluate()` by critic.ts and consumed here as pre-built data.
 *
 * `unavailable` is what a failed live critic call persists (fail-open, per ADR-0003 §Consequences): the mechanical steps remain the safety net. */
export interface RiskCriticVerdict {
  verdict: 'pass' | 'trim' | 'reject' | 'unavailable';
  /** Only meaningful for `trim`: the notional the critic argues this intent should be capped at. */
  max_notional: number | null;
  /** The critic's argument text (audit). Surfaces on `RiskDecision.reasons`. */
  reasoning: string;
}

/** Persisted critic row, keyed by `debate_id` — joined with `debate_log` and `cosine_setups` (#162). */
export interface RiskCriticLog {
  debate_id: string;
  verdict: RiskCriticVerdict;
  created_at: Date;
}

/** Port for the `debate_id`-keyed critic log. In-memory implementation in critic-store.ts; SQLite-backed store deferred repo-wide. */
export interface RiskCriticStore {
  writeVerdict(entry: RiskCriticLog): void;
  getByDebateId(debate_id: string): RiskCriticLog | undefined;
}

export interface RiskInput {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  intent: OrderIntent;
  clock: Clock;
  portfolio: PortfolioView;
  breakers: BreakerState;
  /** Pairwise correlation of the intent's instrument vs held instruments (#50); pre-computed by correlation.ts. */
  correlation: CorrelationEstimate;
  /**
   * WorldMonitor CII soft signal (#205), keyed by country/region code.
   * Pre-fetched by `CiiConsumer` (market-intelligence/worldmonitor-adapter/cii-consumer.ts)
   * on its own decoupled cadence, not read live inside `evaluate()`. A country
   * absent from this record has no known score (not zero risk) — see
   * `CiiConsumer.getScores`.
   */
  cii: Record<string, number>;
  /** Red-team critic verdict (#204), pre-fetched by critic.ts. Absent = pass; mechanical steps are the safety net. */
  critic?: RiskCriticVerdict;
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
  /**
   * Advisory-only tags, e.g. 'macro_risk_flag:RU' from the CII soft signal
   * (#205, ADR-0002). Never trims, rejects, or otherwise affects `status`,
   * `order_intent`, or `binding_constraint` — see "Module: CII Soft Signal".
   */
  warnings: string[];
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
