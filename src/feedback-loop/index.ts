/**
 * Feedback Loop (Stage 6) — see docs/specs/feedback-loop-spec.md, epic #59.
 * Implemented ticket-by-ticket: #91 is the daily batch cycle (attribution +
 * bounded/guardrailed tuning); #93 is metrics recomposition + kill-threshold
 * breach alerting. Setup-store R-labelling on trade close (#92) is not built
 * yet.
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
  InMemoryBreachAlertChannel,
  InMemoryClosedTradeStore,
  InMemoryTuningStore,
} from './fixture-stores.js';
export { applyGuardrail, boundedStep, type GuardrailOutcome, moveDirection } from './guardrails.js';
export { computeMetrics } from './metrics.js';
export type {
  Adjustment,
  AdjustmentLog,
  BreachAlert,
  BreachAlertChannel,
  DailyCycleInput,
  DailyCycleResult,
  FeedbackConfig,
  FeedbackLoop,
  KillThresholds,
  LoosenApprovalChannel,
  LoosenApprovalRequest,
  MetricsInput,
  MetricsReport,
  RevalidationSnapshot,
  TunableDial,
  TuningProposal,
} from './types.js';
