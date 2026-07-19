/**
 * Feedback Loop (Stage 6) — see docs/specs/feedback-loop-spec.md, epic #59.
 * Implemented ticket-by-ticket: #91 is the daily batch cycle (attribution +
 * bounded/guardrailed tuning). Setup-store R-labelling on trade close (#92)
 * and metrics/revalidation (#93) are not built yet.
 */
export {
  type AnalystCredit,
  accumulateCredit,
  creditForContribution,
  impliedWeight,
  realizedR,
} from './attribution.js';
export { runDailyCycle } from './daily-cycle.js';
export { getContributionsForAttribution } from './debate-attribution-lookup.js';
export {
  InMemoryAdjustmentLog,
  InMemoryClosedTradeStore,
  InMemoryTuningStore,
} from './fixture-stores.js';
export { applyGuardrail, boundedStep, type GuardrailOutcome, moveDirection } from './guardrails.js';
export type {
  Adjustment,
  AdjustmentLog,
  DailyCycleInput,
  DailyCycleResult,
  FeedbackConfig,
  FeedbackLoop,
  LoosenApprovalChannel,
  LoosenApprovalRequest,
  TunableDial,
  TuningProposal,
} from './types.js';
