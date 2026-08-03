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
import type { SharedStore } from '../shared/store/index.js';

const SINGLETON_KEY = 'default';

interface AccountStateRow {
  peak_equity: number;
}

export class SqliteAccountStateStore {
  constructor(private readonly db: SharedStore) {}

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
      .run(SINGLETON_KEY, equity, asOf.toISOString());

    return this.peakEquity() ?? equity;
  }

  /** The stored mark, or null before the first tick has ever recorded one. */
  peakEquity(): number | null {
    const row = this.db
      .prepare('SELECT peak_equity FROM account_state WHERE key = ?')
      .get(SINGLETON_KEY) as AccountStateRow | undefined;

    return row === undefined ? null : row.peak_equity;
  }
}
