/**
 * SQLite-backed durable schedule for the Feedback Loop's daily cycle
 * (#1110, migration `0044`) — see the migration for why only the single most
 * recent boundary is kept, and production.ts's `scheduleFeedbackCycle` for
 * how it makes the cycle survive a process restart.
 */
import type { SharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';

const SINGLETON_KEY = 'default';

interface FeedbackCycleScheduleRow {
  last_boundary: string;
}

export class SqliteFeedbackCycleScheduleStore {
  constructor(
    private readonly db: SharedStore,
    private readonly key: string = SINGLETON_KEY,
  ) {}

  /** The most recently completed boundary, or `null` before any cycle has ever run. */
  lastBoundary(): Date | null {
    const row = this.db
      .prepare('SELECT last_boundary FROM feedback_cycle_schedule WHERE key = ?')
      .get(this.key) as FeedbackCycleScheduleRow | undefined;

    return row === undefined ? null : fromStoredTimestamp(row.last_boundary);
  }

  /**
   * Records `boundary` as the most recently completed one.
   *
   * `MAX` in SQL rather than a plain overwrite, for the same lost-update
   * reason `SqliteAccountStateStore.recordEquity` gives: boundaries are
   * computed from wall-clock time and only ever meant to move forward, so a
   * write racing an already-current row must not be able to step the
   * schedule backwards. ISO-8601 UTC timestamps of the same width compare
   * correctly as TEXT, so `MAX` over the stored strings is exact — no numeric
   * parse needed on the SQL side.
   */
  recordBoundary(boundary: Date, asOf: Date): void {
    this.db
      .prepare(
        `INSERT INTO feedback_cycle_schedule (key, last_boundary, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           last_boundary = MAX(feedback_cycle_schedule.last_boundary, excluded.last_boundary),
           updated_at = excluded.updated_at`,
      )
      .run(this.key, toStoredTimestamp(boundary), toStoredTimestamp(asOf));
  }
}
