/**
 * SQLite persistence for the sticky circuit breakers (#203; wired by the
 * 2026-08-06 review's B1) — the `breaker_state` table's only reader/writer.
 *
 * `CircuitBreakers` is deliberately DB-free: it exports its sticky state via
 * `getPersistedState()` and reconstructs from those rows on construction.
 * This store is the caller-side half that was promised by that contract and,
 * until the review, written by nothing — so a tripped hard-drawdown breaker
 * or kill switch silently re-armed on every restart. Under ADR-0007 (no
 * human gate) the breakers are the only remaining stop, so that gap was a
 * live-money hazard, not a bookkeeping one.
 *
 * `save` upserts both tiers in one transaction; `load` returns `undefined`
 * for an empty table so a first boot constructs `CircuitBreakers` on its
 * untripped defaults rather than an empty-but-present state.
 */

import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestampOrNull, toStoredTimestampOrNull } from '../../shared/store/index.js';
import type { PersistedBreakerState } from './types.js';

/** The narrow write seam the tick path needs — see `computeCurrentPortfolioAndBreakers`. */
export interface BreakerStatePersistence {
  save(states: readonly PersistedBreakerState[]): void;
}

export class SqliteBreakerStateStore implements BreakerStatePersistence {
  constructor(private readonly db: StoreHandle) {}

  save(states: readonly PersistedBreakerState[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO breaker_state (tier, tripped, tripped_at, reset_at, reason)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tier) DO UPDATE SET
         tripped = excluded.tripped,
         tripped_at = excluded.tripped_at,
         reset_at = excluded.reset_at,
         reason = excluded.reason`,
    );
    this.db.transaction(() => {
      for (const state of states) {
        upsert.run(
          state.tier,
          state.tripped ? 1 : 0,
          toStoredTimestampOrNull(state.tripped_at),
          toStoredTimestampOrNull(state.reset_at),
          state.reason,
        );
      }
    })();
  }

  load(): PersistedBreakerState[] | undefined {
    const rows = this.db
      .prepare('SELECT tier, tripped, tripped_at, reset_at, reason FROM breaker_state')
      .all() as {
      tier: PersistedBreakerState['tier'];
      tripped: 0 | 1;
      tripped_at: string | null;
      reset_at: string | null;
      reason: string | null;
    }[];
    if (rows.length === 0) return undefined;
    return rows.map((row) => ({
      tier: row.tier,
      tripped: row.tripped === 1,
      tripped_at: fromStoredTimestampOrNull(row.tripped_at),
      reset_at: fromStoredTimestampOrNull(row.reset_at),
      reason: row.reason,
    }));
  }
}
