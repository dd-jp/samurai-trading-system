/**
 * Domain types & contracts for the Debate Engine (Stage 2).
 * See docs/specs/debate-engine-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md (registry entries #1 trace_id, #2 DebateResult).
 * Implementation ticket #24 — no runtime validation here, structural contracts only.
 */

/**
 * Directional signal shared by AnalystView and the debate-engine outputs derived
 * from it. A structured union (not free text) so downstream consumers — notably
 * the mechanical Trader — can map straight to order side without parsing prose.
 *
 * Declared in `contracts/primitives.ts` and re-exported here: `DebateRow` puts
 * each analyst's stance on the wire, so the browser needs this union and must
 * not import the debate engine to get it.
 */
export type { Direction } from '../../../contracts/index.js';

// Also imported, not just re-exported: `export … from` publishes the name
// without binding it locally, and the interfaces below annotate with it
import type { Direction } from '../../../contracts/index.js';
import type { DebateTerminationCause } from '../../shared/index.js';

/**
 * Upstream contract: what every Analyst must provide. This IS the Debate
 * Engine's primary input type — there is no separate wrapping envelope, the
 * engine consumes AnalystView[] directly. Defined identically in
 * analysts-spec.md; the two copies are kept in lockstep (cross-spec-contracts.md GAP-J).
 */
export interface AnalystView {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data */
  trace_id: string;
  /** Unique identifier for the analyst instance that produced this view */
  analyst_id: string;
  /** Analyst persona/lens, e.g. "technical", "fundamental", "sentiment". */
  analyst_type: string;
  /** Directional read on the instrument */
  direction: Direction;
  /** Confidence in this view, 0.0-1.0 */
  confidence: number;
  /** Supporting evidence as free text; role-specific detail lives here, not in typed fields */
  key_points: string[];
  /** When this view was produced */
  timestamp: Date;
}

/**
 * Per-analyst breakdown of how a debate unfolded, tracked so the Feedback Loop
 * can later adjust analyst weights based on influence and accuracy
 */
export interface AnalystContribution {
  /** Identifies which analyst instance this contribution belongs to */
  analyst_id: string;
  /** Analyst persona/lens, matching the originating AnalystView */
  analyst_type: string;
  /** This analyst's directional stance at the end of each debate round, in round order */
  stance_during_debate: Direction[];
  /** This analyst's directional stance by the end of the debate */
  final_position: Direction;
  /** Free-text summary of this analyst's reasoning during the debate */
  rationale: string;
  /** How much this analyst shifted the debate's outcome */
  influence_score: number;
}

/**
 * One round's mediator verdict — the datum #1517's flip-rate measurement
 * needs (does the final round's direction differ from round 1's) that no
 * existing field carries: `DebateResult.direction`/`confidence` are the
 * FINAL round only, and `contributions[].stance_during_debate` is each
 * ANALYST's upstream stance, not the mediator's own synthesis
 */
export interface RoundVerdict {
  /** 1-indexed, matching `RoundContext.round` */
  round: number;
  direction: Direction;
  confidence: number;
}

/**
 * Downstream contract: what the Trader receives. A compact payload — not a
 * full transcript — with enough context to consolidate analyst views into an
 * action without drowning in argumentation.
 */
