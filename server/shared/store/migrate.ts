/**
 * Hand-rolled numbered migration runner — docs/specs/shared-sqlite-store-spec.md
 * "Module: Migrations" (#193). No ORM: numbered `NNNN_name.sql` files applied in
 * order, each recorded in `schema_migrations` so re-running is a no-op.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';

/** `<dir>/migrations`, resolved next to this module (source and build output alike) */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[\w-]+\.sql$/;

interface Migration {
  version: number;
  filename: string;
}

/** Migration files under `dir`, sorted ascending by version */
export function listMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .map((filename) => ({ filename, match: MIGRATION_FILE.exec(filename) }))
    .filter((entry): entry is { filename: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ filename, match }) => ({ version: Number(match[1]), filename }))
    .sort((a, b) => a.version - b.version);
}

/**
 * Applies every migration not yet recorded in `schema_migrations`, in version
 * order. Each file is applied inside a transaction together with its
 * `schema_migrations` row, so a failing migration leaves no partial version.
 * Returns the versions applied by this call (empty on an up-to-date DB).
 */
export function runMigrations(db: BetterSqlite3.Database, dir: string = MIGRATIONS_DIR): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);`);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );
  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const appliedNow: number[] = [];

  for (const migration of listMigrations(dir)) {
    if (applied.has(migration.version)) {
      continue;
    }

    const sql = readFileSync(join(dir, migration.filename), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(migration.version, new Date().toISOString());
    })();
    appliedNow.push(migration.version);
  }

  return appliedNow;
}
