/**
 * Trader (Stage 3) — see docs/specs/trader-spec.md, epic #54.
 * Ticket #73: core decision, DebateResult -> OrderIntent entry bracket.
 * Ticket #74: position-aware branching (scale_in / exit / hold).
 * Ticket #75 built cosine retrieval; #432 wired it into `decide`.
 */

export {
  type CosinePrecedentResult,
  NO_PRECEDENT_MULTIPLIER,
  retrieveCosinePrecedent,
} from './cosine-precedent.js';
export {
  decide,
  decideWithReason,
  type TraderOutcome,
  type TraderSkipReason,
} from './decide.js';
export { FixtureSetupStore } from './fixture-setup-store.js';
export { computeIdempotencyKey } from './idempotency-key.js';
export { buildSetupVector, type SetupMarketContext } from './setup-vector.js';
export {
  type SetupAssetClass,
  SqliteSetupStore,
  type SqliteSetupStoreOptions,
} from './sqlite-setup-store.js';
export type { AssetClass, Trader, TraderConfig, TraderInput } from './types.js';
export { DEFAULT_TRADER_CONFIG } from './types.js';
