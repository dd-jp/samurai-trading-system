export { NO_PRECEDENT_MULTIPLIER } from './cosine-precedent.js';
export {
  checkExitsWithReason,
  decide,
  decideWithReason,
  mostRecentOpenLot,
  type TraderDiagnostic,
} from './decide.js';
export { DEFAULT_EARLY_EXIT_CONFIG } from './early-exit.js';
export { FixtureSetupStore } from './fixture-setup-store.js';
export { SqliteSetupStore } from './sqlite-setup-store.js';
export {
  ADR_0018_SUBCLASS_BRACKETS,
  D5_INDEX_ETP_DEPLOYMENT_FRACTION,
  D5_SINGLE_STOCK_ETP_DEPLOYMENT_FRACTION,
} from './subclass-bracket.js';
export type {
  TraderConfig,
  TraderSkipReason,
  UnresolvedFlatten,
} from './types.js';
export { assertTraderConfigSound, DEFAULT_TRADER_CONFIG } from './types.js';
