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
export { DEFAULT_MAX_LLM_CALL_ROWS, pruneLlmCallLog } from './prune-llm-call-log.js';
export { SqliteRiskLogStore, SqliteTraderLogStore } from './sqlite-decision-record-stores.js';
export { SqliteLlmSpendCapStore } from './sqlite-llm-spend-cap-store.js';
export {
  fromStoredTimestamp,
  fromStoredTimestampOrNull,
  isUniqueConstraintError,
  type StoredTimestamp,
  toStoredTimestamp,
  toStoredTimestampOrNull,
} from './sqlite-utils.js';
export {
  guardedStore,
  isStoreWriteGuardEnabled,
  STAGE_OWNED_TABLES,
  STORE_OWNER_STAGES,
  type StoreOwnerStage,
  type StoreWriteGuardEnvironment,
  writeTargetTables,
} from './write-guard.js';
