
import type {
  AssetClass,
  LlmSpendSummary,
  MetricsSuite,
  PipelineStage,
  TickStatus,
} from '../../../contracts/index.js';
import type { PersistedArmComparisonSample } from '../../pipeline/feedback-loop/index.js';
import type { OutsideBenchmarkSample } from '../../pipeline/outside-benchmark/index.js';
import type { RiskCriticVerdict } from '../../pipeline/risk-manager/index.js';
import type { Mark } from '../../providers/market-data-service/index.js';
import type { ClosedTrade, DebateLog, Fill, OpenPosition, TradingArm } from '../../shared/index.js';

export type {
  ArmComparisonRow,
  ClosedTradeRow,
  DashboardSnapshot,
  EvaluatedConditionWire,
  FillRow,
  LlmPerDebateStats,
  LlmSpendSummary,
  LlmSpendWindow,
  MetricsSuiteWire,
  OutsideBenchmarkRow,
  PositionRow,
  RiskCriticRow,
  TickStatus,
} from '../../../contracts/index.js';

export interface VerdictAuditEntry {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  reason: string;
  hitl_override: boolean;
  timestamp: Date;
}

export interface RiskCriticRecord {
  trace_id: string;
  instrument: string;
  debate_id: string | null;
  binding_constraint: string | null;
  critic: RiskCriticVerdict | undefined;
  created_at: Date;
}

export interface AttributionSummary {
  analyst_id: string;
  rolling_r: number;
  window_days: number;
}

export interface PipelineStageEvent {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  stage: PipelineStage;
  decision: string;
  timestamp: Date;
}

export interface PipelineLiveTick {
  instrument: string;
  asset_class: AssetClass;
  stage: PipelineStage;
  trace_id: string;
  entered_at: Date;
}

export interface PipelineActivity {
  universe: { instrument: string; asset_class: AssetClass }[];
  events: PipelineStageEvent[];
  live: PipelineLiveTick[];
}

export interface DashboardQueryStore {
  getRecentDebates(limit: number, asOf: Date): DebateLog[];
  getTickStatus(asOf: Date): TickStatus | null;
  getOpenPositions(asOf: Date, arm: TradingArm): OpenPosition[];
  getRecentClosedTrades(limit: number, asOf: Date, arm: TradingArm): ClosedTrade[];
  getAllClosedTrades(asOf: Date, arm: TradingArm): ClosedTrade[];
  getFillsForTrades(idempotencyKeys: readonly string[], asOf: Date): Fill[];
  getVerdictHistory(limit: number, asOf: Date, arm: TradingArm): VerdictAuditEntry[];
  getRiskCritics(limit: number, asOf: Date, arm: TradingArm): RiskCriticRecord[];
  getAnalystWeights(asOf: Date): Record<string, number>;
  getAttribution(asOf: Date, arm: TradingArm): Record<string, AttributionSummary>;
  getDailyMetrics(asOf: Date, arm: TradingArm): MetricsSuite;
  getArmComparisons(limit: number, asOf: Date): PersistedArmComparisonSample[];
  getOutsideBenchmarks(limit: number, asOf: Date): OutsideBenchmarkSample[];
  getMark(instrument: string, asOf: Date): Mark;
  getMarks(instruments: readonly string[], asOf: Date): Map<string, Mark>;
  getLlmSpend(asOf: Date): LlmSpendSummary;
  getPipelineActivity(
    maxLanes: number,
    lookbackMs: number,
    asOf: Date,
    arm: TradingArm,
  ): PipelineActivity;
  getAlertDeliveryFailureCount(asOf: Date): number;
}
