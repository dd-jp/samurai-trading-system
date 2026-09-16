/** Orchestrator domain types & seams. */
import type { Signal } from '../../pipeline/analysts/index.js';
import type { AnalystView, DebateResult } from '../../pipeline/debate-engine/index.js';
import type { ExecutionResult } from '../../pipeline/execution/index.js';
import type { RiskDecision } from '../../pipeline/risk-manager/index.js';
import type { VerdictDecision } from '../../pipeline/verdict/index.js';
import type { AssetClass, Clock, InstrumentSubclass, OrderIntent } from '../../shared/index.js';
import type { AnalystSkipKind } from './analysts-decision.js';

export type { AssetClass, InstrumentSubclass };

/** One entry in the configured universe (orchestrator-spec.md story 3) */
export interface UniverseInstrument {
  asset: string;
  asset_class: AssetClass;
  /**
   * ADR-0018's pricing dimension. Optional because most existing profiles
   * predate it; `perSubclassDeploymentCap` throws for an intent whose own
   * instrument is unclassified rather than sizing it with no envelope.
   */
  subclass?: InstrumentSubclass;
}

/**
 * The ONE derivation of instrument -> subclass; lives here (not
 * `paper-profile.ts`) to avoid a `production.ts` <-> `paper-profile.ts`
 * import cycle. Callers must share this map, not rebuild their own — three
 * independently built maps is three places to classify an instrument differently.
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

/** What fires this tick, decided by the Scheduler against the injected clock */
export interface TickPlan {
  instruments: UniverseInstrument[];
  /** = clock.now() */
  tick_time: Date;
  /**
   * True only when admitted via `postCloseFlattenWindow` (venue otherwise
   * shut). `runTickPlan` must not claim a decision bar for such a tick — the
   * only possible outcome past close is `skip('session_closing')`.
   */
  grace_only?: boolean;
}

/** The Scheduler seam: given a clock and a universe, decide what fires */
export interface Scheduler {
  nextTick(clock: Clock): TickPlan;
}

import type { LogEntry, Logger } from '../../shared/index.js';

// `LogEntry` re-exported alongside `Logger`: it is the argument type of
// `Logger.log`, so a fake logger built against this module needs both.
export type { LogEntry, Logger };

/** shared_store.audit_log writer (#95) */
export interface AuditLog {
  record(entry: {
    trace_id: string;
    stage: string;
    decision: string;
    input_digest: string;
    output_digest: string;
    timestamp: Date;
    /** Absent means "not attributable", never "no instrument". */
    instrument?: string;
    asset_class?: AssetClass;
  }): void;
}

/**
 * The stage a pass reached before terminating. `'position_check'` is the
 * tick path's own stage (the exit check that runs on most ticks instead of
 * the decision chain) — kept distinguishable from a decision pass that
 * declined to trade, or a healthy exit-only tick reads as a no-trade one.
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
  /** Stable identity for logs: `<open_time ISO>@<timeframe_ms>` */
  id: string;
  /** The bar's opening boundary — `floorToBar(tick_time, timeframe_ms)` */
  open_time: Date;
  /** The debate-bar grid this bar lives on (`DEBATE_BAR_TIMEFRAME_MS`) */
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
  /** Wall-clock live; the harness's simulated clock in replay */
  clock: Clock;
  /** Generated at Signal emission, threaded through every stage call in this pass */
  trace_id: string;
  /** Shared structured-logging interface (#95); every stage call logs through it */
  logger: Logger;
  /** shared_store.audit_log writer (#95); one record per stage reached in this pass */
  auditLog: AuditLog;
  /** shared_store.current_tick writer (#96); upserted before each stage, deleted on completion */
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
  /**
   * The phase split's turnstile (#1040). Awaited by the runner immediately
   * before the pass's FIRST PORTFOLIO READ, and resolved by the tick loop when
   * it is this instrument's turn, in PLAN order.
   *
   * ## What it separates
   *
   * A pass has a portfolio-free head and a portfolio-facing tail, and the
   * boundary sits at the first read of book state — which is NOT the same
   * point on the two paths:
   *
   *   decision path — head is Analysts + Debate (neither step's input carries
   *                   portfolio state, and neither stage references it); the
   *                   tail opens at Trader, which sizes against equity, and
   *                   runs Trader -> Risk -> Verdict -> Execution.
   *   tick path     — the exit check is head too: it skips `snapshotForTick`
   *                   deliberately, because an exit sizes to the held quantity
   *                   and never to equity (#743). The tail opens only once the
   *                   check has produced an intent bound for Risk, so the ~29
   *                   of 30 passes that produce none never take a turn at all.
   *
   * Heads may safely overlap across instruments; tails may not.
   *
   * `RiskManager.evaluate()` reads a portfolio SNAPSHOT — `gross_exposure`,
   * `exposure_by_class`, `drawdown_pct`. Two instruments evaluating
   * concurrently each read PRE-TRADE exposure, each pass the gross cap, and
   * the book breaches it combined (#1019). That race is live today: #1013 set
   * `maxConcurrentInstruments: 6` for paper and live, so whole pipelines
   * already overlap. This field is what makes the tail serial again while the
   * expensive head stays fanned out.
   *
   * ## Why a turnstile rather than a lock
   *
   * Turns are granted in PLAN index order, never in head-completion order.
   * ADR-0003 §2's replay-from-log needs a backtest to reproduce a live run; if
   * phase-1 completion order leaked into tail sequencing, cap allocation would
   * vary run to run. A mutex would grant in arrival order and lose exactly
   * that. So phase 1's scheduling is not observable downstream.
   *
   * ## Optional, and absent means "run now"
   *
   * Absent for every caller that is already serial by construction: the
   * backtest harness's bar loop, the smoke run, the control arm's own runner
   * (which builds its own context), and the direct-construction unit tests. A
   * caller with one pass in flight has no siblings to order against, so an
   * un-awaited tail there IS the serial tail. `runTickPlan` always supplies it
   * — including at `max_concurrent_instruments: 1`, where every turn is
   * already free when it is asked for and the await is inert.
   *
   * Idempotent per pass: a second call after the turn is granted resolves
   * immediately, so an added call site cannot deadlock a pass against itself.
   */
  beginPortfolioTail?: () => Promise<void>;
}

