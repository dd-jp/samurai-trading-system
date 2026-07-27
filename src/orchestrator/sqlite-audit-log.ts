/**
 * SQLite-backed `AuditLog` over the `audit_log` table (#193, #201) — replaces
 * the earlier in-memory double now that the shared store exists. See
 * docs/specs/shared-sqlite-store-spec.md
 * ("Orchestrator" schema section) and docs/specs/orchestrator-spec.md
 * (Module: Structured Logging & Audit Spine).
 *
 * `audit_log` has no PK — a tick can legitimately reach the same stage twice
 * across retries — so `getByTraceId` orders by `timestamp, rowid`: SQLite's
 * tie-break for equal `timestamp`s is otherwise unspecified, and a fixed test
 * clock puts multiple stages at the same ISO millisecond (the same reason
 * `SqliteExecutionStore.getFills` orders by `rowid`).
 */
import type { SharedStore } from '../shared/store/open-shared-store.js';
import type { AuditLog } from './types.js';

export interface AuditLogEntry {
  trace_id: string;
  stage: string;
  decision: string;
  input_digest: string;
  output_digest: string;
  timestamp: Date;
}

interface AuditLogRow {
  trace_id: string;
  stage: string;
  decision: string;
  input_digest: string;
  output_digest: string;
  timestamp: string;
}

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: SharedStore) {}

  record(entry: AuditLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (trace_id, stage, decision, input_digest, output_digest, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.trace_id,
        entry.stage,
        entry.decision,
        entry.input_digest,
        entry.output_digest,
        entry.timestamp.toISOString(),
      );
  }

  /** `SELECT * FROM audit_log WHERE trace_id = ? ORDER BY timestamp, rowid` (orchestrator-spec.md). */
  getByTraceId(trace_id: string): AuditLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE trace_id = ? ORDER BY timestamp, rowid')
      .all(trace_id) as AuditLogRow[];
    return rows.map((row) => ({
      trace_id: row.trace_id,
      stage: row.stage,
      decision: row.decision,
      input_digest: row.input_digest,
      output_digest: row.output_digest,
      timestamp: new Date(row.timestamp),
    }));
  }
}
