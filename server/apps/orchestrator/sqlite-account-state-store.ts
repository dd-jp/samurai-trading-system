/**
 * SQLite-backed durable `peak_equity` high-water mark over the `account_state`
 * table (#276, migration `0006`). See docs/specs/transport-layer-spec.md
 * ("Module: AccountStateProvider") and docs/specs/shared-sqlite-store-spec.md.
 *
 * One row, `key = 'default'`. The table exists because `peak_equity` is the
 * denominator of risk-manager-spec.md's hard portfolio-drawdown breaker and
 * has no other home: Alpaca's account endpoint has no all-time-high field,
 * and it cannot be rebuilt from `closed_trades` (it is a function of equity,
 * including unrealized positions, not of realized trades).
 */

import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

const SINGLETON_KEY = 'default';

/**
 * The row falsifier arm 2 (#753) parks its BOOK ANCHOR in — the equity the
 * control arm's simulated account starts at, written once and never revised.
 *
 * A second key rather than a second table: `account_state` is already
 * "durable account scalars that no external API supplies", keyed by a free-form
 * TEXT primary key, and the anchor is exactly that. The column is named
 * `peak_equity` because the live arm's scalar is a high-water mark; for this
 * key it holds a first-observed mark instead, which is why the write goes
 * through `anchorEquity` (DO NOTHING) and not `recordEquity` (DO UPDATE MAX).
 */
export const CONTROL_BOOK_ANCHOR_KEY = 'control_book_anchor';

interface AccountStateRow {
  peak_equity: number;
}

export class SqliteAccountStateStore {
  /**
   * `key` is a constructor argument for the reason `SqliteExecutionStore`'s
   * `arm` is: one class, two rows, never two classes. The default is the live
   * arm's singleton row, so every existing caller is unchanged.
   */
  constructor(
    private readonly db: StoreHandle,
    private readonly key: string = SINGLETON_KEY,
  ) {}

  /**
   * First-write-wins: stores `equity` if this key has no row yet, and returns
   * whatever is in force afterwards — the EXISTING value when there was one.
   *
   * The opposite of `recordEquity`'s `MAX` on purpose. An anchor that a later
   * write could raise would let the control arm's starting book drift upward
   * with the live arm's equity across restarts, which is the coupling #753
   * exists to remove; `DO NOTHING` makes the first observation permanent, and
   * it is atomic in SQL for `recordEquity`'s lost-update reason.
   */
  anchorEquity(equity: number, asOf: Date): number {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteAccountStateStore.anchorEquity: equity must be finite, got ${equity}. ` +
          'Refusing to anchor a book the control arm would then size a fraction of.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO account_state (key, peak_equity, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(this.key, equity, toStoredTimestamp(asOf));

    return this.peakEquity() ?? equity;
  }

  /**
   * Raises the stored high-water mark to `equity` and returns the mark in
   * force — which is the PREVIOUS value whenever equity has fallen.
   *
   * Monotonic in SQL, not in TypeScript: `MAX(excluded, existing)` inside the
   * upsert means two processes (or a retry racing itself) cannot read-then-
   * write a lower value over a higher one. Doing the comparison in JS would
   * reintroduce exactly the lost-update race the drawdown breaker cannot
   * afford — a peak silently revised downward makes every subsequent drawdown
   * read shallower than it is, which is the failure direction that lets a
   * breaker sit un-tripped through a real drawdown.
   */
  recordEquity(equity: number, asOf: Date): number {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteAccountStateStore.recordEquity: equity must be finite, got ${equity}. ` +
          'Refusing to write a non-numeric high-water mark the drawdown breaker divides by.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO account_state (key, peak_equity, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           peak_equity = MAX(account_state.peak_equity, excluded.peak_equity),
           updated_at = excluded.updated_at`,
      )
      .run(this.key, equity, toStoredTimestamp(asOf));

    return this.peakEquity() ?? equity;
  }

  /** The stored mark, or null before the first tick has ever recorded one. */
  peakEquity(): number | null {
    const row = this.db
      .prepare('SELECT peak_equity FROM account_state WHERE key = ?')
      .get(this.key) as AccountStateRow | undefined;

    return row === undefined ? null : row.peak_equity;
  }
}
