import type { Clock, TuningStore } from '../../../shared/index.js';
import type { MetricsSuite } from '../../../tools/backtest/index.js';
import type { AdjustmentLog, FeedbackConfig } from './tuning.js';

export interface KillThresholds {
  max_pbo: number;
  min_oos_sharpe: number;
  min_deflated_sharpe: number;
  max_live_backtest_divergence: number;
}

export interface RevalidationSnapshot {
  walk_forward_sharpe_distribution: number[];
  deflated_sharpe: number;
  pbo: number;
}

export interface BreachAlertChannel {
  postBreachAlert(alert: BreachAlert): void;
}

export interface BreachAlert {
  breaches: string[];
  reported_at: Date;
}

export interface MetricsInput {
  clock: Clock;
  daily: MetricsSuite;
  backtest_reference_sharpe: number;
  revalidation?: RevalidationSnapshot;
  tuning: TuningStore;
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  alerts: BreachAlertChannel;
}

export interface MetricsReport {
  daily: MetricsSuite;
  revalidation?: RevalidationSnapshot;
  breaches: string[];
  not_evaluated: string[];
}
