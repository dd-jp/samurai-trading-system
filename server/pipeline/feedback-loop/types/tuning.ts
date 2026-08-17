/**
 * The tunable dials and the proposal path that moves them (#308).
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
   * For a RISK THRESHOLD it classifies the move: a move against it is a
   * LOOSENING, which is applied like any other (ADR-0013 Decision 2, #736 —
   * it used to wait on human approval) but is the one kind of move announced
   * on `LoosenNotificationChannel`. For a STRATEGY PARAM it is descriptive
   * only: it labels the emitted `param_updates[].direction`, which the spec's
   * `DailyCycleResult` requires on every entry.
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
  /**
   * Per risk-threshold bounds, keyed by threshold name. Tuned inside them in
   * both directions — and a loosening is additionally refused by the in-code
   * clamp (`server/shared/threshold-bounds.ts`) if the bounded value would
   * cross a guarded threshold's research-mandated line.
   */
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
 * Notification seam for an APPLIED risk-threshold loosening.
 *
 * This was `LoosenApprovalChannel`, and the rename is the point of #736. Under
 * [ADR-0013](../../../../docs/adr/0013-no-human-gate-anywhere.md) Decision 2
 * the cycle applies a loosening itself, clamped to the hard bounds; nothing
 * waits on a human and nothing in this repo could deliver a human's answer
 * anyway (`alert-transport.ts` never calls `client.start()`, because
 * Telegram's `getUpdates` is single-consumer per bot token). A port named
 * "approval" whose `void` return could never carry consent was the exact
 * defect ADR-0013 names: "a mechanism that looks enforced and enforces
 * nothing."
 *
 * What it does NOT become is deleted. A dial that moves itself has to say so:
 * this is now the operator's only notice that a safety limit was relaxed, and
 * it is sent AFTER the write, describing what happened rather than asking
 * whether it may.
 *
 * Deliberately NOT Verdict's `ApprovalChannel` (server/pipeline/verdict/types.ts): that
 * port's `ApprovalRequest` is order-shaped (`order_intent`, `risk_decision`)
 * and cannot describe a threshold move. Same trade channel, different shape.
 *
 * Fire-and-forget: `runDailyCycle` is synchronous per the spec, so the send is
 * started and not awaited. A notice that fails to deliver does NOT roll the
 * move back — the dial has already moved, and the honest failure mode is an
 * applied change the operator was not told about, logged at `error` by the
 * adapter. Tightenings are not announced; only relaxations are, because only
 * a relaxation widens what the system may lose.
 */
export interface LoosenNotificationChannel {
  notifyLoosenApplied(notice: LoosenAppliedNotice): void;
}

export interface LoosenAppliedNotice {
  /** Risk-threshold name, as keyed in `FeedbackConfig.risk_thresholds`. */
  name: string;
  from: number;
  /** The bounded value actually written — not the raw target. */
  to: number;
  applied_at: Date;
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
  /** Machine-readable cause, e.g. 'attribution', 'proposal', 'breach_auto_tighten'. */
  reason: string;
}

/** Append-only tuning audit log. FL-local: FL is its only writer today. */
export interface AdjustmentLog {
  append(entry: Adjustment): void;
}

/**
 * The shape of a `dial_adjustments` row with `status = 'pending_approval'` —
 * the storage lifecycle `SqliteAdjustmentLog.recordPendingApproval` /
 * `resolvePendingApproval` (#197) implement.
 *
 * **Nothing produces one, and after #736 nothing ever will.** The only caller
 * this type was ever waiting on was the loosen gate, and ADR-0013 Decision 2
 * removed it: every dial move the Feedback Loop makes is now applied
 * immediately and written as a resolved `Adjustment`. This is kept — rather
 * than deleted with the gate — for exactly one reason: it is the row shape of
 * a status the `dial_adjustments` schema still defines (migration
 * `0002_dial_adjustments_reason.sql`, `shared-sqlite-store-spec.md`), and
 * changing a persisted schema is a separate change from removing a control.
 * Read it as a store capability with no producer, NOT as an approval path
 * that might still fire: there is no code path from a tuning cycle to here.
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
