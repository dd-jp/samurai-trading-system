/**
 * Orchestrator domain types & seams (ticket #94).
 * See docs/specs/orchestrator-spec.md (Module: Scheduler, Module: Tick Runner).
 *
 * Scope: #94 is pure wiring — scheduling, the sequential stage chain, and
 * bounded concurrency. It owns no stage logic.
 *
 * Deliberately NOT here: `Logger`, `AuditLog`, and the `audit_log` /
 * `current_tick` tables. The spec's `TickContext` sketch lists a logger and
 * an audit writer, but those are #95's acceptance surface, and no stage input
 * in this repo accepts a logger — threading one through now would build #95
 * early. #94 generates the `trace_id` and passes it on each stage input's
 * mandatory `trace_id` field, which is all the chain mechanically needs.
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

/** The stage a tick reached before terminating (successfully or by short-circuit). */
export type TickStage = 'analysts' | 'debate' | 'trader' | 'risk' | 'verdict' | 'execution';

export interface TickContext {
  /** Wall-clock live; the harness's simulated clock in replay. */
  clock: Clock;
  /** Generated at Signal emission, threaded through every stage call in this pass. */
  trace_id: string;
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
 * inconsistent about how they take dependencies (`ExecutionImpl` takes them
 * via constructor, `Verdict` takes everything through `VerdictInput`, `Risk`
 * splits config/constructor from per-call input), and each needs ancillary
 * deps the tick chain never touches (marketData, portfolio, breakers, equity,
 * approvals, positionStore, broker, costModel). Closing those over at
 * composition time keeps this module to sequencing — orchestrator-spec.md's
 * "assert wiring, not stage logic" — and keeps the short-circuit test to
 * faking six functions.
 *
 * `analysts` and `debate` have no implementation to bind yet: the multi-persona
 * fan-out/quorum is #71/#72 (#70 shipped a single `technicalAnalyst`) and the
 * Debate Engine's core is unimplemented under epic #40. The other four bind to
 * `Trader.decide`, `RiskManager.evaluate`, `Verdict.decide`, `Execution.execute`.
 */
export interface TickSteps {
  /**
   * The `AnalystView[]` the Debate Engine consumes. An empty array means the
   * tick is skipped — analysts-spec.md story 21: a mandatory analyst failing
   * after retry skips the whole tick. The quorum rule itself is #71's; this
   * chain only honours the skip.
   */
  analysts(input: { trace_id: string; signal: Signal; clock: Clock }): Promise<AnalystView[]>;
  /**
   * No `bar` is passed in. `debate_id` = hash(instrument + bar + AnalystView
   * set), but `bar` must be the decision bar's coordinate (the mark's
   * `observed_at`) and never `clock.now()` — see computeIdempotencyKey's
   * contract in src/trader/idempotency-key.ts. The Trader derives it from its
   * own MarketDataService (`decisionBar = mark.observed_at`); the Debate
   * Engine derives it the same way from the market data closed over at
   * composition. The Orchestrator has no business inventing that coordinate.
   */
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
  /**
   * `RiskManager.evaluate` is synchronous, but building its `PortfolioView`
   * input is not (`computePortfolioView` marks to market via the MDS), so the
   * bound step is async.
   */
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
