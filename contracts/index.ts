/**
 * The wire contract between the two runtimes.
 *
 * `client/` and `server/` are compiled by different toolchains against
 * different libs. This directory is the only thing both are allowed to import,
 * and it imports nothing from either — which is what makes the boundary real
 * rather than decorative. Before it existed, the browser app reached backend
 * source directly (`../../../../dashboard/types.ts`, sixteen files), so its
 * TypeScript program included server modules it was explicitly excluded from.
 *
 * ## The rule for what belongs here
 *
 * **JSON-serializable shapes only.** If a type carries a `Date`, a function,
 * or a class instance, it is pre-wire and belongs to whichever runtime owns
 * it. That single test is what keeps `DashboardQueryStore` (methods),
 * `PipelineActivity` (`Date` fields) and `ProviderStatusReader` (behavior) on
 * the server side, while their serialized projections live here.
 *
 * Enforced mechanically rather than by review — `boundary.test.ts` asserts on
 * the source text that nothing here imports out of this directory, takes a
 * runtime dependency, or declares a `Date`. `tsc` cannot catch any of those:
 * an import that escapes compiles green and reintroduces the defect silently.
 */

export { type MetricsSuite, type ProfitFactorWire, toProfitFactorWire } from './metrics.js';
export {
  DEGRADED_DECISIONS,
  type DegradedDecision,
  isDegradedDecision,
  isQuorumSkipDecision,
  PIPELINE_STAGES,
  type PipelineCell,
  type PipelineCellState,
  type PipelineLane,
  type PipelineOutcome,
  type PipelineStage,
  type PipelineView,
  QUORUM_SKIP_DECISIONS,
} from './pipeline.js';
export {
  type AssetClass,
  type Direction,
  type InstrumentSubclass,
  type OrderState,
  STORE_MODES,
  type StoreMode,
  type TradingArm,
} from './primitives.js';
export type {
  AlpacaBalanceWire,
  AlpacaTile,
  PolygonTile,
  ProviderState,
  ProviderStatusPanel,
  ProviderTile,
} from './providers.js';
export type {
  AnalystPerformanceRow,
  ArmComparisonRow,
  ArmPerformanceWire,
  ClosedTradeRow,
  CloseReason,
  CostBasisDropCountWire,
  DashboardSnapshot,
  DebateRow,
  DebateTerminationCauseWire,
  DebateTerminationWire,
  DroppedConditionWire,
  EvaluatedConditionWire,
  ExitClassDropCountsWire,
  ExitClassWire,
  FillRow,
  InvalidationComparatorWire,
  InvalidationConditionStateWire,
  InvalidationDropReasonWire,
  LlmPerDebateStats,
  LlmSpendSummary,
  LlmSpendWindow,
  MetricsSuiteWire,
  OutsideBenchmarkRow,
  OutsideBenchmarkWire,
  PnlHeadlineWire,
  PositionRow,
  RiskCriticRow,
  TickStatus,
  TradingArmWire,
  VerdictRow,
} from './snapshot.js';
export {
  CONTRACT_VERSION,
  contractVersionOf,
  EXIT_CLASSES_WIRE,
} from './snapshot.js';
