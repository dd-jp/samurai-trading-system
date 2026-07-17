/**
 * In-memory `CurrentTickStore` for #96 — a concrete implementation of the
 * port (not a test-only mock), mirroring audit-log.ts's `InMemoryAuditLog`.
 * See docs/specs/orchestrator-spec.md (Module: Tick Runner, `current_tick`
 * row): the real SQLite-backed store is deferred (no shared store exists
 * anywhere in the codebase yet).
 */
import type { CurrentTick, CurrentTickStore } from './types.js';

export class InMemoryCurrentTickStore implements CurrentTickStore {
  private readonly rows = new Map<string, CurrentTick>();

  /** One row per instrument: upserting overwrites any prior (possibly stale) row. */
  upsert(row: CurrentTick): void {
    this.rows.set(row.instrument, row);
  }

  delete(instrument: string): void {
    this.rows.delete(instrument);
  }

  get(instrument: string): CurrentTick | undefined {
    return this.rows.get(instrument);
  }
}
