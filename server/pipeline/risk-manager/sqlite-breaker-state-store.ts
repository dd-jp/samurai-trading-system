
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestampOrNull, toStoredTimestampOrNull } from '../../shared/store/index.js';
import type { PersistedBreakerState } from './types.js';

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
