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
 * required — every stage call in a pass must log and audit-record). Ticket
 * #96 adds `CurrentTickStore` to `TickContext` (the disposable per-instrument
 * progress row) and the dead-man's-switch heartbeat (heartbeat.ts).
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

/**
 * The disposable per-instrument progress row (#96, resolves
 * cross-spec-contracts.md GAP-K). Not a system-of-record: losing it on crash
 * costs nothing but a stale progress indicator, since the row is re-upserted
 * next tick (orchestrator-spec.md story 15).
 */
export interface CurrentTick {
  instrument: string;
  asset_class: AssetClass;
  stage: TickStage;
  trace_id: string;
  updated_at: Date;
}

/**
 * shared_store.current_tick port (#96). One row per instrument: `upsert`
 * overwrites any existing row for that instrument (a stale row from a
 * crashed prior tick is safely clobbered, per orchestrator-spec.md's
 * "disposable, best-effort" framing), `delete` clears it on tick completion.
 */
export interface CurrentTickStore {
  upsert(row: CurrentTick): void;
  delete(instrument: string): void;
  get(instrument: string): CurrentTick | undefined;
}

export interface TickContext {
  /** Wall-clock live; the harness's simulated clock in replay. */
  clock: Clock;
  /** Generated at Signal emission, threaded through every stage call in this pass. */
  trace_id: string;
  /** Shared structured-logging interface (#95); every stage call logs through it. */
  logger: Logger;
  /** shared_store.audit_log writer (#95); one record per stage reached in this pass. */
  auditLog: AuditLog;
  /** shared_store.current_tick writer (#96); upserted before each stage, deleted on completion. */
  currentTickStore: CurrentTickStore;
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
 * `analysts` and `debate` bind through a thin adapter rather than directly:
 * `AnalystOrchestrator.runAnalysts`/`runDebate` don't match this shape 1:1
 * (extra positional args, a richer return type) — see
 * `src/orchestrator/production/analysts-adapter.ts` and `debate-adapter.ts`
 * (ticket #235, ADR-0004 §3).
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
