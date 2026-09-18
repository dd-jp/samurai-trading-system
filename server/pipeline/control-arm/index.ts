export {
  type ArmComparison,
  type ArmCostBasisDrops,
  type ArmPerformance,
  type ArmRefusedPassCounts,
  buildArmComparison,
  type CostBasisDropCount,
  cumulativePnl,
  EXIT_CLASSES,
  type ExitClass,
  type ExitClassDropCounts,
  noCostBasisDrops,
} from './arm-comparison.js';
export {
  CONTROL_DEBATE_ID_PREFIX,
  CONTROL_TRACE_SUFFIX,
  controlArmDecision,
} from './axis-vote-decision.js';
export {
  type ArmedClosedTrade,
  type ClosedTradeWindow,
  SqliteArmComparisonSource,
} from './sqlite-arm-comparison-source.js';
