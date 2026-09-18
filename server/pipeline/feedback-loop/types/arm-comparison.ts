import type { Clock } from '../../../shared/index.js';
import type {
  ArmComparison,
  ArmPerformance,
  ArmRefusedPassCounts,
  ClosedTradeWindow,
  ExitClassDropCounts,
} from '../../control-arm/index.js';

export interface ArmComparisonSource {
  getClosedTradeWindowBetween(from: Date, to: Date): ClosedTradeWindow;
  getRefusedPassCountsBetween(from: Date, to: Date): ArmRefusedPassCounts;
}

export interface ArmDivergenceThresholds {
  min_return_gap_pct: number;
  min_trades_per_arm: number;
}

export interface ArmDivergenceVerdict {
  diverged: boolean;
  reason: string | null;
  min_trades_per_arm: number;
}

export interface ArmComparisonSample {
  computed_at: Date;
  comparison: ArmComparison;
  divergence: ArmDivergenceVerdict;
}

type PersistedArmPerformance = Omit<ArmPerformance, 'refused_pass_count' | 'cost_basis_drops'> & {
  refused_pass_count: number | null;
  cost_basis_drops: ExitClassDropCounts | null;
};

interface PersistedArmComparison extends Omit<ArmComparison, 'live' | 'control'> {
  live: PersistedArmPerformance;
  control: PersistedArmPerformance;
}

export interface PersistedArmComparisonSample extends Omit<ArmComparisonSample, 'comparison'> {
  comparison: PersistedArmComparison;
}

export interface ArmComparisonSampleStore {
  append(sample: ArmComparisonSample): void;
  getRecent(limit: number, asOf: Date): PersistedArmComparisonSample[];
}

export interface ArmDivergenceAlert {
  comparison: ArmComparison;
  reason: string;
  reported_at: Date;
}

export interface ArmDivergenceAlertChannel {
  postArmDivergenceAlert(alert: ArmDivergenceAlert): void;
}

export interface ArmComparisonCycleInput {
  clock: Clock;
  trades: ArmComparisonSource;
  samples: ArmComparisonSampleStore;
  alerts: ArmDivergenceAlertChannel;
  basis: number;
  window_ms: number;
  thresholds: ArmDivergenceThresholds;
}
