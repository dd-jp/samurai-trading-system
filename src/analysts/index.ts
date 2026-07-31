/**
 * Analysts (Stage 1) — see docs/specs/analysts-spec.md, epic #53.
 * Ticket #70: one stateless persona (Technical) end-to-end. Ticket #71:
 * the remaining personas (Fundamental, Sentiment) and the
 * `AnalystOrchestrator` (applicability filtering + role-dependent quorum).
 * Retry-on-failure and the 2-consecutive-skip alert are not implemented
 * here — no ticket covers them yet.
 */

export { fundamentalAnalyst } from './fundamental-analyst.js';
export { AnalystOrchestrator, type AnalystOrchestratorDeps } from './orchestrator.js';
export { sentimentAnalyst } from './sentiment-analyst.js';
export { technicalAnalyst } from './technical-analyst.js';
export type {
  Analyst,
  AnalystFailure,
  AnalystInput,
  AnalystRunResult,
  AssetClass,
  Signal,
} from './types.js';
