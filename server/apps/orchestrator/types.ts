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

/**
 * Instrument -> subclass, from the universe — the ONE derivation of the
 * classification (#739), moved here from `paper-profile.ts` in #752 so
 * `production.ts` can read it too without creating a `production.ts` <->
 * `paper-profile.ts` import cycle (`paper-profile.ts` already imports types
 * FROM `production.ts`). `paper-profile.ts` re-exports this rather than
 * redefining it, so the Risk Manager's D5 gate, the Trader's frozen bracket,
 * and #752's per-subclass coverage counter all read the SAME map — three
 * independently built maps would be three places for an instrument to be
 * classified differently.
 */
export function subclassOfUniverse(
  universe: readonly UniverseInstrument[],
): Record<string, InstrumentSubclass> {
  return Object.fromEntries(
    universe.flatMap((instrument) =>
      instrument.subclass === undefined ? [] : [[instrument.asset, instrument.subclass] as const],
    ),
  );
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

/**
 * The stage a pass reached before terminating (successfully or by
 * short-circuit).
 *
 * `'position_check'` (#743) is the tick path's own stage: the
 * mark/bracket/flatten evaluation that runs on EVERY tick, ahead of — and on
 * most ticks instead of — the decision chain. It is the terminal stage of the
 * most common pass in the system (roughly 29 of every 30 at a 2-minute tick
 * against a 60-minute debate bar), and it must be distinguishable from a
 * decision pass that declined to trade, or a healthy exit-only tick reads as a
 * no-trade decision and the trade count looks wrong
 * (orchestrator-spec.md, "The tick/decision split").
 */
export type TickStage =
  | 'position_check'
  | 'analysts'
  | 'debate'
  | 'trader'
  | 'risk'
  | 'verdict'
  | 'execution';

/**
 * The debate bar a decision pass runs for (#743) — THE single source of the
 * bar coordinate for that pass.
 *
 * Produced by the decision gate (`decision-bar-gate.ts`) when a tick is the
 * first to land in a new debate bar, and passed DOWN: the Debate step keys
 * `debate_id` on `open_time` instead of flooring its own `clock.now()`, the
 * resulting `DebateResult.bar_timestamp` carries the same value, and the
 * Trader inherits it from there (#687). Nothing on the decision path derives
 * the bar a second time, which is what makes a gate/Trader disagreement
 * structural rather than a matter of two clock reads landing luckily in the
 * same hour.
 */
export interface DecisionBar {
  /** Stable identity for logs: `<open_time ISO>@<timeframe_ms>`. */
  id: string;
  /** The bar's opening boundary — `floorToBar(tick_time, timeframe_ms)`. */
  open_time: Date;
  /** The debate-bar grid this bar lives on (`DEBATE_BAR_TIMEFRAME_MS`). */
  timeframe_ms: number;
}

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
  /**
   * Set only when this tick opens a new debate bar (#743). Present => the
   * runner runs the DECISION path (Analysts → Debate → Trader → Risk →
   * Verdict → Execution) for this bar. Absent => tick path only (the
   * position-facing exit check).
   *
   * Claimed from the `DecisionGate` by the tick loop, per instrument, BEFORE
   * `runInstrument` — so the gate's bookkeeping lives outside the runner and a
   * crashed pass can be rescinded for the next tick to retry.
   */
  decision_bar?: DecisionBar;
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
   * `true` when a TICK-PATH pass's exit check produced an exit intent — the
   * flat-by-close flatten, including a close already past (#691/#743). Never set on a
   * decision pass, where the Trader's own routing carries the flatten and the
   * intent's `intent_type: 'exit'` is the record. Present so a flatten whose
   * Verdict said `no_go` is still visible as a flatten that FIRED — the
   * anomaly reads as `flatten_fired: true, final_stage: 'verdict'`.
   */
  flatten_fired?: boolean;
  /**
   * `true` when a TICK-PATH pass's exit check produced an INDICATOR-BASED
   * EARLY EXIT (#748) — the momentum axis no longer supports the held side, at
   * a price that touched neither bracket.
   *
   * Its own flag rather than a widened `flatten_fired`, and mutually exclusive
   * with it: the two are different events with different causes (time versus
   * signal), and a soak that cannot tell them apart cannot tell a session
   * ending from a thesis dying. Present for exactly the reason `flatten_fired`
   * is — a release whose Verdict said `no_go` must stay visible as a release
   * that FIRED (`early_exit_fired: true, final_stage: 'verdict'`) rather than
   * reading as a healthy no-trade tick.
   */
  early_exit_fired?: boolean;
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
  /**
   * The tick path's position-facing exit check (#743): the Trader's exit-only
   * entry point, run on every tick that is NOT a decision pass. Reachable
   * WITHOUT an `AnalystView[]` or a `DebateResult` by construction — its
   * input carries neither — which is the "exits must not read analyst
   * output" constraint stated as an interface requirement
   * (orchestrator-spec.md, "The tick/decision split", constraint 4).
   *
   * `bar` is the tick's debate-bar coordinate (the runner floors it once per
   * tick pass): the grid the exit intent's idempotency key dedupes on, so
   * repeated flatten checks within one bar re-key to the same order.
   *
   * Returns the flatten exit intent when one is due, else null. A non-null
   * intent flows through the same Risk → Verdict → Execution tail as a
   * decision-path intent.
   */
  exitCheck(input: {
    trace_id: string;
    instrument: string;
    bar: Date;
    clock: Clock;
  }): Promise<OrderIntent | null>;
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
    /**
     * The decision bar's opening boundary, passed down from
     * `TickContext.decision_bar` (#743). The step keys `debate_id` and the
     * row's `bar_timestamp` on THIS value rather than flooring its own
     * `clock.now()` — a debate that straddles a bar boundary (LLM round
     * trips, retries) stays keyed to the bar the gate opened, and the Trader
     * inherits the same value via `DebateResult.bar_timestamp` (#687). One
     * derivation per pass, at the gate; everything below receives it.
     */
    bar: Date;
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
