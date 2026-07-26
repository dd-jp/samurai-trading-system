/**
 * Trader (Stage 3) — see docs/specs/trader-spec.md, epic #54.
 * Ticket #73: core decision, DebateResult -> OrderIntent entry bracket.
 * Position-aware branching (scale_in / exit / hold) is #74; cosine precedent
 * retrieval is #75. Neither is implemented here.
 */

export { decide } from './decide.js';
export { computeIdempotencyKey } from './idempotency-key.js';
export {
  type SetupAssetClass,
  SqliteSetupStore,
  type SqliteSetupStoreOptions,
} from './sqlite-setup-store.js';
export type { AssetClass, Trader, TraderConfig, TraderInput } from './types.js';
export { DEFAULT_TRADER_CONFIG } from './types.js';
