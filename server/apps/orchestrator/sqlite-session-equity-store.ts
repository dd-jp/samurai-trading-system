import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';

export type SessionEquityKey = 'crypto' | 'stocks' | 'portfolio';

export interface SessionEquitySnapshot {
  open_equity: number;
  open_at: Date;
  observed_at_boundary: boolean;
}

interface SessionEquityRow {
  open_equity: number;
  open_at: string;
  observed_at_boundary: number;
}

interface RealizedRow {
  realized: number | null;
}

export class SqliteSessionEquityStore {
  constructor(private readonly db: StoreHandle) {}

  get(key: SessionEquityKey): SessionEquitySnapshot | null {
    const row = this.db
      .prepare(
        'SELECT open_equity, open_at, observed_at_boundary FROM session_equity WHERE asset_class = ?',
      )
      .get(key) as SessionEquityRow | undefined;

    if (row === undefined) return null;

    return {
      open_equity: row.open_equity,
      open_at: fromStoredTimestamp(row.open_at),
      observed_at_boundary: row.observed_at_boundary === 1,
    };
  }

  put(
    key: SessionEquityKey,
    equity: number,
    sessionStart: Date,
    observedAtBoundary: boolean,
  ): void {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteSessionEquityStore.put: open_equity must be finite, got ${equity} for '${key}'. ` +
          'Refusing to write a non-numeric denominator for the daily-loss breaker.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO session_equity (asset_class, open_equity, open_at, observed_at_boundary)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(asset_class) DO UPDATE SET
           open_equity = excluded.open_equity,
           open_at = excluded.open_at,
           observed_at_boundary = excluded.observed_at_boundary`,
      )
      .run(key, equity, toStoredTimestamp(sessionStart), observedAtBoundary ? 1 : 0);
  }

  realizedSince(assetClass: 'crypto' | 'stocks', openAt: Date): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(realized_pnl_net), 0) AS realized
           FROM closed_trades
          WHERE arm = 'live' AND asset_class = ? AND closed_at > ?`,
      )
      .get(assetClass, toStoredTimestamp(openAt)) as RealizedRow | undefined;

    return row?.realized ?? 0;
  }

  realizedSinceAllClasses(openAt: Date): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(realized_pnl_net), 0) AS realized
           FROM closed_trades
          WHERE arm = 'live' AND closed_at > ?`,
      )
      .get(toStoredTimestamp(openAt)) as RealizedRow | undefined;

    return row?.realized ?? 0;
  }
}
