/**
 * A row ceiling for `llm_call_log` (#1045).
 *
 * WHY THIS TABLE AND NOT THE OTHERS. Most tables in this store are
 * append-forever on purpose, and several say so in their own migrations:
 * `llm_spend` must survive entire because `SqliteSpendCap` sums `cost_usd`
 * over all of it on the trading path; `broker_unpriced_fills` may only lose a
 * row once its fill is certainly resolved; `debate_log` keeps the decision
 * record. `llm_call_log` is the exception because of what it holds — the
 * prompt text and the model's answer, which is the DIAGNOSTIC record, not the
 * trade record. That is the same line `rotating-file-sink.ts` draws for the
 * log files it rotates away: "every signal, order and fill is persisted in
 * SQLite (`audit_log`, `verdict_log`, execution/fill tables)", and HMRC
 * record-keeping rests on cost basis, disposal dates and realised gains, not
 * on what a model was asked. Nothing about the disposal history depends on a
 * prompt still being here.
 *
 * WHY A ROW COUNT AND NOT A DAY WINDOW. A window bounds AGE; this bounds
 * DISK, which is the thing that actually runs out. The measured ~64 calls/day
 * behind the sizing below came from a 15-minute debate cadence, while
 * `DEFAULT_TICK_INTERVAL_MS` is 60_000 — so a cadence change or a wider
 * universe scales volume with nothing to catch it, and a day window would
 * quietly hold that much more. A row ceiling holds either way. It also matches
 * the one retention mechanism this system already runs: the file sink bounds
 * bytes and generations (16 MiB x 11), not days.
 *
 * WHAT IT DOES NOT DO. `DELETE` does not shrink the database file. SQLite adds
 * the freed pages to its free list and reuses them, so the file plateaus
 * rather than falls, and steady-state size is what this bounds. No `VACUUM`
 * ships with it deliberately: rebuilding the file takes an exclusive lock, and
 * an always-on trading process is not the place to hold one.
 */
import type { SharedStore } from './open-shared-store.js';

/**
 * Rows kept, newest first.
 *
 * SIZED, NOT GUESSED — and stated as measured so the next reader can tell what
 * would invalidate it. Over the 2026-08-26 -> 2026-09-02 paper window the
 * capture ran at ~64 calls/day averaging ~7.8 KB of text per row (~6.8 KB
 * prompt, ~1.0 KB response). So 5,000 rows is:
 *
 *   * ~78 days at that rate, and ~39 MB on disk;
 *   * ~100 MB in the worst case where every row hits both caps in
 *     `spend-sink.ts` (16 KB prompt + 4 KB response).
 *
 * The worst case is what the ceiling is really chosen against, and it stays
 * under the file sink's 176 MiB on-disk allowance for the same run.
 *
 * The DAY figure is cadence-bound and the ROW figure is not; that asymmetry is
 * the point of the setting. At 60s ticks with a wider universe this is a
 * shorter window in days while remaining exactly 5,000 rows on disk. Migration
 * 0016 takes the same posture for `debate_log`, naming ~124,000 rows/fortnight
 * as its revisit trigger rather than "if it gets big".
 */
export const DEFAULT_MAX_LLM_CALL_ROWS = 5_000;

/**
 * Deletes all but the newest `maxRows` rows of `llm_call_log`. Returns how
 * many were removed, so a caller can log a prune that took thousands of rows
 * rather than letting it happen silently.
 *
 * Touches `llm_call_log` ONLY. `llm_spend` sits one join away and must never
 * be pruned with it — `SqliteSpendCap` runs an all-time, un-windowed
 * `SUM(cost_usd)` over that table before every debate, so dropping rows there
 * would not lose diagnostics, it would silently understate spend against
 * ADR-0008's cap and let the system keep trading past its budget. That is the
 * hazard this whole file is written around, and it is asserted in the tests
 * rather than trusted here.
 */
export function pruneLlmCallLog(db: SharedStore, maxRows: number): number {
  // `OFFSET maxRows` skips the rows being kept, so the subquery returns the id
  // of the FIRST row past the ceiling — the newest row that must go — and
  // `<=` takes it and everything older. Reads down the `id` primary key index,
  // so no extra index is needed.
  //
  // The `<=` is paired with this exact offset and the two must move together:
  // `<` with the same offset keeps `maxRows + 1` rows, an off-by-one that
  // would look right in every eyeball review and is pinned by
  // `keeps the newest rows and drops the rest`.
  //
  // NOT `id <= MAX(id) - maxRows`: `id` is `AUTOINCREMENT`, which never reuses
  // a value, so the moment this pruner has run once the ids carry gaps and
  // that arithmetic deletes rows it was never asked to.
  //
  // With `maxRows` rows or fewer the subquery finds nothing and yields NULL.
  // `id <= NULL` is NULL, which matches no row, so the call is a correct no-op
  // — deliberately falling out of the same statement rather than sitting
  // behind a count-first branch, because the no-op is the common case and a
  // second query to discover it would be the expensive half.
  return db
    .prepare(
      `DELETE FROM llm_call_log
        WHERE id <= (SELECT id FROM llm_call_log ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    )
    .run(maxRows).changes;
}
