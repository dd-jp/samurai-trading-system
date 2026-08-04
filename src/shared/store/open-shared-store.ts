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
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './migrate.js';

/** The typed handle passed to components by constructor injection. */
export type SharedStore = BetterSqlite3.Database;

/**
 * The environments that may own a shared-store file. `NODE_ENV` is matched
 * against this list rather than interpolated into the path as-is.
 *
 * The reason is *not* path traversal: `NODE_ENV` is operator-controlled, and
 * anyone who can set it can already run arbitrary code, so no privilege
 * boundary is crossed. The real failure is quieter and worse — a typo
 * (`prod`, `Production`, a systemd unit that never exports it) silently opens
 * a *different* SQLite file. The process then starts against an empty
 * database while real positions sit open at the broker, which is precisely
 * the "crash-restart must not lose open positions" invariant (CONTEXT.md)
 * failing in the one way nothing alerts on: cleanly.
 *
 * So an unrecognised value throws instead of defaulting. Falling back to
 * `development` would re-create the wrong-database bug rather than fix it —
 * the same posture `parseMode` takes for `SAMURAI_MODE`.
 *
 * `test` is listed because vitest sets `NODE_ENV=test`; suites that touch a
 * real file pass a temp path or `:memory:` directly and never reach here.
 *
 * Note the list is `NODE_ENV` values, which is what the entrypoints actually
 * key off today. shared-sqlite-store-spec.md § "DB file path convention"
 * (#168) names the files after the *trading mode* instead
 * (`data/samurai-paper.sqlite` / `data/samurai-live.sqlite`) — that gap is
 * documented at `startFromEnvironment` in src/orchestrator/index.ts and is
 * not closed here.
 */
export const STORE_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;

export type StoreEnvironment = (typeof STORE_ENVIRONMENTS)[number];

/**
 * The one file-per-environment path convention
 * (shared-sqlite-store-spec.md): `data/samurai-{env}.sqlite`.
 *
 * Shared by both entrypoints on purpose. The orchestrator writes this file
 * and the dashboard reads it, so the two must agree on its name — deriving it
 * twice is how they drift, and a dashboard pointed at a file the orchestrator
 * never writes shows a healthy, empty system.
 */
export function sharedStorePath(rawEnv: string | undefined = process.env.NODE_ENV): string {
  const env = rawEnv ?? 'development';
  if (!(STORE_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new Error(
      `Refusing to open a shared store for NODE_ENV=${JSON.stringify(env)}: it must be one of ` +
        `${STORE_ENVIRONMENTS.join('|')}. An unrecognised environment would silently open a ` +
        'different database file, starting the process against empty state while real positions ' +
        'are open at the broker.',
    );
  }
  return `data/samurai-${env}.sqlite`;
}

/**
 * SQLite creates the database *file*, never the directory holding it. The
 * convention path is `data/samurai-{env}.sqlite` and `data/` is gitignored, so
 * on every fresh clone the directory is absent and better-sqlite3 throws
 * "Cannot open database because the directory does not exist" — an error that
 * names neither the path nor the fix (#323: it was the first thing `yarn
 * orchestrator` hit once the config guard stopped throwing).
 *
 * Creating it is the writer's own concern, not the operator's: nothing about a
 * `mkdir` is a decision anyone needs to make. `recursive: true` is also
 * idempotent, so this costs one no-op syscall on every subsequent start.
 *
 * `:memory:` (and any bare filename) has no directory component to create;
 * `dirname` answers `'.'` for both, which always exists.
 */
function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const directory = dirname(dbPath);
  if (directory === '.') return;
  mkdirSync(directory, { recursive: true });
}

export function openSharedStore(dbPath: string): SharedStore {
  ensureParentDirectory(dbPath);
  const db = new BetterSqlite3(dbPath);
  // WAL is a no-op on an in-memory DB; SQLite ignores it rather than failing.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
