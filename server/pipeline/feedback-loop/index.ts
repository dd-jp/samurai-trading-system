
export {
  ARM_DIVERGENCE_RETURN_GAP_PCT,
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
  runArmComparisonCycle,
} from './arm-comparison-cycle.js';
export {
  accumulateCredit,
  creditForContribution,
  realizedR,
} from './attribution.js';
export { currentBoundary, isBoundaryDue, nextBoundary } from './cycle-schedule.js';
export { runDailyCycle } from './daily-cycle.js';
export {
  InMemoryClosedTradeStore,
  InMemoryTuningStore,
} from './fixture-stores.js';
export {
  assertKillThresholdsWithinBounds,
  computeMetrics,
} from './metrics.js';
export { onTradeClose } from './on-trade-close.js';
export { runOutsideBenchmarkCycle } from './outside-benchmark-cycle.js';
export { seedAnalystWeights } from './seed-analyst-weights.js';
export { SqliteAdjustmentLog } from './sqlite-adjustment-log.js';
export { SqliteArmComparisonSampleStore } from './sqlite-arm-comparison-sample-store.js';
export { SqliteClosedTradeStore } from './sqlite-closed-trade-store.js';
export { SqliteFeedbackCycleScheduleStore } from './sqlite-feedback-cycle-schedule-store.js';
export { SqliteOutsideBenchmarkSampleStore } from './sqlite-outside-benchmark-sample-store.js';
export { SqliteTuningStore } from './sqlite-tuning-store.js';
export type {
  AdjustmentLog,
  ArmDivergenceAlertChannel,
  BreachAlert,
  BreachAlertChannel,
  DailyMetricsSample,
  DailyMetricsSource,
  FeedbackConfig,
  LoosenAppliedNotice,
  LoosenNotificationChannel,
  OnTradeCloseInput,
  PersistedArmComparisonSample,
  RevalidationSnapshot,
  TunableDial,
  TuningProposal,
} from './types.js';
