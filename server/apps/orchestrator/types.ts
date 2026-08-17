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
import type { Signal } from '../../pipeline/analysts/index.js';
import type { AnalystView, DebateResult } from '../../pipeline/debate-engine/index.js';
import type { ExecutionResult } from '../../pipeline/execution/index.js';
import type { RiskDecision } from '../../pipeline/risk-manager/index.js';
import type { VerdictDecision } from '../../pipeline/verdict/index.js';
import type { AssetClass, Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';

export type { AssetClass, InstrumentSubclass };

/** One entry in the configured universe (orchestrator-spec.md story 3). */
export interface UniverseInstrument {
  asset: string;
  asset_class: AssetClass;
  /**
   * ADR-0018's pricing dimension, sourced from the LSE-ETP pool file.
   *
   * Optional because the universe predates it: the smoke universe, the
   * backtest fixtures and every existing profile name instruments without
   * one, and a required field would break them all to express something they
   * do not use.
   *
   * The one thing that reads this field today is `d5EnvelopeFor`
   * (paper-profile.ts), which SKIPS unclassified rows when building
   * `SubclassDeploymentCap.subclass_of` — deliberately, so a partly-populated
   * pool file still arms the gate. The refusal then happens where the money
   * actually moves: `perSubclassDeploymentCap` throws for an intent whose own
   * instrument has no subclass, rather than sizing it with no envelope. Read
   * the gate, not this field, for what a missing subclass costs.
   */
  subclass?: InstrumentSubclass;
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

/**
 * Shared structured-logging interface; trace_id threads every line (#95).
 * Canonical shape lives in `shared/types.ts` (code-review 2026-08-01, M6);
 * re-exported here so orchestrator-internal imports keep working.
 */
import type { LogEntry, Logger } from '../../shared/index.js';

// `LogEntry` travels with `Logger`, not separately: it is the argument type of
// `Logger.log`, so anything building a fake logger against this module needs
// both. Five call sites were already importing it from here on that
// assumption and silently getting nothing, because until `tsconfig.test.json`
// existed no compiler read them.
export type { LogEntry, Logger };

/** shared_store.audit_log writer (#95). */
export interface AuditLog {
  record(entry: {
    trace_id: string;
    stage: string;
    decision: string;
    input_digest: string;
    output_digest: string;
    timestamp: Date;
    /**
     * Which instrument this trace belonged to (migration 0013). Optional
     * because the HITL callback path records under an existing `trace_id`
     * with no `Signal` in scope; absent means "not attributable", never
     * "no instrument".
     */
    instrument?: string;
    asset_class?: AssetClass;
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
  /**
   * Absent only when `error` is set (#507). `SequentialTickRunner.runInstrument`
   * always resolves to one of the six stage names below — but a pass that
   * THREW never reached a `return`, so tick-loop.ts's per-worker catch has no
   * stage to report. Fabricating one (e.g. defaulting to the first stage)
   * would misrepresent where the pipeline actually died; an absent field is
   * the honest record, not a fabricated one — same posture production.ts's
   * doc comment takes on injected seams ("an honest injected seam beats a
   * fabricated implementation").
   */
  final_stage?: TickStage;
  verdict_status?: 'go' | 'no_go';
  /** Only present on a Verdict `go` — Execution is not called otherwise. */
  execution_result?: ExecutionResult;
  /**
   * Set only when the instrument's pipeline pass threw instead of returning
   * normally (#507: a failed tick declaring itself finished while sibling
   * workers kept running). Caught in tick-loop.ts's worker — never here in
   * `runInstrument` itself, which deliberately has no try/catch (see
   * tick-runner.ts's doc comment: a crash must leave the `current_tick` row
   * stale for the next tick to safely clobber, not be swallowed and cleaned
   * up). Presence of this field IS the failure signal; `final_stage`,
   * `verdict_status` and `execution_result` are all absent alongside it.
   */
  error?: string;
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
 * `server/apps/orchestrator/production/analysts-adapter.ts` and `debate-adapter.ts`
 * (ticket #235, ADR-0004 §3).
 */
export interface TickSteps {
  analysts(input: { trace_id: string; signal: Signal; clock: Clock }): Promise<AnalystView[]>;
  debate(input: {
    trace_id: string;
    instrument: string;
    /**
     * The instrument's asset class, forwarded from the tick's `Signal` (#388).
     *
     * Added because the Debate Engine's per-asset-class controls are keyed on
     * it and none could be wired without it: `RateLimiter`'s `perAssetClass`
     * limits, `LATENCY_BUDGET_MS`'s crypto-30s/stocks-60s hard timeout (#374),
     * and `MAX_ROUNDS_BY_ASSET_CLASS`'s round cap (#581) — all live in
     * `debate-adapter.ts`.
     *
     * Carried on the step input rather than resolved from a universe map
     * inside the adapter: the runner already holds `Signal.asset_class` as
     * authoritative fact, and a second lookup table keyed on instrument name
     * is a place for the two to disagree.
     */
    asset_class: AssetClass;
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
