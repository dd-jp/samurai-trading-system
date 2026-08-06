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
// three broker adapters' constructor defaults, and `resolveVenuePacing` +
// `VenuePacingConfig` for the composition root. `VenueKey`, `VENUE_KEYS`,
// `VENUE_DOCUMENTED_CEILING_PER_SECOND` and `venuePacingEnvVars` are internal
// to `venue-pacing.ts` and its own test, so they stay off the barrel.
export type { VenuePacingConfig } from './http/venue-pacing.js';
export { DEFAULT_VENUE_PACING, resolveVenuePacing } from './http/venue-pacing.js';
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