export interface TickOutcome {
  trace_id: string;
  /**
   * Absent only when `error` is set (#507). `SequentialTickRunner.runInstrument`
   * always resolves to one of the seven `TickStage` names above — but a pass that
   * THREW never reached a `return`, so tick-loop.ts's per-worker catch has no
   * stage to report. Fabricating one (e.g. defaulting to the first stage)
   * would misrepresent where the pipeline actually died; an absent field is
   * the honest record, not a fabricated one — same posture production.ts's
   * doc comment takes on injected seams ("an honest injected seam beats a
   * fabricated implementation").
   */
  final_stage?: TickStage;
  verdict_status?: 'go' | 'no_go';
  /** Only present on a Verdict `go` — Execution is not called otherwise */
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
  analysts(input: {
    trace_id: string;
    signal: Signal;
    clock: Clock;
    /**
     * The decision bar's opening boundary, passed down from
     * `TickContext.decision_bar` (#811) — the same value `debate`'s `bar`
     * field below carries, and the SAME derivation (the gate's `claim`, not a
     * second `floorToBar(clock.now())` taken here or inside an analyst).
     * `AnalystOrchestrator.runAnalysts` threads it onto every `AnalystInput`
     * unchanged, and `MarketIntelligenceStore.getContext` floors its window to
     * it rather than to a fresh clock read — closing the residual #782 left
     * (a pass straddling the bar boundary floored MI to a different bar than
     * the debate it fed).
     */
    bar: Date;
  }): Promise<AnalystView[]>;
  /**
   * Why the pass just handed to `analysts` produced no views (#1080), read
   * once, immediately after that call, and only when the view set is empty.
   *
   * Optional because only the production adapter can answer it:
   * `AnalystOrchestrator` returns its failures, `TickSteps.analysts` narrows
   * them away, and this is the seam that carries the one bit back. Absent
   * means the runner records the undifferentiated `quorum_skip` it always did
   * — see `analystsSkipDecisionWord` for why that is the honest fallback for
   * the control arm and the backtest rather than a hole.
   */
  analystSkipKind?(trace_id: string): AnalystSkipKind | undefined;
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
  /** null = skip / no-trade; short-circuits before Risk */
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
  /** Called only on a Verdict `go` (orchestrator-spec.md story 7) */
  execution(verdict: VerdictDecision): Promise<ExecutionResult>;
  /**
   * Falsifier arm 2, run in parallel with this pass (#753) — the mandated
   * matched control from ADR-0014 amendment 2 and ADR-0017 §Consequences.
   *
   * Invoked on EVERY pass through `runInstrument`, both cadences: on a decision
   * pass with the live arm's own `AnalystView[]` (so the control decides from
   * the same views on the same bar), and on a tick pass with none (so the
   * control runs its own position-facing exit check and its lots reach
   * ADR-0014's mandatory flat-by-close). "In parallel from the first soak day"
   * is the ticket's ordering constraint, and calling this from the one method
   * every real tick goes through is what makes it structural rather than a
   * separately scheduled job that could be started late.
   *
   * **Optional, and this is the one place in the file where optional is not the
   * lesser choice.** A required member would break every existing `TickSteps`
   * construction — the backtest replay driver, the smoke run, and several
   * hundred tests — to express something none of them measure: a replayed or
   * fixture-driven pass has no soak to control for. The risk that optionality
   * usually carries here (this repo's dominant defect: a tested mechanism
   * nothing calls) is closed where it belongs, at the composition root, by a
   * test that drives the real `buildProductionComponents(...)` and asserts the
   * member is bound — the same remedy #752's counter-unwired mutation uses.
   *
   * Resolves when the control pass has finished or has been contained. It never
   * rejects: a failure in the measurement must not take down the arm that
   * trades the book, and the containment lives in the implementation rather than
   * in the runner, whose lack of a try/catch is a deliberate invariant.
   */
  controlArm?(input: {
    signal: Signal;
    ctx: TickContext;
    views?: readonly AnalystView[];
  }): Promise<void>;
}

/** The Tick Runner seam. One call per instrument per tick. */
export interface TickRunner {
  runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome>;
}
