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
 * `trace_id` is the table's `PRIMARY KEY` (0001_init.sql), so a bare
 * `INSERT` would throw and abort the tick on a repeated `trace_id` (a
 * retried tick, a re-processed crash-recovery pass) — nothing in
 * `SequentialTickRunner` re-runs the verdict stage for a `trace_id` that has
 * already produced a decision today, but a write-once assumption shouldn't
 * be able to crash the pipeline if that ever changes. So this upserts, but
 * with `ON CONFLICT(trace_id) DO NOTHING` — first-write-wins, NOT
 * `DO UPDATE`/last-write-wins. `VerdictLogStore`'s port doc
 * (server/shared/types/ports.ts) promises "Append-only: no update/delete,
 * one row per trace_id"; unlike `SqliteAccountStateStore`'s
 * `peak_equity` (a running high-water mark, correctly upserted
 * with `MAX()`) or `SqliteBrokerStateStore`'s bracket state
 * (live venue state, correctly upserted with `COALESCE()`),
 * `verdict_log` is an audit record of what Verdict actually decided — the
 * row `OrphanVerdictScanner` depends on to know a `go` was ever produced for
 * this `trace_id`. A `DO UPDATE` that let a later call (e.g. the `breaker`
 * gate (5)'s fire-time re-check landing differently the second time) silently
 * replace an original `go` row with a `no_go` one would erase exactly the
 * evidence #302 exists to make visible — reintroducing the hole this ticket
 * closes, just behind a rarer trigger. `DO NOTHING` gets the "don't crash on
 * a duplicate write" benefit without that risk: the first decision recorded
 * for a `trace_id` is permanent, matching the port's append-only contract
 * exactly.
 *
 * No `getByTraceId` — see verdict-log-store.ts's doc comment for why the
 * port stays write-only and this store doesn't add a read method the port
 * doesn't need: every real reader (the Dashboard's `SqliteQueryStore`,
 * `OrphanVerdictScanner`) queries `verdict_log` directly over `StoreHandle`,
 * not through this class.
 */

import type { VerdictLog, VerdictLogStore } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

export class SqliteVerdictLogStore implements VerdictLogStore {
  constructor(private readonly db: StoreHandle) {}

  writeLog(entry: VerdictLog): void {
    this.db
      .prepare(
        `INSERT INTO verdict_log (
           trace_id, idempotency_key, instrument, status, no_go_reason,
           no_go_detail_measured_ms, no_go_detail_bound_ms, hitl_override, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id) DO NOTHING`,
      )
      .run(
        entry.trace_id,
        entry.idempotency_key,
        entry.instrument,
        entry.status,
        entry.no_go_reason,
        entry.no_go_detail_measured_ms,
        entry.no_go_detail_bound_ms,
        entry.hitl_override ? 1 : 0,
        toStoredTimestamp(entry.timestamp),
      );
  }
}
