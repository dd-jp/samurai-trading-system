/**
 * Domain types for the Feedback Loop (Stage 6) daily batch cycle — ticket #91.
 * See docs/specs/feedback-loop-spec.md ("Key Interfaces", "Module: Weight
 * Attribution", "Module: Guardrailed Tuning").
 *
 * Scope note: #91 is `runDailyCycle` only. `onTradeClose` (setup-store
 * R-labelling, #92) and `computeMetrics` (metrics + revalidation, #93) are
 * separate tickets and are deliberately absent here rather than stubbed —
 * the repo populates its interfaces ticket-by-ticket.
 */
import type { Clock } from '../shared/clock.js';
import type { ClosedTradeStore, DebateLogStore, TuningStore } from '../shared/types.js';

/**
 * A human-set bound on one tunable dial. Every dial has all four: the spec's
 * guardrail is "bounded step per cycle, inside hard floors/ceilings", so a
 * dial without both a step cap and a hard band is not expressible.
 */
export interface TunableDial {
  /** Max absolute change one cycle may apply. The cap in acceptance criterion #4. */
  max_step: number;
  /** Hard floor — a weight never reaches 0 permanently, a threshold never vanishes. */
  floor: number;
  /** Hard ceiling — no dial runs away or dominates. */
  ceiling: number;
  /**
   * Which direction of change makes this dial SAFER. FL cannot infer it:
   * for `max_position_size` tightening means decreasing, for
   * `min_viable_size` it means increasing.
   *
   * For a RISK THRESHOLD this is the gate — moving against it requires human
   * approval (feedback-loop-spec.md story 7). For a STRATEGY PARAM it is
   * descriptive only: it labels the emitted `param_updates[].direction`,
   * which the spec's `DailyCycleResult` requires on every entry, but strategy
   * params tune freely within bounds and are never gated.
   */
  tighten_is: 'increase' | 'decrease';
}

export interface FeedbackConfig {
  /**
   * How far back from `clock.now()` the cycle attributes trades. Combined
   * with the store's half-open window this is what keeps a daily cycle
   * point-in-time: only outcomes known before T are ever read.
   */
  attribution_window_ms: number;
  /** Step cap + hard band applied to EVERY analyst weight. */
  weights: TunableDial;
  /**
   * Credit multiplier for a right-but-low-influence analyst, as a fraction of
   * the influence-weighted credit (spec story 3 — "small"). Lets a quietly
   * correct analyst climb back instead of being pinned by its own low
   * influence.
   */
  shadow_credit: number;
  /** `influence_score` at or below which an analyst counts as low-influence for shadow credit. */
  shadow_influence_ceiling: number;
  /** Per strategy-param bounds, keyed by param name. Tuned freely inside them. */
  strategy_params: Record<string, TunableDial>;
  /** Per risk-threshold bounds, keyed by threshold name. Loosening is gated. */
  risk_thresholds: Record<string, TunableDial>;
}

/**
 * A requested move on one strategy param or risk threshold, fed into the
 * cycle's guardrail routing.
 *
 * The spec assigns FL the *authority* to tune params/thresholds but does not
 * define the signal that proposes a target — the one producer it does name,
 * defensive auto-tightening on a kill-threshold breach, belongs to #93. So
 * #91 implements the bounded, guardrailed APPLICATION path and takes the
 * proposal as an input rather than inventing a tuning heuristic the spec
 * does not describe. Analyst weights need no proposal: attribution computes
 * their target.
 */
export interface TuningProposal {
  kind: 'strategy_param' | 'risk_threshold';
  name: string;
  /** Where the proposer wants the dial; the cycle moves at most `max_step` toward it. */
  target: number;
}

/**
 * Approval seam for gated risk-threshold loosening.
 *
 * Deliberately NOT Verdict's `ApprovalChannel` (src/verdict/types.ts): that
 * port's `ApprovalRequest` is order-shaped (`order_intent`, `risk_decision`)
 * and cannot describe a threshold move. Same trade channel, different
 * request shape.
 *
 * Fire-and-forget by design: `runDailyCycle` is synchronous per the spec, so
 * a loosening is queued into `loosen_pending_approval` and never applied by
 * the cycle that proposed it. Acting on the human's answer is a later
 * cycle's job (or a later ticket's) — the loop can never relax its own
 * safety limits unsupervised.
 */
export interface LoosenApprovalChannel {
  requestLoosenApproval(request: LoosenApprovalRequest): void;
}

export interface LoosenApprovalRequest {
  /** Risk-threshold name, as keyed in `FeedbackConfig.risk_thresholds`. */
  name: string;
  from: number;
  /** The bounded value that WOULD be written if a human approves — not the raw target. */
  to: number;
  requested_at: Date;
}

/**
 * One dial move, appended on write. This record IS the reversibility the
 * spec asks for (story 8): `from` is the pre-cycle value, so an operator can
 * roll a bad cycle back by replaying the log backwards. No rollback engine
 * is built here — #91 provides the audit trail, not the undo command.
 */
export interface Adjustment {
  dial: 'analyst_weight' | 'strategy_param' | 'risk_threshold';
  /** `analyst_id` for a weight, otherwise the param/threshold name. */
  name: string;
  from: number;
  to: number;
  direction: 'tighten' | 'loosen';
  /** `clock.now()` of the cycle that applied it. */
  applied_at: Date;
  /** Machine-readable cause, e.g. 'attribution', 'proposal', 'proposal:backtest_auto_approved'. */
  reason: string;
}

/** Append-only tuning audit log. FL-local: FL is its only writer today. */
export interface AdjustmentLog {
  append(entry: Adjustment): void;
}

/**
 * The subset of the spec's `FeedbackInput` that `runDailyCycle` actually
 * consumes. `portfolio` (PortfolioView) is absent because it feeds
 * `computeMetrics` (#93), not attribution; `store` is split into the two
 * narrow ports the cycle needs rather than one god-object `SharedStore`.
 */
export interface DailyCycleInput {
  /** Wall-clock live, simulated T in replay — the cycle reads time only through this. */
  clock: Clock;
  /** Outcomes to attribute. */
  trades: ClosedTradeStore;
  /** FL's system-of-record for per-analyst attribution, joined by `debate_id`. */
  debate_log: DebateLogStore;
  /** The three dials, read and written. */
  tuning: TuningStore;
  /** Where every applied move is recorded. */
  adjustments: AdjustmentLog;
  config: FeedbackConfig;
  approvals: LoosenApprovalChannel;
  /** Param/threshold moves requested this cycle. Weights are not proposed — they are attributed. */
  proposals: TuningProposal[];
  /**
   * Backtest auto-handles loosening approvals (like Verdict's HITL bypass)
   * and records them, so a replay exercises the same code path as live.
   */
  mode: 'live' | 'backtest';
}

/** Shape frozen by feedback-loop-spec.md ("Key Interfaces"). */
export interface DailyCycleResult {
  /** Per `analyst_id`, bounded. */
  weight_updates: Record<string, { from: number; to: number }>;
  /** Strategy params AND risk thresholds, keyed by name. */
  param_updates: Record<string, { from: number; to: number; direction: 'tighten' | 'loosen' }>;
  /** Risk-threshold loosenings awaiting human OK — proposed, NOT written. */
  loosen_pending_approval: string[];
  /** True if the cycle wrote at least one dial. */
  applied: boolean;
}

/** Single test seam. Deterministic given its clock-scoped inputs. */
export interface FeedbackLoop {
  runDailyCycle(input: DailyCycleInput): DailyCycleResult;
}
