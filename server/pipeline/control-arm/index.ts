/**
 * Falsifier arm 2 — the mandated matched control (#753).
 *
 * ADR-0014 amendment 2 and ADR-0017 §Consequences name it; CLAUDE.md's Key
 * Constraints line names it; this is where it lives. See
 * `axis-vote-decision.ts` for what the control decides from and why it is shaped
 * as a `DebateResult`, and `arm-comparison.ts` for why drawdown is a required
 * field.
 *
 * The WIRING — the tick-loop hook that runs the control alongside the live arm on
 * every tick — is `server/apps/orchestrator/control-arm.ts`, because it depends on
 * the orchestrator's runner and context. Nothing in this directory imports an LLM
 * client, a debate engine implementation or a market-intelligence agent.
 */
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
