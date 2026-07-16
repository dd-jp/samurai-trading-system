/**
 * Orchestrator domain types & seams — see docs/specs/orchestrator-spec.md
 * (Module: Scheduler, Module: Tick Runner), epic #60.
 *
 * Ticket #94 shipped the core wiring (TickSteps, TickRunner, TickStage).
 * Ticket #88 (backtest harness) needs the seam to drive replay; the harness
 * calls the Orchestrator's tick loop with a different injected clock
 * (cost-model-backtest-spec.md's "same code path" guarantee).
 *
 * Ticket #95 wires `Logger` / `AuditLog` through `TickContext` (both
 * required — every stage call in a pass must log and audit-record). The
 * `current_tick` progress row and the dead-man's-switch heartbeat remain
 * #96's.
 */
import type { Signal } from '../analysts/types.js';
import type { AnalystView, DebateResult } from '../debate-engine/types.js';
import type { ExecutionResult } from '../execution/types.js';
import type { RiskDecision } from '../risk-manager/types.js';
import type { Clock } from '../shared/clock.js';
import type { OrderIntent } from '../shared/types.js';
import type { VerdictDecision } from '../verdict/types.js';

export type AssetClass = 'crypto' | 'stocks';

/** One entry in the configured universe (orchestrator-spec.md story 3). */
export interface UniverseInstrument {
  asset: string;
  asset_class: AssetClass;
}

/** What fires this tick, decided by the Scheduler against the injected clock. */
export interface TickPlan {
  instruments: UniverseInstrument[];
  /** = clock.now() */
  tick_time: Date;
}

/** The Scheduler seam: given a clock and a universe, decide what fires. */
export interface Scheduler {
  nextTick(clock: Clock): TickPlan;
}

/** Shared structured-logging interface; trace_id threads every line (#95). */
export interface Logger {
  log(entry: {
    trace_id: string;
    stage: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    payload?: unknown;
  }): void;
}

/** shared_store.audit_log writer (#95). */
export interface AuditLog {
  record(entry: {
    trace_id: string;
    stage: string;
    decision: string;
    input_digest: string;
    output_digest: string;
    timestamp: Date;
  }): void;
}

/** The stage a tick reached before terminating (successfully or by short-circuit). */
export type TickStage = 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';

export interface TickContext {
  /** Wall-clock live; the harness's simulated clock in replay. */
  clock: Clock;
  /** Generated at Signal emission, threaded through every stage call in this pass. */
  trace_id: string;
  /** Shared structured-logging interface (#95); every stage call logs through it. */
  logger: Logger;
  /** shared_store.audit_log writer (#95); one record per stage reached in this pass. */
  auditLog: AuditLog;
}

export interface TickOutcome {
  trace_id: string;
  final_stage: TickStage;
  verdict_status?: 'go' | 'no_go';
  /** Only present on a Verdict `go` — Execution is not called otherwise. */
  execution_result?: ExecutionResult;
}

/**
 * The six pipeline steps as bound callables — the TickRunner's only
 * dependency, and the primary test seam.
 *
 * Why callables rather than the stage objects themselves: the stages are
 * inconsistent about how they take dependencies, and each needs ancillary
 * deps the tick chain never touches. Closing those over at composition
 * time keeps this module to sequencing — orchestrator-spec.md's
 * "assert wiring, not stage logic" — and keeps the short-circuit test to
 * faking six functions.
 *
 * `analysts` and `debate` have no implementation to bind yet: the multi-persona
 * fan-out/quorum is #71/#72 (#70 shipped a single `technicalAnalyst`) and the
 * Debate Engine's core is unimplemented under epic #40.
 */
export interface TickSteps {
  analysts(input: { trace_id: string; signal: Signal; clock: Clock }): Promise<AnalystView[]>;
  debate(input: {
    trace_id: string;
    instrument: string;
    views: AnalystView[];
    clock: Clock;
  }): Promise<DebateResult>;
  /** null = skip / no-trade; short-circuits before Risk. */
  trader(input: {
    trace_id: string;
    instrument: string;
    debate: DebateResult;
    clock: Clock;
  }): Promise<OrderIntent | null>;
  risk(input: { trace_id: string; intent: OrderIntent; clock: Clock }): Promise<RiskDecision>;
  verdict(input: {
    trace_id: string;
    risk_decision: RiskDecision;
    clock: Clock;
  }): Promise<VerdictDecision>;
  /** Called only on a Verdict `go` (orchestrator-spec.md story 7). */
  execution(verdict: VerdictDecision): Promise<ExecutionResult>;
}

/** The Tick Runner seam. One call per instrument per tick. */
export interface TickRunner {
  runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome>;
}
