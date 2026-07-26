/**
 * `openSharedStore(dbPath)` — the single injectable handle every stage's spec
 * assumes (docs/specs/shared-sqlite-store-spec.md "Module: Wiring", #193).
 * Opens the DB, sets WAL + `synchronous=FULL` (the crash-restart invariant from
 * CONTEXT.md), runs pending migrations, returns the connection.
 *
 * One file per environment (`data/samurai-{env}.sqlite`); tests pass a temp
 * path or `:memory:`. Two paths never share state — paper/live cross-
 * contamination is physically impossible.
 */
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './migrate.js';

/** The typed handle passed to components by constructor injection. */
export type SharedStore = BetterSqlite3.Database;

export function openSharedStore(dbPath: string): SharedStore {
  const db = new BetterSqlite3(dbPath);
  // WAL is a no-op on an in-memory DB; SQLite ignores it rather than failing.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
