/**
 * Feedback Loop (Stage 6) — see docs/specs/feedback-loop-spec.md, epic #59.
 * Implemented ticket-by-ticket: #91 is the daily batch cycle (attribution +
 * bounded/guardrailed tuning); #92 is event-driven setup-store R-labelling
 * on trade close. #93 is metrics recomposition + kill-threshold breach alerting.
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
export {
  computeMetrics,
  DSR_INSIGNIFICANT,
  LIVE_BACKTEST_DIVERGENCE_OVER_MAX,
  OOS_SHARPE_UNDER_MIN,
  PBO_OVER_MAX,
  REVALIDATION_GATED_KILL_LINES,
} from './metrics.js';
export { onTradeClose } from './on-trade-close.js';
export {
  type SeedAnalystWeightsInput,
  type SeedAnalystWeightsResult,
  seedAnalystWeights,
} from './seed-analyst-weights.js';
export { SqliteAdjustmentLog } from './sqlite-adjustment-log.js';
export { SqliteClosedTradeStore } from './sqlite-closed-trade-store.js';
export { SqliteTuningStore } from './sqlite-tuning-store.js';
export type {
  Adjustment,
  AdjustmentLog,
  BreachAlert,
  BreachAlertChannel,
  DailyCycleInput,
  DailyCycleResult,
  DailyMetricsSample,
  DailyMetricsSource,
  FeedbackConfig,
  FeedbackLoop,
  KillThresholds,
  LoosenApprovalChannel,
  LoosenApprovalRequest,
  MetricsInput,
  MetricsReport,
  OnTradeCloseInput,
  PendingApprovalAdjustment,
  RevalidationSnapshot,
  TunableDial,
  TuningProposal,
} from './types.js';
