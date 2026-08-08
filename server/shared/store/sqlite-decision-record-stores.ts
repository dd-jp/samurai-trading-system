/**
 * SQLite-backed `TraderLogStore` / `RiskLogStore` over `trader_log` and
 * `risk_log` (#328, migration `0016_decision_records.sql`).
 *
 * Follows `SqliteVerdictLogStore` (#302) exactly, including its conflict rule:
 * `ON CONFLICT DO NOTHING` on the `(trace_id, instrument)` primary key, so a
 * retried tick or a re-processed crash-recovery pass cannot abort the pipeline
 * on a repeated key. **First-write-wins, not last-write-wins** — these are
 * audit records of what the stage actually decided, so the first decision under
 * a trace is the one that happened; a later write under the same key is a
 * replay, not a correction.
 */
import type {
  RiskDecisionRecord,
  RiskLogStore,
  TraderDecisionRecord,
  TraderLogStore,
} from '../decision-records.js';
import type { SharedStore } from './open-shared-store.js';

export class SqliteTraderLogStore implements TraderLogStore {
  constructor(private readonly db: SharedStore) {}

  write(record: TraderDecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO trader_log (
           trace_id, instrument, debate_id, intent_type, skip_reason,
           base_risk_fraction, conviction_multiplier, vol_floor_factor,
           non_converged_haircut, cosine_multiplier,
           neighbor_count, weighted_mean_r, no_precedent,
           atr, entry, stop, size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id, instrument) DO NOTHING`,
      )
      .run(
        record.trace_id,
        record.instrument,
        record.debate_id,
        record.intent_type,
        record.skip_reason,
        record.sizing?.base_risk_fraction ?? null,
        record.sizing?.conviction_multiplier ?? null,
        record.sizing?.vol_floor_factor ?? null,
        record.sizing?.non_converged_haircut ?? null,
        record.sizing?.cosine_multiplier ?? null,
        record.cosine_precedent?.neighbor_count ?? null,
        record.cosine_precedent?.weighted_mean_r ?? null,
        // `no_precedent` is a real tri-state here: 1, 0, or NULL for "the
        // retrieval never ran". Coercing the third to 0 would claim precedent
        // was found and simply not recorded.
        record.cosine_precedent === null ? null : record.cosine_precedent.no_precedent ? 1 : 0,
        record.atr,
        record.entry,
        record.stop,
        record.size,
        record.created_at.toISOString(),
      );
  }
}

export class SqliteRiskLogStore implements RiskLogStore {
  constructor(private readonly db: SharedStore) {}

  write(record: RiskDecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO risk_log (
           trace_id, instrument, status, binding_constraint, reasons_json,
           original_size, final_size, stop_tightened,
           portfolio_tripped, crypto_tripped, stocks_tripped, armed_breakers_json,
           equity, drawdown_pct, gross_exposure, consecutive_losses,
           daily_pnl_portfolio_pct, daily_pnl_crypto_pct, daily_pnl_stocks_pct,
           daily_pnl_unknown_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id, instrument) DO NOTHING`,
      )
      .run(
        record.trace_id,
        record.instrument,
        record.status,
        record.binding_constraint,
        JSON.stringify(record.reasons),
        record.original_size,
        record.final_size,
        record.stop_tightened ? 1 : 0,
        record.breakers.portfolio_tripped ? 1 : 0,
        record.breakers.crypto_tripped ? 1 : 0,
        record.breakers.stocks_tripped ? 1 : 0,
        JSON.stringify(record.breakers.armed_breakers),
        record.portfolio.equity,
        record.portfolio.drawdown_pct,
        record.portfolio.gross_exposure,
        record.portfolio.consecutive_losses,
        record.portfolio.daily_pnl_portfolio_pct,
        record.portfolio.daily_pnl_crypto_pct,
        record.portfolio.daily_pnl_stocks_pct,
        record.portfolio.daily_pnl_unknown_reason,
        record.created_at.toISOString(),
      );
  }
}
