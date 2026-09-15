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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from './migrate.js';

/**
 * The raw database handle passed to components by constructor injection.
 * Named for what it is — a handle, not a store — so it cannot be mistaken for
 * the execution `SharedStore` port (pipeline/execution/types/store.ts), the
 * typed row-level interface over this handle.
 */
export type StoreHandle = BetterSqlite3.Database;

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
 * **No longer what the path is keyed on (#330).** These remain the recognised
 * `NODE_ENV` values, and `legacyStorePath` still builds the old filename so a
 * pre-#330 database can be detected and named in the refusal below. The live
 * path is keyed off the TRADING MODE now — see `sharedStorePath`.
 */
export const STORE_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;

export type StoreEnvironment = (typeof STORE_ENVIRONMENTS)[number];

/**
 * The trading modes that may own a store file (shared-sqlite-store-spec.md
 * #168). Declared in `contracts/primitives.ts` and re-exported here:
 * `DashboardSnapshot.mode` carries it to the browser, which cannot see the
 * server's environment and must not import the store layer to name a mode.
 */
export { STORE_MODES, type StoreMode } from '../../../contracts/index.js';

// Also imported, not just re-exported: `export … from` publishes the names
// without binding them locally, and `resolveStoreMode` below both reads the
// array at runtime and annotates with the type
import { STORE_MODES, type StoreMode } from '../../../contracts/index.js';

/**
 * Resolves the trading mode from `SAMURAI_MODE` — the ONE derivation both
 * entrypoints use (#330).
 *
 * That sharing is the whole point. The orchestrator writes the store and the
 * dashboard reads it, and #330's open question was how the reader derives a
 * mode it is never told: the answer is that it reads the same variable the
 * writer does, from the same function, so the two cannot disagree about which
 * file they mean.
 *
 * Throws rather than defaulting, exactly as `parseMode` does for the same
 * variable. A default of `paper` would be the #330 hazard inverted — a live
 * run whose `SAMURAI_MODE` failed to export would quietly open the paper
 * database and trade real money against paper state.
 */
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

/**
 * The file-per-MODE path convention (shared-sqlite-store-spec.md § "DB file
 * path convention", #168): `data/samurai-{mode}.sqlite`.
 *
 * ## Why this changed (#330)
 *
 * It used to key off `NODE_ENV`. On a single `NODE_ENV=production` host that
 * flips `SAMURAI_MODE` from `paper` to `live` — which is exactly the
 * graduation this project plans — both modes wrote
 * `samurai-production.sqlite`. A live composition root would then inherit
 * paper lots and fills as real state and compute risk caps and drawdown
 * against them. The spec's convention exists to make that "physically
 * impossible", and keying off the environment did the opposite.
 *
 * Shared by both entrypoints on purpose. The orchestrator writes this file and
 * the dashboard reads it, so the two must agree on its name — deriving it
 * twice is how they drift, and a dashboard pointed at a file the orchestrator
 * never writes shows a healthy, empty system.
 */
export function sharedStorePath(mode: StoreMode = resolveStoreMode()): string {
  const path = `data/samurai-${mode}.sqlite`;
  assertNoStrandedLegacyStore(path);
  return path;
}

/**
 * The pre-#330 filename, kept only so a stranded database can be NAMED in the
 * refusal below. Nothing opens it.
 */
export function legacyStorePath(rawEnv: string | undefined = process.env.NODE_ENV): string {
  const env = rawEnv ?? 'development';
  if (!(STORE_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new Error(
      `Refusing to derive the legacy store path for NODE_ENV=${JSON.stringify(env)}: it must be ` +
        `one of ${STORE_ENVIRONMENTS.join('|')}.`,
    );
  }
  return `data/samurai-${env}.sqlite`;
}

/**
 * The migration story #330 asks for, and it is deliberately manual.
 *
 * If the mode-keyed file does not exist yet but a pre-#330 environment-keyed
 * one does, this process is one start away from running against an EMPTY
 * database while real positions sit open at the broker — the same
 * crash-restart invariant `STORE_ENVIRONMENTS` protects, failing the same
 * quiet way.
 *
 * It refuses instead of renaming. Moving a database that may hold live-money
 * state is not a decision a process should make on an operator's behalf: only
 * the operator knows whether `samurai-production.sqlite` is the paper history
 * they want carried forward or a live one that must not be handed to a paper
 * run. The error names both paths and the exact command, so the manual step is
 * one line rather than an investigation.
 *
 * One-shot by construction: once `data/samurai-{mode}.sqlite` exists, this
 * never fires again.
 */
function assertNoStrandedLegacyStore(path: string): void {
  if (existsSync(path)) return;

  // Through `legacyStorePath` rather than rebuilt here (PR #447 review): one
  // place owns the old filename, so a future change to it cannot leave this
  // guard looking for a file that is no longer what a pre-#330 deployment
  // wrote. It throws on an unrecognised NODE_ENV, which is not a reason to
  // fail a start whose own path resolved fine — an environment this guard
  // cannot name simply has no legacy file to strand
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

export function openSharedStore(dbPath: string): StoreHandle {
  ensureParentDirectory(dbPath);
  const db = new BetterSqlite3(dbPath);
  // WAL is a no-op on an in-memory DB; SQLite ignores it rather than failing
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
