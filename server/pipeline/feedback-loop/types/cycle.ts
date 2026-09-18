import type {
  Clock,
  ClosedTradeStore,
  DebateLogStore,
  SetupStore,
  TuningStore,
} from '../../../shared/index.js';
import type {
  AdjustmentLog,
  FeedbackConfig,
  LoosenNotificationChannel,
  TuningProposal,
} from './tuning.js';

export interface DailyCycleInput {
  clock: Clock;
  trades: ClosedTradeStore;
  debate_log: DebateLogStore;
  tuning: TuningStore;
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  loosen_notices: LoosenNotificationChannel;
  proposals: TuningProposal[];
}

export interface DailyCycleResult {
  weight_updates: Record<string, { from: number; to: number }>;
  param_updates: Record<string, { from: number; to: number; direction: 'tighten' | 'loosen' }>;
  applied: boolean;
}

export interface OnTradeCloseInput {
  setup_store: SetupStore;
}
