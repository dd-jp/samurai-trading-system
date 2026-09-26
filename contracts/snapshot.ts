import type { MetricsSuite, ProfitFactorWire } from './metrics.js';
import type { PipelineStage, PipelineView } from './pipeline.js';
import type { AssetClass, Direction, OrderState, StoreMode } from './primitives.js';
import type { ProviderStatusPanel } from './providers.js';
import { contractVersionOf } from './version.js';

export interface TickStatus {
  instrument: string;
  asset_class: AssetClass;
  stage: PipelineStage | 'position_check';
  trace_id: string;
}

export interface PositionRow {
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  filled_size: number;
  avg_entry_price: number;
  stop: number;
  target: number;
  order_state: OrderState;
  mark_price: number;
  unrealized_pnl: number;
  opened_at: string;
}

export type DebateTerminationWire = 'converged' | 'non_converged' | 'latency_truncated';

export type DebateTerminationCauseWire = 'budget' | 'llm_failure';

export interface DebateRow {
  debate_id: string;
  instrument: string;
  direction: Direction;
  rounds: number;
  created_at: string;
  termination?: DebateTerminationWire;
  termination_cause?: DebateTerminationCauseWire;
  contributions: {
    analyst_id: string;
    analyst_type: string;
    final_position: Direction;
    influence_score: number;
    stance_during_debate?: Direction[];
  }[];
}

export type TradingArmWire = 'live' | 'control';

export interface ArmPerformanceWire {
  arm: TradingArmWire;
  trade_count: number;
  realized_pnl_net: number;
  return_pct: number;
  max_drawdown_pct: number;
  refused_pass_count: number | null;
  cost_basis_drops: ExitClassDropCountsWire | null;
}

export const EXIT_CLASSES_WIRE = ['protective', 'flatten'] as const;
export type ExitClassWire = (typeof EXIT_CLASSES_WIRE)[number];

export interface CostBasisDropCountWire {
  kept: number;
  dropped: number;
}

export type ExitClassDropCountsWire = Readonly<
  Record<ExitClassWire, Readonly<CostBasisDropCountWire>>
>;

export interface ArmComparisonRow {
  computed_at: string;
  window_from: string;
  window_to: string;
  basis: number;
  live: ArmPerformanceWire;
  control: ArmPerformanceWire;
  diverged: boolean;
  divergence_reason: string | null;
  min_trades_per_arm: number;
}

export type OutsideBenchmarkWire = 'spy' | 'sixty_forty';

export interface OutsideBenchmarkRow {
  computed_at: string;
  benchmark: OutsideBenchmarkWire;
  window_from: string;
  window_to: string;
  buy_and_hold_return_pct: number;
  max_drawdown_pct: number;
  observation_count: number;
}

export type PnlRateSource = 'static_sizing_rate';

export interface PnlOverallWire {
  net_gbp: number;
  net_pct_of_book: number;
  max_drawdown_pct: number;
  trade_count: number;
}

export interface PnlTodayWire {
  net_gbp: number;
  net_pct_of_book: number;
  realized_gbp: number;
  unrealized_gbp: number;
  costs_gbp: number;
  trade_count: number;
}

export interface PnlHeadlineWire {
  overall: PnlOverallWire;
  today: PnlTodayWire;
  rate_usd_per_gbp: number;
  rate_source: PnlRateSource;
  book_gbp: number;
}

export type CloseReason =
  | 'stop'
  | 'target'
  | 'exit'
  | 'flatten'
  | 'signal_decay'
  | 'direction_flip';

export interface ClosedTradeRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  entry_price: number;
  exit_price: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: string;
  closed_at: string;
  close_reason: CloseReason;
}

export interface FillRow {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
}

export interface VerdictRow {
  trace_id: string;
  instrument: string;
  status: 'go' | 'no_go';
  reason: string;
  hitl_override: boolean;
  timestamp: string;
}

