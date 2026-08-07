/**
 * Shared (cross-stage) — clock abstraction and domain types used by every
 * pipeline stage. See docs/coding-standards.md: cross-module imports go
 * through this barrel, not `shared/clock.js` / `shared/types.js` directly.
 * `shared/store/` has its own barrel (`shared/store/index.ts`) — persistence
 * helpers are not re-exported here.
 */

export type { Clock } from './clock.js';
export { SimulatedClock, SystemClock } from './clock.js';
export type {
  RiskDecisionRecord,
  RiskLogStore,
  TraderDecisionRecord,
  TraderLogStore,
} from './decision-records.js';
// #568: the one definition of "what this lot still holds", shared by the two
// stages that size an exit — Trader (`buildExitIntent`) and Execution
// (`executeExit`). Cross-module, so it belongs on this barrel rather than in
// either stage's own module.
export type { LotHeldQuantity } from './held-quantity.js';
export { heldQuantitiesFor, totalHeldQuantity } from './held-quantity.js';
export { fetchWithTimeout } from './http/fetch-with-timeout.js';
export {
  classifyStatus,
  type HttpErrorKind,
  isTimeoutAbort,
  parseRetryAfterMs,
  readErrorDetail,
  truncateForError,
} from './http/response-errors.js';
export type { RetryConfig } from './http/retry.js';
export { withRetry } from './http/retry.js';
export type { TokenBucketConfig } from './http/token-bucket.js';
export { TokenBucket } from './http/token-bucket.js';
// Only what has a real cross-module consumer: `DEFAULT_VENUE_PACING` for the
// three broker adapters' constructor defaults, `resolveVenuePacing` +
// `VenuePacingConfig` for the composition root, `resolvePolygonPacing`
// for `HttpPolygonClient` (#510/#520 — deliberately NOT folded into
// `resolveVenuePacing`/`VENUE_KEYS`: see that function's doc for why a
// Stage-2-only venue must not be validated by the live composition root),
// and `resolveCoinbasePacing`/`resolveBitstampPacing` for the #512/#496
// warm-start backfill script's primary/fallback crypto clients (same
// reasoning, same shape, two more script-only venues).
// `VenueKey`, `VENUE_KEYS`, `VENUE_DOCUMENTED_CEILING_PER_SECOND`,
// `POLYGON_DOCUMENTED_CEILING_PER_SECOND`, `DEFAULT_POLYGON_PACING`,
// `DEFAULT_COINBASE_PACING`, `DEFAULT_BITSTAMP_PACING` and
// `venuePacingEnvVars` are internal to `venue-pacing.ts` and its own test
// (or, for `venuePacingEnvVars`, imported directly by
// `http-polygon-client.test.ts` — see that barrel-exclusion note there), so
// they stay off this barrel.
export type { VenuePacingConfig } from './http/venue-pacing.js';
export {
  DEFAULT_VENUE_PACING,
  resolveBitstampPacing,
  resolveCoinbasePacing,
  resolvePolygonPacing,
  resolveVenuePacing,
} from './http/venue-pacing.js';
export { sanitizeLogText } from './sanitize-log-text.js';
export type {
  AssetClass,
  ClosedTrade,
  ClosedTradeStore,
  DebateLog,
  DebateLogStore,
  Fill,
  LogEntry,
  Logger,
  OpenPosition,
  OrderIntent,
  OrderIntentMetadata,
  OrderState,
  SetupNeighbor,
  SetupStore,
  SetupVector,
  TuningStore,
  VerdictLog,
  VerdictLogStore,
} from './types.js';
