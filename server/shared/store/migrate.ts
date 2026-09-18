
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[\w-]+\.sql$/;

interface Migration {
  version: number;
  filename: string;
}

export function listMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .map((filename) => ({ filename, match: MIGRATION_FILE.exec(filename) }))
    .filter((entry): entry is { filename: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ filename, match }) => ({ version: Number(match[1]), filename }))
    .sort((a, b) => a.version - b.version);
}

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
