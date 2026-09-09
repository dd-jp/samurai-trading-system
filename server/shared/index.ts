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
export { nonEmpty, positiveIntegerFromEnv, requireIntegerAtLeast } from './env-integer.js';
// #568: the one definition of "what this lot still holds", shared by the two
// stages that size an exit — Trader (`buildExitIntent`) and Execution
// (`executeExit`). Cross-module, so it belongs on this barrel rather than in
// either stage's own module.
export type { LotHeldQuantity } from './held-quantity.js';
export { heldQuantitiesFor, totalHeldQuantity } from './held-quantity.js';
export { delay } from './http/delay.js';
export { fetchWithTimeout } from './http/fetch-with-timeout.js';
export {
  classifyStatus,
  type HttpErrorKind,
  isServerErrorStatus,
  isTimeoutAbort,
  MAX_ERROR_BODY_CHARS,
  parseRetryAfterMs,
  readErrorBody,
  readErrorDetail,
  truncateForError,
} from './http/response-errors.js';
export type { RetryAttemptReport, RetryConfig } from './http/retry.js';
export { withRetry } from './http/retry.js';
export type { TokenBucketConfig, TokenBucketTelemetry } from './http/token-bucket.js';
export { TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS, TokenBucket } from './http/token-bucket.js';
// Only what has a real cross-module consumer: `DEFAULT_VENUE_PACING` for the
// three broker adapters' constructor defaults, `resolveVenuePacing` +
// `VenuePacingConfig` for the composition root, and `resolvePolygonPacing`
// for `HttpPolygonClient` (#510/#520 — deliberately NOT folded into
// `resolveVenuePacing`/`VENUE_KEYS`: see that function's doc for why a
// Stage-2-only venue must not be validated by the live composition root).
// `DEFAULT_POLYGON_PACING` joined the barrel in #562: the live orchestrator's
// equities OHLCV fallback (orchestrator/production/data-failover.ts) resolves
// `SAMURAI_PACING_POLYGON_*` at boot and falls back to this checked-in default
// on a malformed override rather than refusing to boot — see that module's doc
// for why that one variable is not worth failing a live start over.
// `VenueKey`, `VENUE_KEYS`, `VENUE_DOCUMENTED_CEILING_PER_SECOND`,
// `POLYGON_DOCUMENTED_CEILING_PER_SECOND` and `venuePacingEnvVars` are
// internal to `venue-pacing.ts` and its own test (or, for
// `venuePacingEnvVars`, imported directly by `http-polygon-client.test.ts` —
// see that barrel-exclusion note there), so they stay off this barrel.
export type { VenuePacingConfig } from './http/venue-pacing.js';
export {
  DEFAULT_POLYGON_PACING,
  DEFAULT_VENUE_PACING,
  resolvePolygonPacing,
  resolveVenuePacing,
} from './http/venue-pacing.js';
// #573: three consumers (orchestrator/tick-loop.ts, execution/ingest-fills.ts,
// execution/reconcile.ts) need the identical "a log call inside a catch must
// not itself throw" guarantee — see safe-log.ts's file doc.
export {
  describeThrown,
  describeThrownSafely,
  logCaughtFailure,
  safeLog,
} from './safe-log.js';
export { maskAndCap, maskCredentials, sanitizeLogText } from './sanitize-log-text.js';
export type {
  ContinueOnFaultEffects,
  ErrorStream,
  ProcessFault,
  StdoutStream,
} from './stdout-fault-guard.js';
export { guardedWrite, installContinueOnFault, watchStdoutErrors } from './stdout-fault-guard.js';
// #638: the in-code clamp on the kill-line and breaker thresholds. Exported
// from the shared barrel because the three paths that can put a threshold into
// force — boot-time construction, the tuning store's write, and the Risk
// Manager's live read — sit in three different packages and must consult ONE
// bounds table, or the clamp drifts apart into three that disagree.
export type { GuardedThresholdName, ThresholdBound } from './threshold-bounds.js';
export {
  assertThresholdsWithinBounds,
  assertThresholdWithinBounds,
  boundFor,
  GUARDED_THRESHOLD_BOUNDS,
  GUARDED_THRESHOLD_NAMES,
  isThresholdBoundViolation,
  ThresholdBoundViolationError,
} from './threshold-bounds.js';
export { currentTraceId, runWithTraceId } from './trace-context.js';
export type {
  AssetClass,
  ClosedTrade,
  ClosedTradeStore,
  DebateLog,
  DebateLogStore,
  DebateTermination,
  DebateTerminationCause,
  ExitReason,
  Fill,
  InstrumentSubclass,
  LogEntry,
  LogEntryTemplate,
  LogEventCode,
  Logger,
  LogLevel,
  OpenPosition,
  OrderIntent,
  OrderIntentMetadata,
  OrderState,
  SetupNeighbor,
  SetupStore,
  SetupVector,
  TradingArm,
  TuningStore,
  VerdictLog,
  VerdictLogStore,
} from './types.js';
