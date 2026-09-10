/**
 * Feedback Loop (Stage 6) — see docs/specs/feedback-loop-spec.md, epic #59.
 * Implemented ticket-by-ticket: #91 is the daily batch cycle (attribution +
 * bounded/guardrailed tuning); #92 is event-driven setup-store R-labelling
 * on trade close. #93 is metrics recomposition + kill-threshold breach alerting.
 */

export {
  ARM_DIVERGENCE_RETURN_GAP_PCT,
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  evaluateArmDivergence,
  MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
  runArmComparisonCycle,
} from './arm-comparison-cycle.js';
export {
  type AnalystCredit,
  accumulateCredit,
  bandMidpoint,
  creditForContribution,
  impliedWeight,
  realizedR,
} from './attribution.js';
export { currentBoundary, isBoundaryDue, nextBoundary } from './cycle-schedule.js';
export { runDailyCycle } from './daily-cycle.js';
export { getContributionsForAttribution } from './debate-attribution-lookup.js';
export {
  InMemoryAdjustmentLog,
  InMemoryArmComparisonSampleStore,
  InMemoryBreachAlertChannel,
  InMemoryClosedTradeStore,
  InMemoryOutsideBenchmarkSampleStore,
  InMemoryTuningStore,
} from './fixture-stores.js';
export { applyGuardrail, boundedStep, type GuardrailOutcome, moveDirection } from './guardrails.js';
export {
  assertKillThresholdsWithinBounds,
  computeMetrics,
  DSR_INSIGNIFICANT,
  LIVE_BACKTEST_DIVERGENCE_OVER_MAX,
  OOS_SHARPE_UNDER_MIN,
  PBO_OVER_MAX,
  REVALIDATION_GATED_KILL_LINES,
} from './metrics.js';
export { onTradeClose } from './on-trade-close.js';
export { runOutsideBenchmarkCycle } from './outside-benchmark-cycle.js';
export {
  type SeedAnalystWeightsInput,
  type SeedAnalystWeightsResult,
  seedAnalystWeights,
} from './seed-analyst-weights.js';
export { SqliteAdjustmentLog } from './sqlite-adjustment-log.js';
export { SqliteArmComparisonSampleStore } from './sqlite-arm-comparison-sample-store.js';
export { SqliteClosedTradeStore } from './sqlite-closed-trade-store.js';
export { SqliteFeedbackCycleScheduleStore } from './sqlite-feedback-cycle-schedule-store.js';
export { SqliteOutsideBenchmarkSampleStore } from './sqlite-outside-benchmark-sample-store.js';
export { SqliteTuningStore } from './sqlite-tuning-store.js';
export type {
  Adjustment,
  AdjustmentLog,
  ArmComparisonCycleInput,
  ArmComparisonSample,
  ArmComparisonSampleStore,
  ArmComparisonSource,
  ArmDivergenceAlert,
  ArmDivergenceAlertChannel,
  ArmDivergenceThresholds,
  ArmDivergenceVerdict,
  BreachAlert,
  BreachAlertChannel,
  DailyCycleInput,
  DailyCycleResult,
  DailyMetricsSample,
  DailyMetricsSource,
  FeedbackConfig,
  FeedbackLoop,
  KillThresholds,
  LoosenAppliedNotice,
  LoosenNotificationChannel,
  MetricsInput,
  MetricsReport,
  OnTradeCloseInput,
  OutsideBenchmarkCycleInput,
  OutsideBenchmarkCycleResult,
  OutsideBenchmarkSampleStore,
  PendingApprovalAdjustment,
  PersistedArmComparison,
  PersistedArmComparisonSample,
  PersistedArmPerformance,
  RevalidationSnapshot,
  TunableDial,
  TuningProposal,
  UnmeasuredOutsideBenchmark,
} from './types.js';
