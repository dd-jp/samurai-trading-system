
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { AssetClass, AuditLog } from './types.js';

export interface AuditLogEntry {
  trace_id: string;
  stage: string;
  decision: string;
  input_digest: string;
  output_digest: string;
  timestamp: Date;
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
  instrument: string | null;
  asset_class: AssetClass | null;
}

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: StoreHandle) {}

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
