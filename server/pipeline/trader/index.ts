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
  checkExitsWithReason,
  decide,
  decideWithReason,
  type ExitCheckInput,
  type TraderDiagnostic,
  type TraderDiagnosticKind,
  type TraderOutcome,
  type TraderSkipReason,
} from './decide.js';
export {
  DEFAULT_EARLY_EXIT_CONFIG,
  type EarlyExitConfig,
  readSignalDecay,
  type SignalDecayRead,
  type SignalDecayVerdict,
} from './early-exit.js';
export { FixtureSetupStore } from './fixture-setup-store.js';
export { computeIdempotencyKey } from './idempotency-key.js';
export { buildSetupVector, type SetupMarketContext } from './setup-vector.js';
export {
  type SetupAssetClass,
  SqliteSetupStore,
  type SqliteSetupStoreOptions,
} from './sqlite-setup-store.js';
// Only the three names with consumers outside `server/pipeline/trader/` are
// re-exported here (coding-standards.md §9): the composition root reads the two
// D5 fractions, and both the root and its tests read the bracket table. The
// rest of the module — `resolveSubclassBracket`, `riskFractionFor`, the two
// types and the error — is consumed only by `decide.ts` and `types.ts` beside
// it, and a barrel entry for a symbol nothing outside imports is an exported
// surface nobody asked for.
export {
  ADR_0018_SUBCLASS_BRACKETS,
  D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
} from './subclass-bracket.js';
export type { AssetClass, Trader, TraderConfig, TraderInput } from './types.js';
export { assertTraderConfigSound, DEFAULT_TRADER_CONFIG } from './types.js';
