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
 */
export type Direction = 'bullish' | 'bearish' | 'neutral';

/**
 * Upstream contract: what every Analyst must provide. This IS the Debate
 * Engine's primary input type — there is no separate wrapping envelope, the
 * engine consumes AnalystView[] directly. Defined identically in
 * analysts-spec.md; the two copies are kept in lockstep (cross-spec-contracts.md GAP-J).
 */
export interface AnalystView {
  /** Cross-cutting correlation ID threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  /** Unique identifier for the analyst instance that produced this view. */
  analyst_id: string;
  /** Analyst persona/lens, e.g. "technical", "fundamental", "sentiment". */
  analyst_type: string;
  /** Directional read on the instrument. */
  direction: Direction;
  /** Confidence in this view, 0.0-1.0. */
  confidence: number;
  /** Supporting evidence as free text; role-specific detail lives here, not in typed fields. */
  key_points: string[];
  /** When this view was produced. */
  timestamp: Date;
}

/**
 * Per-analyst breakdown of how a debate unfolded, tracked so the Feedback Loop
 * can later adjust analyst weights based on influence and accuracy.
 */
export interface AnalystContribution {
  /** Identifies which analyst instance this contribution belongs to. */
  analyst_id: string;
  /** Analyst persona/lens, matching the originating AnalystView. */
  analyst_type: string;
  /** This analyst's directional stance at the end of each debate round, in round order. */
  stance_during_debate: Direction[];
  /** This analyst's directional stance by the end of the debate. */
  final_position: Direction;
  /** Free-text summary of this analyst's reasoning during the debate. */
  rationale: string;
  /** How much this analyst shifted the debate's outcome. */
  influence_score: number;
}

/**
 * Downstream contract: what the Trader receives. A compact payload — not a
 * full transcript — with enough context to consolidate analyst views into an
 * action without drowning in argumentation.
 */
export interface DebateResult {
  /** Coherent position statement synthesized by the mediator. */
  synthesis: string;
  /** Actionable recommendation in prose. */
  position: string;
  /** Conviction score (hybrid of disagreement inverse + evidence strength), 0.0-1.0. */
  confidence: number;
  /** Per-analyst breakdown of stance, rationale, and influence. */
  contributions: AnalystContribution[];
  /** Free-text description of what disagreements remain. */
  disagreement_summary: string;
  /** Unresolved disagreements; empty if converged. */
  open_items: string[];
  /** True if the mediator signaled convergence before the hard round cap. */
  converged: boolean;
  /** Actual number of debate rounds run (max 3). */
  rounds_completed: number;
  /** Actual wall-clock time the debate took, in milliseconds. */
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
}
