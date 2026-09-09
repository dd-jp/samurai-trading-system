/**
 * SQLite-backed durable schedule for the Feedback Loop's daily cycle
 * (#1110, migration `0044`) — see the migration for the table shape, and
 * production.ts's `scheduleFeedbackCycle` for how it makes the cycle survive
 * a process restart.
 *
 * Two singleton rows share this one table, distinguished by `key`:
 * `'default'` is the most recently COMPLETED boundary (`lastBoundary` /
 * `recordBoundary`), `'attempt'` is the most recently ATTEMPTED one
 * (`attemptedBoundary` / `recordAttempt`), stamped before `runFeedbackCycle`
 * runs rather than after. The pass-2 fix for #1110 finding 1: without a
 * record of what was attempted, a restart after the boundary was stamped
 * attempted cannot be told apart from one before the cycle ever started —
 * and re-running the cycle in the former case double-applies a
 * guardrail-capped analyst-weight/risk-threshold step. The attempt marker
 * does not itself distinguish a cycle that ran to completion from one that
 * died mid-run (a residual gap kept deliberately narrow) — see the
 * "Ordering" doc comment on `scheduleFeedbackCycle` (production.ts) for the
 * full account. Two rows rather than a second column: both need the exact
 * same `MAX`-guarded upsert shape `recordBoundary` already has, and a second
 * column would need `last_boundary` relaxed off `NOT NULL` to be writable
 * before any cycle has ever completed.
 */
import type { SharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';

const SINGLETON_KEY = 'default';
const ATTEMPT_KEY = 'attempt';

interface FeedbackCycleScheduleRow {
  last_boundary: string;
}

export class SqliteFeedbackCycleScheduleStore {
  constructor(private readonly db: SharedStore) {}

  /** The most recently completed boundary, or `null` before any cycle has ever run. */
  lastBoundary(): Date | null {
    return this.readBoundary(SINGLETON_KEY);
  }

  /**
   * The most recently ATTEMPTED boundary — stamped before `runFeedbackCycle`
   * runs, independent of whether it (or the subsequent `recordBoundary`)
   * completed. `null` before any cycle has ever been attempted.
   */
  attemptedBoundary(): Date | null {
    return this.readBoundary(ATTEMPT_KEY);
  }

  private readBoundary(key: string): Date | null {
    const row = this.db
      .prepare('SELECT last_boundary FROM feedback_cycle_schedule WHERE key = ?')
      .get(key) as FeedbackCycleScheduleRow | undefined;

    return row === undefined ? null : fromStoredTimestamp(row.last_boundary);
  }

  /**
   * Records `boundary` as the most recently completed one.
   *
   * `MAX` in SQL rather than a plain overwrite is defence-in-depth on the
   * COLUMN VALUE only — it stops a write from ever stepping the stored
   * boundary backwards, e.g. a delayed retry landing after a later one
   * already wrote. It is NOT what makes "run this boundary once" safe: that
   * property is decided by `scheduleFeedbackCycle`'s own non-transactional
   * read-then-write (`lastBoundary()` then `recordBoundary()` in
   * production.ts), which is correct for this store's single-writer use but
   * would let two concurrent writers both observe the same `last` and both
   * run a cycle. `MAX` guards the column, not the race. ISO-8601 UTC
   * timestamps of the same width compare correctly as TEXT, so `MAX` over
   * the stored strings is exact — no numeric parse needed on the SQL side.
   */
  recordBoundary(boundary: Date, asOf: Date): void {
    this.writeBoundary(SINGLETON_KEY, boundary, asOf);
  }

  /**
   * Records `boundary` as attempted — called before `runFeedbackCycle`, so a
   * restart that lands after this write but before `recordBoundary` can tell
   * "the cycle for this boundary already ran" from "it never started" (see
   * the class doc comment). Same `MAX` guard as `recordBoundary`, for the
   * same reason.
   */
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
