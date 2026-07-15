/**
 * Cost Model / Backtest Harness — see docs/specs/cost-model-backtest-spec.md, epic #58.
 * Implemented ticket-by-ticket starting with #87.
 *
 * Ticket #88 adds the replay harness — `BacktestHarness` (Seam 2), the
 * no-lookahead auditor and the survivorship-free universe check — plus the
 * stepped `SimulatedClock` (exported from src/shared/clock.ts, beside the
 * `Clock` every stage already injects).
 *
 * The harness drives the Orchestrator's `Scheduler` + `TickRunner` (#94)
 * rather than containing a pipeline of its own, so replay and live share one
 * code path by construction. Those implementations do not exist yet — nor does
 * `DebateEngine.run` (epic #40) — so the harness is unit-tested against fakes
 * and the spec's end-to-end fixed-window replay is deferred to those tickets.
 *
 * `BacktestReport` is declared in its #88-fillable subset only: the `metrics`
 * / walk-forward / capacity-ceiling fields belong to the validation library
 * and arrive with the ticket that can honestly populate them, per the staged
 * style of `types.ts` (#87) and `execution/types.ts` (#82).
 */

export type { BacktestDeps } from './backtest.js';
export { BacktestHarness } from './backtest.js';
export { CostModelImpl } from './cost-model.js';
export type { LookaheadViolation } from './lookahead.js';
export { LookaheadAuditor, LookaheadViolationError } from './lookahead.js';
export type {
  AssetClassCostConfig,
  Backtest,
  BacktestConfig,
  BacktestReport,
  CostBreakdown,
  CostConfig,
  CostModel,
  CostModelResult,
  FillRequest,
  MarketState,
  ReplayTimeline,
} from './types.js';
export type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';
export { assertSurvivorshipFree, SurvivorshipViolationError } from './universe.js';
