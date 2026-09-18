import type { KillThresholds } from './metrics.js';

export interface TunableDial {
  max_step: number;
  floor: number;
  ceiling: number;
  tighten_is: 'increase' | 'decrease';
}

export interface FeedbackConfig {
  attribution_window_ms: number;
  weights: TunableDial;
  strategy_params: Record<string, TunableDial>;
  risk_thresholds: Record<string, TunableDial>;
  kill_thresholds: KillThresholds;
}

export interface TuningProposal {
  kind: 'strategy_param' | 'risk_threshold';
  name: string;
  target: number;
}

export interface LoosenNotificationChannel {
  notifyLoosenApplied(notice: LoosenAppliedNotice): void;
}

export interface LoosenAppliedNotice {
  name: string;
  from: number;
  to: number;
  applied_at: Date;
}

export interface Adjustment {
  dial: 'analyst_weight' | 'strategy_param' | 'risk_threshold';
  name: string;
  from: number;
  to: number;
  direction: 'tighten' | 'loosen';
  applied_at: Date;
  reason: string;
}

export interface AdjustmentLog {
  append(entry: Adjustment): void;
}

export interface PendingApprovalAdjustment {
  dial: 'strategy_param' | 'risk_threshold';
  name: string;
  from: number;
  to: number;
  direction: 'tighten' | 'loosen';
  requested_at: Date;
  reason: string;
}
