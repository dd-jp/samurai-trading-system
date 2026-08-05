/**
 * Shared (cross-stage) — clock abstraction and domain types used by every
 * pipeline stage. See docs/coding-standards.md: cross-module imports go
 * through this barrel, not `shared/clock.js` / `shared/types.js` directly.
 * `shared/store/` has its own barrel (`shared/store/index.ts`) — persistence
 * helpers are not re-exported here.
 */

export type { Clock } from './clock.js';
export { SimulatedClock, SystemClock } from './clock.js';
export { fetchWithTimeout } from './http/fetch-with-timeout.js';
export { parseRetryAfterMs, truncateForError } from './http/response-errors.js';
export type { RetryConfig } from './http/retry.js';
export { withRetry } from './http/retry.js';
export type { TokenBucketConfig } from './http/token-bucket.js';
export { TokenBucket } from './http/token-bucket.js';
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
