/**
 * Analysts (Stage 1) — see docs/specs/analysts-spec.md, epic #53.
 * Ticket #70: one stateless persona (Technical) end-to-end. Ticket #71:
 * the remaining personas (Fundamental, Sentiment) and the
 * `AnalystOrchestrator` (applicability filtering + role-dependent quorum).
 * Ticket #431 added both halves of analysts-spec.md's "Module: Failure
 * Handling": the bounded retry lives here (`orchestrator.ts`), while the
 * 2-consecutive-skip alert is necessarily one layer up in
 * `orchestrator/production/analysts-adapter.ts` — the counter is per
 * instrument across ticks, and this layer is stateless by design.
 */

export { fundamentalAnalyst } from './fundamental-analyst.js';
export {
  ANALYST_STAGE_WALL_CLOCK_MS,
  AnalystOrchestrator,
  type AnalystOrchestratorDeps,
  DEFAULT_ANALYST_TIMEOUT_MS,
} from './orchestrator.js';
export { sentimentAnalyst } from './sentiment-analyst.js';
export type { AxisAssessment } from './technical-analyst.js';
export {
  type AxisVote,
  assessAxes,
  LOW_CONVICTION_CAP,
  MACD_SPEC,
  momentumVote,
  RSI_SPEC,
  RVOL_5M_LOOKBACK,
  technicalAnalyst,
} from './technical-analyst.js';
export type {
  Analyst,
  AnalystFailure,
  AnalystFailureKind,
  AnalystInput,
  AnalystRunResult,
  AnalystTelemetry,
  AssetClass,
  IndicatorUnavailableEvent,
  Signal,
} from './types.js';
export { INDICATOR_UNAVAILABLE_COUNTER, NO_DATA_MARKER } from './types.js';
