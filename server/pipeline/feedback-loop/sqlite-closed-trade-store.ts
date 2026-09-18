import type { ClosedTrade, ClosedTradeStore, TradingArm } from '../../shared/index.js';
import {
  type ClosedTradeRow,
  fromClosedTradeRow,
  type StoreHandle,
  toStoredTimestamp,
} from '../../shared/store/index.js';

export class SqliteClosedTradeStore implements ClosedTradeStore {
  constructor(
    private readonly db: StoreHandle,
    private readonly arm: TradingArm = 'live',
  ) {}

  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, debate_id, instrument, asset_class, side,
                entry, stop, filled_size, realized_pnl_net, fees_total,
                opened_at, closed_at, close_reason, modelled_cost_charged
           FROM closed_trades
          WHERE arm = ? AND closed_at > ? AND closed_at <= ?
          ORDER BY closed_at`,
      )
      .all(this.arm, toStoredTimestamp(from), toStoredTimestamp(to)) as ClosedTradeRow[];

    return rows.map(fromClosedTradeRow);
  }
}