export type InvalidationComparatorWire = '<' | '<=' | '>' | '>=';
export type InvalidationConditionStateWire = 'breached' | 'not_breached' | 'unevaluable';

export type InvalidationDropReasonWire =
  | 'unparseable'
  | 'unknown_observable'
  | 'unknown_indicator'
  | 'lookback_too_large'
  | 'threshold_out_of_range'
  | 'direction_incoherent'
  | 'over_cap';

export interface EvaluatedConditionWire {
  id: string;
  observable: string;
  comparator: InvalidationComparatorWire;
  threshold: number;
  state: InvalidationConditionStateWire;
  observed: number | null;
  rationale: string;
}

export interface DroppedConditionWire {
  id: string | null;
  raw: string;
  reason: InvalidationDropReasonWire;
}

export interface RiskCriticRow {
  trace_id: string;
  instrument: string;
  debate_id: string | null;
  binding_constraint: string | null;
  critic_verdict: 'pass' | 'trim' | 'reject' | 'unavailable' | null;
  reasoning: string | null;
  conditions: EvaluatedConditionWire[] | null;
  dropped_conditions: DroppedConditionWire[] | null;
  created_at: string;
}

export interface AnalystPerformanceRow {
  analyst_id: string;
  weight: number;
  rolling_r: number;
  window_days: number;
}

export type MetricsSuiteWire = Omit<MetricsSuite, 'profit_factor'> & {
  profit_factor: ProfitFactorWire;
};

export interface LlmSpendWindow {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  calls: number;
  unpriced_calls: number;
  per_debate: LlmPerDebateStats;
}

export interface LlmPerDebateStats {
  debates: number;
  unattributed_calls: number;
  cost_usd_p50: number;
  cost_usd_p95: number;
  llm_latency_ms_p50: number;
  llm_latency_ms_p95: number;
}

export interface LlmSpendSummary {
  last_24h: LlmSpendWindow;
  last_7d: LlmSpendWindow;
  all_time: LlmSpendWindow;
  cap_usd: number | null;
  cap_armed_at: string | null;
}

export interface DashboardSnapshot {
  generated_at: string;
  as_of: string;
  mode: StoreMode;
  arm: TradingArmWire;
  tick_status: TickStatus | null;
  positions: PositionRow[];
  closed_trades: ClosedTradeRow[];
  fills: FillRow[];
  debates: DebateRow[];
  verdicts: VerdictRow[];
  risk_critics: RiskCriticRow[];
  analysts: AnalystPerformanceRow[];
  metrics: MetricsSuiteWire;
  arm_comparison: ArmComparisonRow[];
  outside_benchmarks: OutsideBenchmarkRow[];
  pnl: PnlHeadlineWire;
  alert_delivery_failures_24h: number;
  providers: ProviderStatusPanel;
  llm_spend: LlmSpendSummary;
  pipeline: PipelineView;
  contract_version: string;
}

export const DASHBOARD_SNAPSHOT_FIELD_NAMES = [
  'generated_at',
  'as_of',
  'mode',
  'arm',
  'tick_status',
  'positions',
  'closed_trades',
  'fills',
  'debates',
  'verdicts',
  'risk_critics',
  'analysts',
  'metrics',
  'arm_comparison',
  'outside_benchmarks',
  'pnl',
  'alert_delivery_failures_24h',
  'providers',
  'llm_spend',
  'pipeline',
  'contract_version',
] as const satisfies readonly (keyof DashboardSnapshot)[];

type _MissingDashboardSnapshotFieldNames = Exclude<
  keyof DashboardSnapshot,
  (typeof DASHBOARD_SNAPSHOT_FIELD_NAMES)[number]
>;
const _assertDashboardSnapshotFieldNamesCoverAllKeys: {
  [K in _MissingDashboardSnapshotFieldNames]: never;
} = {};

export const CONTRACT_VERSION = contractVersionOf(DASHBOARD_SNAPSHOT_FIELD_NAMES);
