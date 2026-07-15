/**
 * Orchestrator seams — see docs/specs/orchestrator-spec.md ("Module:
 * Scheduler", "Module: Tick Runner"), epic #60.
 *
 * These interfaces are transcribed from the spec, which already fixes their
 * shape. They are declared here (their owning component) rather than in the
 * backtest harness because the harness must *drive* them, not define them:
 * cost-model-backtest-spec.md's "same code path" guarantee is precisely that
 * replay calls the Orchestrator's tick loop with a different injected clock.
 *
 * The implementations are ticket #94 (core tick loop / scheduler wiring) and
 * are NOT provided here — #88 only needs the seam to drive. Until #94 lands,
 * the harness's only callers are fakes in tests.
 */
import type { AssetClass, Signal } from '../analysts/types.js';
import type { ExecutionResult } from '../execution/types.js';
import type { Clock } from '../shared/clock.js';

/** Given a clock and a universe, decide what fires this tick. */
export interface Scheduler {
  nextTick(clock: Clock): TickPlan;
}

export interface TickPlan {
  instruments: { asset: string; asset_class: AssetClass }[];
  /** = clock.now(). */
  tick_time: Date;
}

/** Shared structured-logging interface; trace_id threads every line. */
export interface Logger {
  log(entry: {
    trace_id: string;
    stage: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    payload?: unknown;
  }): void;
}

/** shared_store.audit_log writer. */
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

/**
 * Stage dependencies (marketData, store, broker, costModel, ...) are each
 * stage's own concern per its spec; the Orchestrator wires the concrete
 * instances into each stage call, it does not redefine them.
 */
export interface TickContext {
  /** Wall-clock live; the harness's `SimulatedClock` in replay. */
  clock: Clock;
  /** Generated at Signal emission. */
  trace_id: string;
  logger: Logger;
  auditLog: AuditLog;
}

export interface TickOutcome {
  trace_id: string;
  final_stage: 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';
  verdict_status?: 'go' | 'no_go';
  /** From execution-spec; only present on a Verdict `go`. */
  execution_result?: ExecutionResult;
}

/** Primary seam. One call per instrument per tick. */
export interface TickRunner {
  runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome>;
}
