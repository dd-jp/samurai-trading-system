/**
 * Domain types for the Feedback Loop (Stage 6) — daily batch cycle (#91),
 * setup-store R-labelling on trade close (#92), and metrics/revalidation
 * breach alerting (#93). See docs/specs/feedback-loop-spec.md ("Key
 * Interfaces", "Module: Weight Attribution", "Module: Guardrailed Tuning",
 * "Module: Metrics & Revalidation", "Module: Setup Store Labelling").
 *
 * Scope note: the repo populates its interfaces ticket-by-ticket — #91 is
 * `runDailyCycle`, #92 is `onTradeClose`, #93 is `computeMetrics`.
 */
import type { MetricsSuite } from '../cost-model-backtest/index.js';
import type {
  Clock,
  ClosedTrade,
  ClosedTradeStore,
  DebateLogStore,
  SetupStore,
  TuningStore,
} from '../shared/index.js';

export type {
  DailyCycleInput,
  DailyCycleResult,
  FeedbackLoop,
  OnTradeCloseInput,
} from './types/cycle.js';
export type {
  BreachAlert,
  BreachAlertChannel,
  DailyMetricsSample,
  DailyMetricsSource,
  KillThresholds,
  MetricsInput,
  MetricsReport,
  RevalidationSnapshot,
} from './types/metrics.js';
export type {
  Adjustment,
  AdjustmentLog,
  FeedbackConfig,
  LoosenApprovalChannel,
  LoosenApprovalRequest,
  PendingApprovalAdjustment,
  TunableDial,
  TuningProposal,
} from './types/tuning.js';
