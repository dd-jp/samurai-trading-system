/**
 * SQLite-backed `CurrentTickStore` over the `current_tick` table (#193, #201)
 * — replaces the earlier in-memory double now that the shared store exists.
 * See docs/specs/shared-sqlite-store-spec.md ("Orchestrator" schema section) and
 * docs/specs/orchestrator-spec.md (Module: Tick Runner).
 *
 * `upsert` is `INSERT ... ON CONFLICT(instrument) DO UPDATE`, not a plain
 * INSERT guarded against the PK like `SqliteSetupStore`/`SqliteExecutionStore`
 * do: those stores treat a duplicate key as a caller bug. Here the port
 * contract is the opposite — a stale row from a crashed prior tick is meant
 * to be safely clobbered by the next upsert (orchestrator-spec.md's
 * "disposable, best-effort" framing) — so silently overwriting is correct,
 * not a bug to guard against.
 */

import type { SharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';
import type { AssetClass, CurrentTick, CurrentTickStore, TickStage } from './types.js';

interface CurrentTickRow {
  instrument: string;
  asset_class: AssetClass;
  stage: TickStage;
  trace_id: string;
  updated_at: string;
}

export class SqliteCurrentTickStore implements CurrentTickStore {
  constructor(private readonly db: SharedStore) {}

  upsert(row: CurrentTick): void {
    this.db
      .prepare(
        `INSERT INTO current_tick (instrument, asset_class, stage, trace_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(instrument) DO UPDATE SET
           asset_class = excluded.asset_class,
           stage = excluded.stage,
           trace_id = excluded.trace_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.instrument,
        row.asset_class,
        row.stage,
        row.trace_id,
        toStoredTimestamp(row.updated_at),
      );
  }

  delete(instrument: string): void {
    this.db.prepare('DELETE FROM current_tick WHERE instrument = ?').run(instrument);
  }

  get(instrument: string): CurrentTick | undefined {
    const row = this.db
      .prepare('SELECT * FROM current_tick WHERE instrument = ?')
      .get(instrument) as CurrentTickRow | undefined;
    if (row === undefined) return undefined;
    return {
      instrument: row.instrument,
      asset_class: row.asset_class,
      stage: row.stage,
      trace_id: row.trace_id,
      updated_at: fromStoredTimestamp(row.updated_at),
    };
  }
}
