import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { AssetClass, CurrentTick, CurrentTickStore, TickStage } from './types.js';

interface CurrentTickRow {
  instrument: string;
  asset_class: AssetClass;
  stage: TickStage;
  trace_id: string;
  updated_at: string;
}

export class SqliteCurrentTickStore implements CurrentTickStore {
  constructor(private readonly db: StoreHandle) {}

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
