
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
