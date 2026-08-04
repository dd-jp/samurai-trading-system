/**
 * SQLite-backed `VerdictLogStore` over `verdict_log` (#302, migration
 * `0001_init.sql`; indexed by `0005_hot_path_indexes.sql`). See
 * docs/specs/shared-sqlite-store-spec.md ("Verdict" — `verdict_log`).
 *
 * Closes the gap #206 was closed as having already fixed: the port existed
 * and `LoggingVerdict` called it, but the only implementation in the repo
 * was `InMemoryVerdictLogStore` (verdict-log-store.ts) — restart-clean and
 * never constructed in `direct-bind.ts`'s production wiring. With no
 * durable writer, `OrphanVerdictScanner`'s `verdict_log` query always
 * returned zero rows, so the scan reported "no orphans" on every startup
 * regardless of the truth. See `../orchestrator/orphan-verdict-scan.ts`.
 *
 * Follows `SqliteAccountStateStore` (#276) / `SqliteBrokerStateStore` (#287):
 * a small focused class over the shared handle.
 *
 * `trace_id` is the table's `PRIMARY KEY` (0001_init.sql), so this upserts
 * with `ON CONFLICT ... DO UPDATE` rather than a bare `INSERT` — matching
 * both precedents' reasoning ("a retry racing itself"). Nothing in
 * `SequentialTickRunner` re-runs the verdict stage for a `trace_id` that has
 * already produced a decision today, but a bare `INSERT` would throw and
 * abort the tick if that ever changed (a retried tick, a re-processed
 * crash-recovery pass), turning a write-once assumption into a pipeline
 * crash. An idempotent upsert costs nothing when the assumption holds and
 * avoids that failure mode when it doesn't.
 *
 * No `getByTraceId` — see verdict-log-store.ts's doc comment for why the
 * port stays write-only and this store doesn't add a read method the port
 * doesn't need: every real reader (the Dashboard's `SqliteQueryStore`,
 * `OrphanVerdictScanner`) queries `verdict_log` directly over `SharedStore`,
 * not through this class.
 */
import type { VerdictLog, VerdictLogStore } from '../shared/index.js';
import type { SharedStore } from '../shared/store/index.js';

export class SqliteVerdictLogStore implements VerdictLogStore {
  constructor(private readonly db: SharedStore) {}

  writeLog(entry: VerdictLog): void {
    this.db
      .prepare(
        `INSERT INTO verdict_log (
           trace_id, idempotency_key, instrument, status, no_go_reason, hitl_override, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id) DO UPDATE SET
           idempotency_key = excluded.idempotency_key,
           instrument = excluded.instrument,
           status = excluded.status,
           no_go_reason = excluded.no_go_reason,
           hitl_override = excluded.hitl_override,
           timestamp = excluded.timestamp`,
      )
      .run(
        entry.trace_id,
        entry.idempotency_key,
        entry.instrument,
        entry.status,
        entry.no_go_reason,
        entry.hitl_override ? 1 : 0,
        entry.timestamp.toISOString(),
      );
  }
}
