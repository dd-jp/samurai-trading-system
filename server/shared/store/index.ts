/**
 * Shared SQLite store (#193) — see docs/specs/shared-sqlite-store-spec.md.
 * `openSharedStore(dbPath)` is the injectable handle; components receive it by
 * constructor injection and own their own tables.
 */
export { type ClosedTradeRow, fromClosedTradeRow } from './closed-trade-row.js';
export {
  assertNoStaleKeyScheme,
  findStaleKeySchemeLots,
  type StaleKeySchemeLot,
  TERMINAL_ORDER_STATES,
} from './key-scheme-guard.js';
export { MIGRATIONS_DIR, runMigrations } from './migrate.js';
export {
  legacyStorePath,
  openSharedStore,
  resolveStoreMode,
  type SharedStore,
  STORE_MODES,
  type StoreMode,
  sharedStorePath,
} from './open-shared-store.js';
export { SqliteRiskLogStore, SqliteTraderLogStore } from './sqlite-decision-record-stores.js';
export { isUniqueConstraintError } from './sqlite-utils.js';
