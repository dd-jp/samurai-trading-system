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
 * The debate bar a decision pass runs for — THE single source of the bar
 * coordinate, produced once by the decision gate and passed down so nothing
 * else floors its own `clock.now()` for it.
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
 * The disposable per-instrument progress row. Not a system-of-record: losing
 * it on crash costs nothing but a stale indicator, since it's re-upserted
 * next tick.
 */
export interface CurrentTick {
  instrument: string;
  asset_class: AssetClass;
  stage: TickStage;
  trace_id: string;
  updated_at: Date;
}

/**
 * One row per instrument: `upsert` overwrites any existing row (a stale row
 * from a crashed prior tick is safely clobbered), `delete` clears it on
 * completion.
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
   * Present => runner runs the DECISION path for this bar. Absent => tick
   * path only (position-facing exit check). Claimed from `DecisionGate` by
   * the tick loop BEFORE `runInstrument`, so a crashed pass can be rescinded
   * for the next tick to retry.
   */
  decision_bar?: DecisionBar;
  /**
   * Turnstile serializing the portfolio-facing tail (Trader onward) across
   * concurrently-fanned-out instruments — `RiskManager.evaluate()` reads a
   * pre-trade snapshot, so two instruments evaluating at once could each pass
   * the gross cap and breach it combined. Granted in PLAN index order (not
   * head-completion order) so cap allocation stays reproducible under replay.
   * Absent for callers already serial by construction (backtest harness,
   * smoke run, control arm, unit tests); idempotent per pass.
   */
  beginPortfolioTail?: () => Promise<void>;
}

export interface TickOutcome {
  trace_id: string;
  /**
   * Absent only when `error` is set — a pass that threw never reached a
   * `return`, so there's no stage to report. Left absent rather than
   * fabricated (e.g. defaulting to the first stage), which would misrepresent
   * where the pipeline died.
   */
  final_stage?: TickStage;
  verdict_status?: 'go' | 'no_go';
  /** Only present on a Verdict `go` — Execution is not called otherwise */
  execution_result?: ExecutionResult;
  /**
   * `true` on a tick-path flatten intent. Never set on a decision pass (the
   * Trader's own `intent_type: 'exit'` is the record there). Present so a
   * flatten whose Verdict said `no_go` still reads as fired, not as no-trade.
   */
  flatten_fired?: boolean;
  /**
   * `true` on a tick-path indicator-based early exit — its own flag rather
   * than a widened `flatten_fired`, since the two have different causes (time
   * vs. signal) and must stay distinguishable.
   */
  early_exit_fired?: boolean;
  /**
   * Set only when the pass threw instead of returning. Caught in
   * tick-loop.ts's worker, never in `runInstrument` itself (a crash must
   * leave `current_tick` stale for the next tick to clobber, not be
   * swallowed). Presence IS the failure signal; the other fields stay absent.
   */
  error?: string;
}

/**
 * The six pipeline steps as bound callables — the TickRunner's only
 * dependency, and the primary test seam (fake six functions, not six stages).
 * `analysts`/`debate` bind through a thin adapter since
 * `AnalystOrchestrator.runAnalysts`/`runDebate` don't match this shape 1:1.
 */
export interface TickSteps {
  /**
   * The tick path's position-facing exit check, run on every tick that is
   * NOT a decision pass. Takes no `AnalystView[]`/`DebateResult` by
   * construction — the "exits must not read analyst output" constraint,
   * stated as an interface shape. `bar` is the grid the exit intent's
   * idempotency key dedupes on.
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
     * Passed down from `TickContext.decision_bar`, the SAME derivation
     * `debate`'s `bar` field below carries — never a second
     * `floorToBar(clock.now())` taken here or inside an analyst.
     */
    bar: Date;
  }): Promise<AnalystView[]>;
  /**
   * Why the preceding `analysts` call produced no views, read once when the
   * view set is empty. Optional — only the production adapter can answer it;
   * absent means the runner records the undifferentiated `quorum_skip`.
   */
  analystSkipKind?(trace_id: string): AnalystSkipKind | undefined;
  debate(input: {
    trace_id: string;
    instrument: string;
    /**
     * Forwarded from the tick's `Signal`, not re-resolved from a universe map
     * inside the adapter — a second lookup keyed on instrument name is a
     * place for the two to disagree. Feeds `debate-adapter.ts`'s
     * per-asset-class rate limits, latency budget and round cap.
     */
    asset_class: AssetClass;
    views: AnalystView[];
    clock: Clock;
    /**
     * Passed down from `TickContext.decision_bar`; keys `debate_id` and
     * `bar_timestamp` on this value rather than flooring a fresh
     * `clock.now()`, so a debate straddling a bar boundary stays keyed to the
     * bar the gate opened.
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
  /** Called only on a Verdict `go`. */
  execution(verdict: VerdictDecision): Promise<ExecutionResult>;
  /**
   * Falsifier arm 2 (ADR-0014's mandated matched control), invoked on EVERY
   * pass through `runInstrument` so it's structural rather than a
   * separately-scheduled job that could start late. Optional because a
   * required member would break every replay/fixture-driven `TickSteps`
   * construction, which has no soak to control for; wiring is asserted at the
   * composition root instead. Never rejects — a failure in the measurement
   * must not take down the arm that trades the book.
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
