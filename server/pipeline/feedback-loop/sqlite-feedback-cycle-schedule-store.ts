import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';

const SINGLETON_KEY = 'default';
const ATTEMPT_KEY = 'attempt';

interface FeedbackCycleScheduleRow {
  last_boundary: string;
}

export class SqliteFeedbackCycleScheduleStore {
  constructor(private readonly db: StoreHandle) {}

  lastBoundary(): Date | null {
    return this.readBoundary(SINGLETON_KEY);
  }

  attemptedBoundary(): Date | null {
    return this.readBoundary(ATTEMPT_KEY);
  }

  private readBoundary(key: string): Date | null {
    const row = this.db
      .prepare('SELECT last_boundary FROM feedback_cycle_schedule WHERE key = ?')
      .get(key) as FeedbackCycleScheduleRow | undefined;

    return row === undefined ? null : fromStoredTimestamp(row.last_boundary);
  }

  recordBoundary(boundary: Date, asOf: Date): void {
    this.writeBoundary(SINGLETON_KEY, boundary, asOf);
  }

  recordAttempt(boundary: Date, asOf: Date): void {
    this.writeBoundary(ATTEMPT_KEY, boundary, asOf);
  }

  private writeBoundary(key: string, boundary: Date, asOf: Date): void {
    this.db
      .prepare(
        `INSERT INTO feedback_cycle_schedule (key, last_boundary, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           last_boundary = MAX(feedback_cycle_schedule.last_boundary, excluded.last_boundary),
           updated_at = excluded.updated_at`,
      )
      .run(key, toStoredTimestamp(boundary), toStoredTimestamp(asOf));
  }
}
