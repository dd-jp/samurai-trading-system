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

import type { SharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';
import type { AssetClass, AuditLog } from './types.js';

export interface AuditLogEntry {
  trace_id: string;
  stage: string;
  decision: string;
  input_digest: string;
  output_digest: string;
  timestamp: Date;
  /**
   * Which instrument this trace belonged to (migration 0013).
   *
   * Optional because not every audit row comes from a tick: the HITL callback
   * path records under an existing `trace_id` with no `Signal` in scope. A
   * missing value means "not attributable", never "no instrument" — readers
   * must not treat it as a lane.
   */
  instrument?: string;
  asset_class?: AssetClass;
}

interface AuditLogRow {
  trace_id: string;
  stage: string;
  decision: string;
  input_digest: string;
  output_digest: string;
  timestamp: string;
  /** NULL for rows written before migration 0013, and for non-tick audit rows. */
  instrument: string | null;
  asset_class: AssetClass | null;
}

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: SharedStore) {}

  record(entry: AuditLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log
           (trace_id, stage, decision, input_digest, output_digest, timestamp, instrument, asset_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.trace_id,
        entry.stage,
        entry.decision,
        entry.input_digest,
        entry.output_digest,
        toStoredTimestamp(entry.timestamp),
        entry.instrument ?? null,
        entry.asset_class ?? null,
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
      timestamp: fromStoredTimestamp(row.timestamp),
      ...(row.instrument === null ? {} : { instrument: row.instrument }),
      ...(row.asset_class === null ? {} : { asset_class: row.asset_class }),
    }));
  }
}
