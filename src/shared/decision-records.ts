/**
 * Trader and Risk decision records (#328) — the stage-specific real-field
 * tables that `audit_log`'s digests deliberately are not.
 *
 * Ports live in `shared/` rather than in `trader/` and `risk-manager/` for the
 * same reason `DebateLogStore` and `VerdictLogStore` do: the writer is the
 * stage, the reader is the dashboard, and neither module should have to import
 * the other to agree on the shape.
 *
 * Both records are written on EVERY evaluation, including one that produces no
 * order. `TickOutcome.final_stage` records where a tick stopped and never why,
 * and "why did nothing trade for six hours" is the likeliest question a paper
 * soak produces. A skip is a decision.
 */

/** One Trader decision. `intent_type: null` with a `skip_reason` is a decision not to trade. */
export interface TraderDecisionRecord {
  trace_id: string;
  instrument: string;
  /** Joins `debate_log`. The debate's content is not duplicated — that record already exists. */
  debate_id: string;
  intent_type: 'entry' | 'scale_in' | 'exit' | null;
  /** Why no order was produced. Present exactly when `intent_type` is null. */
  skip_reason: string | null;
  /**
   * The five factors whose product is the size. Null on a skip that happened
   * before sizing ran — which is most of them, and the distinction matters:
   * "sized and then rejected" and "never got as far as sizing" are different
   * stories about the same absent trade.
   */
  sizing: {
    base_risk_fraction: number;
    conviction_multiplier: number;
    vol_floor_factor: number;
    non_converged_haircut: number;
    cosine_multiplier: number;
  } | null;
  /** What the cosine retrieval returned — the input that moved `cosine_multiplier`. */
  cosine_precedent: {
    neighbor_count: number;
    weighted_mean_r: number | null;
    no_precedent: boolean;
  } | null;
  atr: number | null;
  entry: number | null;
  stop: number | null;
  size: number | null;
  created_at: Date;
}

/** One Risk evaluation, approved or rejected. */
export interface RiskDecisionRecord {
  trace_id: string;
  instrument: string;
  status: 'approved' | 'rejected';
  binding_constraint: string | null;
  reasons: string[];
  original_size: number | null;
  final_size: number | null;
  stop_tightened: boolean;
  /** Breaker state as EVALUATED, not as it stands now. */
  breakers: {
    portfolio_tripped: boolean;
    crypto_tripped: boolean;
    stocks_tripped: boolean;
    armed_breakers: string[];
  };
  /**
   * The portfolio scalars the checks actually read.
   *
   * Deliberately not the whole `PortfolioView`: `exposure_by_instrument` is a
   * map with no bound, and under #397's rotating shortlist it is the field that
   * grows without limit. These are what the gates compare against.
   */
  portfolio: {
    equity: number;
    drawdown_pct: number;
    gross_exposure: number;
    consecutive_losses: number;
    /**
     * Null pct with a reason is the `known: false` case (#333). An absent daily
     * figure has to stay distinguishable from a flat one HERE too — recording
     * it as 0 would reintroduce, in the audit trail, exactly the confusion the
     * breaker's tagged union exists to prevent.
     */
    daily_pnl_portfolio_pct: number | null;
    daily_pnl_crypto_pct: number | null;
    daily_pnl_stocks_pct: number | null;
    daily_pnl_unknown_reason: string | null;
  };
  created_at: Date;
}

export interface TraderLogStore {
  /** Append-only, first-write-wins on `(trace_id, instrument)`. */
  write(record: TraderDecisionRecord): void;
}

export interface RiskLogStore {
  /** Append-only, first-write-wins on `(trace_id, instrument)`. */
  write(record: RiskDecisionRecord): void;
}
