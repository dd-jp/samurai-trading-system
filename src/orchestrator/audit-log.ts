/**
 * In-memory `AuditLog` for #95 — a concrete implementation of the port
 * (not a test-only mock), mirroring src/trader/fixture-setup-store.ts's
 * `FixtureSetupStore`. See docs/specs/orchestrator-spec.md (Module:
 * Structured Logging & Audit Spine): "audit_log table in the shared SQLite
 * store" — the real SQLite-backed store is deferred (no shared store exists
 * anywhere in the codebase yet; every other stage's store is likewise an
 * in-memory/fixture implementation of its port pending that build-out).
 */
import type { AuditLog } from './types.js';

export interface AuditLogEntry {
  trace_id: string;
  stage: string;
  decision: string;
  input_digest: string;
  output_digest: string;
  timestamp: Date;
}

export class InMemoryAuditLog implements AuditLog {
  private readonly rows: AuditLogEntry[] = [];

  record(entry: AuditLogEntry): void {
    this.rows.push(entry);
  }

  /** `SELECT * FROM audit_log WHERE trace_id = ? ORDER BY timestamp` (orchestrator-spec.md). */
  getByTraceId(trace_id: string): AuditLogEntry[] {
    return this.rows
      .filter((row) => row.trace_id === trace_id)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}
