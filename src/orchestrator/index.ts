/**
 * Orchestrator — see docs/specs/orchestrator-spec.md, epic #60.
 * Main entry point (`npm run orchestrator`).
 *
 * Ticket #94: the scheduler, the sequential stage chain, and bounded
 * concurrency across instruments. Trace-ID propagation into structured logs
 * and the `audit_log` spine are #95; the `current_tick` row and the
 * dead-man's-switch heartbeat are #96. There is no production composition root yet — #94 delivers
 * the seams (`Scheduler`, `TickRunner`, `runTickPlan`), and binding the real
 * stage instances needs `ingestFills`/reconciliation (#83, #86) and the
 * Analysts fan-out (#71) that do not exist yet.
 */
export { DEFAULT_UNIVERSE, type SchedulerConfig, UniverseScheduler } from './scheduler.js';
export { runTickPlan, type TickLoopConfig } from './tick-loop.js';
export { SequentialTickRunner } from './tick-runner.js';
export type {
  AssetClass,
  Scheduler,
  TickContext,
  TickOutcome,
  TickPlan,
  TickRunner,
  TickStage,
  TickSteps,
  UniverseInstrument,
} from './types.js';
