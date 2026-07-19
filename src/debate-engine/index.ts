/**
 * Debate Engine (Stage 2) — see docs/specs/debate-engine-spec.md, epic #40.
 * Implemented ticket-by-ticket starting with #24.
 */
export { computeDebateId } from './debate-id.js';
export type {
  DebateAnalystFailure,
  DebateLogger,
  DebatePersona,
  LogSink,
} from './debate-logger.js';
export { JsonDebateLogger } from './debate-logger.js';
export type { AnalystContribution, AnalystView, DebateResult, Direction } from './types.js';
