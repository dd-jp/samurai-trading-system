import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './migrate.js';

export type StoreHandle = BetterSqlite3.Database;

const STORE_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;

export { STORE_MODES, type StoreMode } from '../../../contracts/index.js';

import { STORE_MODES, type StoreMode } from '../../../contracts/index.js';

export function resolveStoreMode(raw: string | undefined = process.env.SAMURAI_MODE): StoreMode {
  const mode = (STORE_MODES as readonly string[]).includes(raw ?? '')
    ? (raw as StoreMode)
    : undefined;
  if (mode === undefined) {
    throw new Error(
      `Refusing to resolve a shared-store path: SAMURAI_MODE must be one of ` +
        `${STORE_MODES.join('|')} and is ${JSON.stringify(raw)}. The store file is named after ` +
        'the trading mode (#168/#330) precisely so a live run cannot inherit paper positions, ' +
        'and guessing the mode would defeat that.',
    );
  }
  return mode;
}

export function sharedStorePath(mode: StoreMode = resolveStoreMode()): string {
  const path = `data/samurai-${mode}.sqlite`;
  assertNoStrandedLegacyStore(path);
  return path;
}

function legacyStorePath(rawEnv: string | undefined = process.env.NODE_ENV): string {
  const env = rawEnv ?? 'development';
  if (!(STORE_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new Error(
      `Refusing to derive the legacy store path for NODE_ENV=${JSON.stringify(env)}: it must be ` +
        `one of ${STORE_ENVIRONMENTS.join('|')}.`,
    );
  }
  return `data/samurai-${env}.sqlite`;
}

function assertNoStrandedLegacyStore(path: string): void {
  if (existsSync(path)) return;

  let legacy: string;
  try {
    legacy = legacyStorePath();
  } catch {
    return;
  }
  if (!existsSync(legacy)) return;

  throw new Error(
    `Refusing to start against an empty store: ${path} does not exist, but ${legacy} does. ` +
      'Store files are named after the TRADING MODE as of #330 (they used to be named after ' +
      `NODE_ENV), so this run would open a fresh database and see none of the positions, fills ` +
      'or tuning history in the old one — while any real positions stay open at the broker.\n' +
      `Decide which this is, then move it deliberately:  mv ${legacy} ${path}\n` +
      'If the old file is live-money state, do NOT hand it to a paper run: keep it as ' +
      'data/samurai-live.sqlite instead.',
  );
}

function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const directory = dirname(dbPath);
  if (directory === '.') return;
  mkdirSync(directory, { recursive: true });
}

// Several processes share one v2 store (the cycle, the dashboard API and the Telegram poller); without a busy timeout
// the loser of a write race fails with SQLITE_BUSY at once instead of waiting. It is set before
// journal_mode because switching to WAL takes a lock the other process may hold
const BUSY_TIMEOUT_MS = 5_000;

function applyPragmas(db: StoreHandle): void {
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
}

export function openSharedStore(dbPath: string): StoreHandle {
  ensureParentDirectory(dbPath);
  const db = new BetterSqlite3(dbPath);
  applyPragmas(db);
  runMigrations(db);
  return db;
}

function appliedSchemaVersion(db: StoreHandle): number {
  const hasLedger =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined;
  if (!hasLedger) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

export function openMigratedStore(dbPath: string, minimumVersion: number): StoreHandle {
  const db = new BetterSqlite3(dbPath, { fileMustExist: true });
  applyPragmas(db);
  const version = appliedSchemaVersion(db);
  if (version < minimumVersion) {
    db.close();
    throw new Error(
      `${dbPath} is at schema version ${version}, below ${minimumVersion}; run the process that owns it to migrate first`,
    );
  }
  return db;
}

export function openReadOnlyStore(dbPath: string): StoreHandle {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}
