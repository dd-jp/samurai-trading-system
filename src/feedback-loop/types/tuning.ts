/**
 * The tunable dials and the proposal/approval path that moves them (#308).
 *
 * Split out of the single `feedback-loop/types.ts` so that adding a dial does
 * not dirty the file the metrics and kill-line consumers import. `types.ts`
 * remains a re-export barrel, so no import site changed.
 */
// Type-only and therefore safe both ways: `metrics.ts` imports the dial shapes
// back from here. A kill threshold is a bound ON a dial, so the two genuinely
// reference each other.
import type { KillThresholds } from './metrics.js';

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
  /*
   * `shadow_credit` / `shadow_influence_ceiling` were removed by #370. Both
   * existed only to compensate an analyst that `influence_score` had scored
   * quiet, and attribution no longer reads `influence_score` at all — see
   * `creditForContribution`. Left as a note rather than deprecated fields so
   * a profile that still sets them fails to compile instead of setting a knob
   * nothing consults.
   */
  /** Per strategy-param bounds, keyed by param name. Tuned freely inside them. */
  strategy_params: Record<string, TunableDial>;
  /** Per risk-threshold bounds, keyed by threshold name. Loosening is gated. */
  risk_thresholds: Record<string, TunableDial>;
  /** Kill-line config for `computeMetrics`'s breach detection (#93). */
  kill_thresholds: KillThresholds;
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
 * A gated risk-threshold loosening queued for human approval — the
 * `dial_adjustments` row `runDailyCycle` would write if `AdjustmentLog`
 * recorded `loosen_pending_approval` entries (it doesn't yet: see
 * `LoosenApprovalChannel`'s doc, "acting on the human's answer is a later
 * cycle's job"). `dial` excludes `'analyst_weight'` — weights are never
 * gated (spec: "Weights + strategy params tune freely within bounds").
 * Kept as a schema-shaped type for `SqliteAdjustmentLog`'s pending-approval
 * capability (#197) even though no current caller produces one, the same
 * documented-gap pattern as `SqliteConfigTrialLog`'s `config_json`.
 */
export interface PendingApprovalAdjustment {
  dial: 'strategy_param' | 'risk_threshold';
  name: string;
  from: number;
  to: number;
  direction: 'tighten' | 'loosen';
  requested_at: Date;
  reason: string;
}
