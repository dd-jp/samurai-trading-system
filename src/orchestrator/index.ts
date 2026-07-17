/**
 * Orchestrator — see docs/specs/orchestrator-spec.md, epic #60.
 * Main entry point (`npm run orchestrator`).
 *
 * Ticket #94: the scheduler, the sequential stage chain, and bounded
 * concurrency across instruments. Ticket #95: trace-ID propagation into
 * structured logs and the `audit_log` spine (`JsonLogger`, `InMemoryAuditLog`,
 * `digest`). Ticket #96: the `current_tick` row (`InMemoryCurrentTickStore`)
 * and the dead-man's-switch heartbeat (`Heartbeat`, `TradeChannelHeartbeat`).
 * There is no production composition root yet — binding the real stage
 * instances needs `ingestFills`/reconciliation (#83, #86) and the Analysts
 * fan-out (#71) that do not exist yet.
 */
export { InMemoryAuditLog } from './audit-log.js';
export { InMemoryCurrentTickStore } from './current-tick-store.js';
export { digest } from './digest.js';
export { Heartbeat, type HeartbeatChannel } from './heartbeat.js';
export { TradeChannelHeartbeat } from './heartbeat-channel.js';
export { JsonLogger } from './logger.js';
export { DEFAULT_UNIVERSE, type SchedulerConfig, UniverseScheduler } from './scheduler.js';
export { runTickPlan, type TickLoopConfig } from './tick-loop.js';
export { SequentialTickRunner } from './tick-runner.js';
export type {
  AssetClass,
  AuditLog,
  CurrentTick,
  CurrentTickStore,
  Logger,
  Scheduler,
  TickContext,
  TickOutcome,
  TickPlan,
  TickRunner,
  TickStage,
  TickSteps,
  UniverseInstrument,
} from './types.js';