export interface DebateResult {
  /** Coherent position statement synthesized by the mediator */
  synthesis: string;
  /** Actionable recommendation in prose */
  position: string;
  /** Conviction score (hybrid of disagreement inverse + evidence strength), 0.0-1.0 */
  confidence: number;
  /** Per-analyst breakdown of stance, rationale, and influence */
  contributions: AnalystContribution[];
  /** Free-text description of what disagreements remain */
  disagreement_summary: string;
  /** Unresolved disagreements; empty if converged */
  open_items: string[];
  /** True if the mediator signaled convergence before the hard round cap */
  converged: boolean;
  /** Actual number of debate rounds run (max 3) */
  rounds_completed: number;
  /** Actual wall-clock time the debate took, in milliseconds */
  latency_ms: number;
  /**
   * Structured directional signal, distinct from the free-text `position`.
   * The mechanical Trader maps this straight to order side and cannot parse
   * prose. Added per cross-spec-contracts.md registry #2.
   */
  direction: Direction;
  /**
   * Deterministic = hash(instrument + bar + AnalystView set), stable across
   * the no-persistence re-run-from-scratch (decision #10). Load-bearing join
   * key for Trader/Verdict provenance, the setup store, and the Feedback
   * Loop's debate-log attribution join. Added per cross-spec-contracts.md
   * registry #1/#2.
   */
  debate_id: string;
  /**
   * The BAR COORDINATE this debate belongs to — the same floored `Date` that
   * went into `debate_id`'s hash, and the row's `bar_timestamp` in
   * `debate_log`.
   *
   * ## Why it is on the Trader-facing contract (#687)
   *
   * It used not to be, on the reasoning that `DebateResult` is the Trader's
   * input and not the log record — `buildDebateLog` took `instrument`/
   * `bar_timestamp` from the caller instead. The consequence was that the
   * Trader had to RE-DERIVE the coordinate, by flooring a SECOND, later
   * `clock.now()` of its own (`decisionBarFor`, now deleted). Two clock reads
   * agree only while both land in the same bar, and a debate that straddles an
   * hour boundary — LLM round-trips, retries, a latency-budget timeout — is
   * logged at bar N while its intent is keyed to bar N+1. Bar N+1's own
   * genuine decision then computes the key the straddling intent already took
   * and is suppressed as a duplicate.
   *
   * So the bar is carried FORWARD from the one place that floors a clock read
   * (`buildDebateStep`) rather than re-derived downstream. There is now exactly
   * one bar coordinate per debate, and `decide.ts` imports neither `floorToBar`
   * nor `DEBATE_BAR_TIMEFRAME_MS` — re-deriving it would take a new import.
   *
   * REQUIRED, not optional. Every producer of a `DebateResult` — the round
   * orchestrator, the latency budget's two timeout shapes, the rate-limit and
   * spend-cap refusals, the replay-from-log shape — is a compile error until it
   * says which bar it is speaking for. An optional field would let a producer
   * omit it and hand the Trader an `undefined` to fall back from, which is the
   * re-derivation this closes.
   */
  bar_timestamp: Date;
  /**
   * REQUIRED, not optional — the same enforcement `bar_timestamp` above
   * uses (#687): an optional flag lets a producer omit it and hand the
   * Trader a silent default.
   *
   * The operative rule is BROADER than "a debate happened": `true` covers
   * every result some accountable process produced — a converged or
   * round-capped debate, a `timed_out` partial with a real synthesis from
   * a round that finished, a `rate_limited` refusal, a deterministic
   * axis-vote read (control arm, no LLM debate involved), the control
   * arm's own no-axis-vote decline (a genuine falsifier decision, not a
   * blank), or a replay of a persisted debate. `false` is reserved for a
   * future fallback that hands back a neutral scaffold for a reason NONE
   * of the above account for — `timed_out` and `rate_limited` both
   * undefined, and no other recognized producer path ran. That is the
   * #1393 case this field exists to name; a producer that read the name
   * narrowly, as "was there literally an LLM debate", would wrongly set
   * `false` on the axis-vote and no-axis-vote control-arm paths and flip
   * their classification from `declined_on_signal` to `could_not_decide`
   * — exactly the misclassification #1393 exists to prevent, just aimed
   * at the wrong two paths.
   *
   * Named `read` for that broad sense — "something accountable happened
   * here, not nothing" — not the narrow "an LLM debate ran" sense a literal
   * reading suggests. Renaming would touch every producer and consumer site
   * for no behavioural gain; stating the actual rule here does the same job
   * without the churn.
   *
   * `timed_out` and `rate_limited` discriminate the two read failures this
   * contract names today, but neither is universal: a future fallback
   * producing a neutral result for some OTHER reason would set neither,
   * and `debateWasDegraded` (trader/decide.ts) would read it as a genuine
   * decline — logging `declined_on_signal`, the word that means the debate
   * was read and passed, when nothing was read. `debateWasDegraded` checks
   * `!read` alongside the two flags (order doesn't matter in a boolean OR);
   * the orchestrator's `debateDecisionWord` (#1080) checks it last, after
   * both — so the two stay in agreement about the same result regardless
   * of check order.
   *
   * No production producer sets this to `false` yet: every current path
   * sets `true`, because every one of them either ran a real debate,
   * replays one that ran, read something deterministic in place of a
   * debate, or already carries its own `timed_out`/`rate_limited` flag.
   * This field has a reader now and no writer; behaviour is unchanged
   * until a fallback exists to set it `false`.
   *
   * Setting `false` here is not, on its own, the whole job (#1418):
   * `debate_log` has no column for this field, so `buildDebateLog` cannot
   * write it and `replayedDebateResult` cannot read it back — a persisted
   * `read: false` row would replay as `true`, undoing this classification
   * on the very next #617 replay of the same bar. A producer that persists
   * `read: false` results must close that gap first.
   */
  read: boolean;
  /**
   * Present only when the debate was force-terminated by the latency budget
   * (docs/specs/debate-engine-spec.md "Module: Latency Budget", ticket #33).
   * Absent on a normal (converged or round-cap) completion.
   */
  timed_out?: {
    /** The asset-class budget that was exceeded, in milliseconds */
    budget_ms: number;
    /** Actual elapsed wall-clock time when termination fired, in milliseconds */
    elapsed_ms: number;
    /**
     * What actually stopped the debate (#1380) — optional because the only
     * real producer, `enforceLatencyBudget`, always sets it and every other
     * `timed_out` object in this codebase is a test fixture predating the
     * distinction. `'budget'`: the asset-class timer fired with the debate
     * still in flight. `'llm_failure'`: an `LlmClient` call failed outright
     * (its retries exhausted or its failure non-retryable) and arrived before
     * the timer did — a provider/client fault, not evidence the budget itself
     * is too tight. `debateDecisionWord` and `buildDebateLog` read only
     * `budget_ms`/`elapsed_ms` and are unchanged by this field's presence, so
     * both causes keep writing the identical `DEGRADED_DECISIONS` word and
     * `termination` value; `cause` is carried separately into
     * `debate_log.termination_cause`, which is what lets a budget-tuning
     * measurement exclude LLM-failure rows with one predicate instead of
     * folding them into "the budget is too tight".
     */
    cause?: DebateTerminationCause;
  };
  /**
   * Present only when `RateLimiter` refused to admit the debate at all (#388)
   * — no round ran and no LLM call was made. Absent on every debate that
   * actually started, including one the latency budget later cut short.
   *
   * A sibling of `timed_out` rather than a variant of it, because the two are
   * genuinely different events with different remedies: `timed_out` means the
   * provider was slow, this means we chose not to spend. Distinguishable
   * downstream matters — a soak whose debates are mostly `rate_limited` is
   * mis-configured, whereas one whose debates mostly `timed_out` has a
   * provider problem.
   */
  rate_limited?: {
    /** `ReserveResult`'s own refusal text: which budget was exhausted, and by how much */
    reason: string;
  };
  /**
   * Every round's mediator verdict, in round order (#1517). Set by
   * `runDebate` (a full round-orchestrator loop) and by
   * `enforceLatencyBudget`'s timeout branch (whatever rounds completed
   * before the budget fired, `[]` on its no-partial-state fallback) —
   * always an array, never a partial one, on those two paths. Absent on
   * every other producer (the rate-limit refusal, the control arm's
   * axis-vote decisions, the replay-from-log shape): they have no round to
   * report and predate this field, matching `timed_out?`/`rate_limited?`'s
   * own sibling-optional-field convention rather than forcing every
   * producer to invent a value. This is an ANALYTICS addition, like
   * `debate_log` itself — it does not change decision #10 (round-by-round
   * OPERATIONAL state is still not persisted for crash-recovery; a crashed
   * debate still re-runs from scratch).
   */
  round_verdicts?: RoundVerdict[];
}
