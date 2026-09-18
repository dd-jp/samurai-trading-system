
import type {
  RiskDecisionRecord,
  RiskLogStore,
  TraderDecisionRecord,
  TraderLogStore,
} from '../decision-records.js';
import type { StoreHandle } from './open-shared-store.js';
import { toStoredTimestamp } from './sqlite-utils.js';

function reasonDetailColumns(
  record: TraderDecisionRecord,
): readonly [compared_value: number | null, threshold: number | null] {
  return [record.reason_detail?.compared_value ?? null, record.reason_detail?.threshold ?? null];
}

function sizingColumns(
  record: TraderDecisionRecord,
): readonly [
  base_risk_fraction: number | null,
  conviction_multiplier: number | null,
  vol_floor_factor: number | null,
  non_converged_haircut: number | null,
  cosine_multiplier: number | null,
] {
  return [
    record.sizing?.base_risk_fraction ?? null,
    record.sizing?.conviction_multiplier ?? null,
    record.sizing?.vol_floor_factor ?? null,
    record.sizing?.non_converged_haircut ?? null,
    record.sizing?.cosine_multiplier ?? null,
  ];
}

function noPrecedentColumn(
  cosine_precedent: TraderDecisionRecord['cosine_precedent'],
): 0 | 1 | null {
  return cosine_precedent === null ? null : cosine_precedent.no_precedent ? 1 : 0;
}

function cosinePrecedentColumns(
  record: TraderDecisionRecord,
): readonly [
  neighbor_count: number | null,
  weighted_mean_r: number | null,
  no_precedent: 0 | 1 | null,
] {
  return [
    record.cosine_precedent?.neighbor_count ?? null,
    record.cosine_precedent?.weighted_mean_r ?? null,
    noPrecedentColumn(record.cosine_precedent),
  ];
}

export class SqliteTraderLogStore implements TraderLogStore {
  constructor(private readonly db: StoreHandle) {}

  write(record: TraderDecisionRecord): void {
    const [reason_detail_compared_value, reason_detail_threshold] = reasonDetailColumns(record);
    const [
      base_risk_fraction,
      conviction_multiplier,
      vol_floor_factor,
      non_converged_haircut,
      cosine_multiplier,
    ] = sizingColumns(record);
    const [neighbor_count, weighted_mean_r, no_precedent] = cosinePrecedentColumns(record);

    this.db
      .prepare(
        `INSERT INTO trader_log (
           trace_id, instrument, debate_id, intent_type, exit_reason, skip_reason,
           decision_class, reason_detail_compared_value, reason_detail_threshold,
           base_risk_fraction, conviction_multiplier, vol_floor_factor,
           non_converged_haircut, cosine_multiplier,
           neighbor_count, weighted_mean_r, no_precedent,
           atr, entry, stop, size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id, instrument) DO NOTHING`,
      )
      .run(
        record.trace_id,
        record.instrument,
        record.debate_id,
        record.intent_type,
        record.exit_reason,
        record.skip_reason,
        record.decision_class,
        reason_detail_compared_value,
        reason_detail_threshold,
        base_risk_fraction,
        conviction_multiplier,
        vol_floor_factor,
        non_converged_haircut,
        cosine_multiplier,
        neighbor_count,
        weighted_mean_r,
        no_precedent,
        record.atr,
        record.entry,
        record.stop,
        record.size,
        toStoredTimestamp(record.created_at),
      );
  }
}

export class SqliteRiskLogStore implements RiskLogStore {
  constructor(private readonly db: StoreHandle) {}

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
        toStoredTimestamp(record.created_at),
      );
  }
}
