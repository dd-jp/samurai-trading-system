/**
 * SQLite-backed `ClosedTradeStore` — a READ-ONLY view over `closed_trades`
 * (#193/#195), the real store behind `InMemoryClosedTradeStore` (#91).
 * Execution is `closed_trades`' sole writer (shared-sqlite-store-spec.md,
 * cross-spec §4; `SqliteExecutionStore`, server/pipeline/execution/sqlite-shared-store.ts)
 * — this class deliberately exposes only the one read the `ClosedTradeStore`
 * port declares, with no write method anywhere on it, so there is no way for
 * the Feedback Loop to accidentally mutate Execution's table.
 */

import type { ClosedTrade, ClosedTradeStore } from '../../shared/index.js';
import {
  type ClosedTradeRow,
  fromClosedTradeRow,
  type SharedStore,
} from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/sqlite-utils.js';

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
      .all(toStoredTimestamp(from), toStoredTimestamp(to)) as ClosedTradeRow[];

    return rows.map(fromClosedTradeRow);
  }
}
