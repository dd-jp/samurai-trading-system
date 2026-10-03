import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import type { AssetClass } from '../../../shared/index.js';
import { runMigrations } from '../../../shared/store/index.js';
import type { IntelligenceItem } from '../types.js';
import type { MiSourceId } from './mi-sources.js';

const MI_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

type ArchiveFidelity = 'live' | 'backfill';

export interface RawArchiveRow {
  source: MiSourceId;
  native_id: string;
  updated_at: Date;
  payload: string;
  ingested_at: Date;
  fidelity: ArchiveFidelity;
}

export interface ArchivedItem {
  source: MiSourceId;
  native_id: string;
  updated_at: Date;
  entity: string;
  asset_class: AssetClass;
  item: IntelligenceItem;
  ingested_at: Date;
}

interface ItemRow {
  asset_class: string;
  item_json: string;
}

interface RawRow {
  source: MiSourceId;
  native_id: string;
  updated_at: string;
  payload: string;
  ingested_at: string;
  fidelity: ArchiveFidelity;
}

function toRawArchiveRow(row: RawRow): RawArchiveRow {
  return {
    source: row.source,
    native_id: row.native_id,
    updated_at: new Date(row.updated_at),
    payload: row.payload,
    ingested_at: new Date(row.ingested_at),
    fidelity: row.fidelity,
  };
}

function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const directory = dirname(dbPath);
  if (directory === '.') return;
  mkdirSync(directory, { recursive: true });
}

export class MiArchiveStore {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath = ':memory:', options: { readonly?: boolean } = {}) {
    if (options.readonly === true) {
      this.db = new BetterSqlite3(dbPath, { readonly: true });
      return;
    }
    ensureParentDirectory(dbPath);
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db, MI_MIGRATIONS_DIR);
  }

  write(raws: readonly RawArchiveRow[], items: readonly ArchivedItem[]): void {
    const insertRaw = this.db.prepare(
      `INSERT OR IGNORE INTO mi_archive_raw
         (source, native_id, updated_at, payload, ingested_at, fidelity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertItem = this.db.prepare(
      `INSERT OR IGNORE INTO mi_items
         (source, native_id, updated_at, entity, asset_class, timestamp,
          sentiment, confidence, item_json, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const raw of raws) {
        insertRaw.run(
          raw.source,
          raw.native_id,
          raw.updated_at.toISOString(),
          raw.payload,
          raw.ingested_at.toISOString(),
          raw.fidelity,
        );
      }
      for (const row of items) {
        insertItem.run(
          row.source,
          row.native_id,
          row.updated_at.toISOString(),
          row.entity,
          row.asset_class,
          row.item.timestamp.toISOString(),
          row.item.sentiment,
          row.item.confidence,
          JSON.stringify(row.item),
          row.ingested_at.toISOString(),
        );
      }
    })();
  }

  itemsKnownAt(
    asset_class: AssetClass,
    asOf: Date,
    sources: readonly MiSourceId[],
  ): IntelligenceItem[] {
    if (sources.length === 0) return [];
    const placeholders = sources.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT asset_class, item_json FROM mi_items
          WHERE asset_class = ? AND ingested_at <= ?
            AND source IN (${placeholders})
          ORDER BY timestamp ASC`,
      )
      .all(asset_class, asOf.toISOString(), ...sources) as ItemRow[];

    return rows.map((row) => {
      const item = JSON.parse(row.item_json) as IntelligenceItem;
      return { ...item, timestamp: new Date(item.timestamp) };
    });
  }

  hasItem(source: MiSourceId, native_id: string, updated_at: Date): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM mi_archive_raw
          WHERE source = ? AND native_id = ? AND updated_at = ?`,
      )
      .get(source, native_id, updated_at.toISOString()) as { present: number } | undefined;

    return row !== undefined;
  }

  hasScoredItem(source: MiSourceId, native_id: string, updated_at: Date, entity: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM mi_items
          WHERE source = ? AND native_id = ? AND updated_at = ? AND entity = ?`,
      )
      .get(source, native_id, updated_at.toISOString(), entity) as { present: number } | undefined;

    return row !== undefined;
  }

  latestUpdatedAt(source: MiSourceId): Date | undefined {
    const row = this.db
      .prepare('SELECT MAX(updated_at) AS newest FROM mi_archive_raw WHERE source = ?')
      .get(source) as { newest: string | null } | undefined;

    return row?.newest == null ? undefined : new Date(row.newest);
  }

  rawRows(source: MiSourceId): RawArchiveRow[] {
    const rows = this.db
      .prepare('SELECT * FROM mi_archive_raw WHERE source = ? ORDER BY ingested_at ASC')
      .all(source) as RawRow[];

    return rows.map(toRawArchiveRow);
  }

  purgeOlderThan(cutoff: Date): { rawDeleted: number; itemsDeleted: number } {
    const cutoffIso = cutoff.toISOString();
    return this.db.transaction(() => {
      const itemsDeleted = this.db
        .prepare('DELETE FROM mi_items WHERE ingested_at < ?')
        .run(cutoffIso).changes;
      const rawDeleted = this.db
        .prepare('DELETE FROM mi_archive_raw WHERE ingested_at < ?')
        .run(cutoffIso).changes;
      return { rawDeleted, itemsDeleted };
    })();
  }

  close(): void {
    this.db.close();
  }
}
