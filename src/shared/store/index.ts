/**
 * Shared SQLite store (#193) — see docs/specs/shared-sqlite-store-spec.md.
 * `openSharedStore(dbPath)` is the injectable handle; components receive it by
 * constructor injection and own their own tables.
 */
export { MIGRATIONS_DIR, runMigrations } from './migrate.js';
export { openSharedStore, type SharedStore, sharedStorePath } from './open-shared-store.js';
