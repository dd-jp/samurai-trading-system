/**
 * SQLite-backed `ClosedTradeStore` — a READ-ONLY view over `closed_trades`
 * (#193/#195), the real store behind `InMemoryClosedTradeStore` (#91).
 * Execution is `closed_trades`' sole writer (shared-sqlite-store-spec.md,
 * cross-spec §4; `SqliteExecutionStore`, server/pipeline/execution/sqlite-shared-store.ts)
 * — this class deliberately exposes only the one read the `ClosedTradeStore`
 * port declares, with no write method anywhere on it, so there is no way for
 * the Feedback Loop to accidentally mutate Execution's table.
 */

import type { ClosedTrade, ClosedTradeStore, TradingArm } from '../../shared/index.js';
import {
  type ClosedTradeRow,
  fromClosedTradeRow,
  type StoreHandle,
  toStoredTimestamp,
} from '../../shared/store/index.js';

export class SqliteClosedTradeStore implements ClosedTradeStore {
  /**
   * Which arm's closed trades this instance reads (#753). Defaults to `'live'`,
   * so every construction that predates the control arm keeps exactly the
   * behaviour it had.
   *
   * **One class, two instances — never two classes**, the same argument
   * `SqliteExecutionStore`'s `arm` makes: a second reader for the control arm
   * would be a second place for the two arms' accounting to drift. The
   * Feedback Loop takes the default; `ControlArmAccountStateProvider`
   * (production/control-account-state.ts) is the only caller that asks for
   * `'control'`.
   */
  constructor(
    private readonly db: StoreHandle,
    private readonly arm: TradingArm = 'live',
  ) {}

  /**
   * Half-open at the start, so consecutive daily cycles partition the timeline.
   *
   * **ONE arm only (#753), the live one by default.** Falsifier arm 2's control
   * trades land in this same table, tagged `arm = 'control'`, and the Feedback
   * Loop must not attribute them: it steps analyst weights and risk dials off
   * realized outcomes, and the control arm has no analyst contributions to
   * credit and does not trade the book those dials govern. Folding the two arms
   * together here would tune the live system on a stream half of which it did
   * not decide — and would do it silently, since a mixed result is still a
   * plausible-looking number. The control arm's own account state asks the same
   * question of the other arm through the same code.
   */
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
