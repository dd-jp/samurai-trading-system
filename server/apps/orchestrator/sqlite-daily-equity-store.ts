
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';

export interface DailyEquityObservation {
  session_start: Date;
  equity: number;
  recorded_at: Date;
  observed_at_boundary: boolean;
}

interface DailyEquityRow {
  session_start: string;
  equity: number;
  recorded_at: string;
  observed_at_boundary: number;
}

export class SqliteDailyEquityStore {
  constructor(private readonly db: StoreHandle) {}

  append(sessionStart: Date, equity: number, recordedAt: Date, observedAtBoundary: boolean): void {
    if (!Number.isFinite(equity)) {
      throw new Error(
        `SqliteDailyEquityStore.append: equity must be finite, got ${equity} for session ` +
          `${sessionStart.toISOString()}. Refusing to write a non-numeric observation into the ` +
          'return series the kill-lines are computed from.',
      );
    }

    this.db
      .prepare(
        `INSERT INTO daily_equity (session_start, equity, recorded_at, observed_at_boundary)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_start) DO NOTHING`,
      )
      .run(
        toStoredTimestamp(sessionStart),
        equity,
        toStoredTimestamp(recordedAt),
        observedAtBoundary ? 1 : 0,
      );
  }

  all(): DailyEquityObservation[] {
    const rows = this.db
      .prepare(
        `SELECT session_start, equity, recorded_at, observed_at_boundary
           FROM daily_equity
          ORDER BY session_start`,
      )
      .all() as DailyEquityRow[];

    return rows.map((row) => ({
      session_start: fromStoredTimestamp(row.session_start),
      equity: row.equity,
      recorded_at: fromStoredTimestamp(row.recorded_at),
      observed_at_boundary: row.observed_at_boundary === 1,
    }));
  }
}
