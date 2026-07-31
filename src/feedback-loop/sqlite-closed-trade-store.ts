/**
 * SQLite-backed `ClosedTradeStore` — a READ-ONLY view over `closed_trades`
 * (#193/#195), the real store behind `InMemoryClosedTradeStore` (#91).
 * Execution is `closed_trades`' sole writer (shared-sqlite-store-spec.md,
 * cross-spec §4; `SqliteExecutionStore`, src/execution/sqlite-shared-store.ts)
 * — this class deliberately exposes only the one read the `ClosedTradeStore`
 * port declares, with no write method anywhere on it, so there is no way for
 * the Feedback Loop to accidentally mutate Execution's table.
 */

import type { ClosedTrade, ClosedTradeStore } from '../shared/index.js';
import type { SharedStore } from '../shared/store/index.js';

interface ClosedTradeRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: string;
  closed_at: string;
  close_reason: 'stop' | 'target' | 'exit';
}

export class SqliteClosedTradeStore implements ClosedTradeStore {
  constructor(private readonly db: SharedStore) {}

  /** Half-open at the start, so consecutive daily cycles partition the timeline. */
  getClosedTradesBetween(from: Date, to: Date): ClosedTrade[] {
    const rows = this.db
      .prepare(
        `SELECT idempotency_key, debate_id, instrument, asset_class, side,
                entry, stop, filled_size, realized_pnl_net, fees_total,
                opened_at, closed_at, close_reason
           FROM closed_trades
          WHERE closed_at > ? AND closed_at <= ?
          ORDER BY closed_at`,
      )
      .all(from.toISOString(), to.toISOString()) as ClosedTradeRow[];

    return rows.map(fromClosedTradeRow);
  }
}

function fromClosedTradeRow(row: ClosedTradeRow): ClosedTrade {
  return {
    idempotency_key: row.idempotency_key,
    debate_id: row.debate_id,
    instrument: row.instrument,
    asset_class: row.asset_class,
    side: row.side,
    entry: row.entry,
    stop: row.stop,
    filled_size: row.filled_size,
    realized_pnl_net: row.realized_pnl_net,
    fees_total: row.fees_total,
    opened_at: new Date(row.opened_at),
    closed_at: new Date(row.closed_at),
    close_reason: row.close_reason,
  };
}
