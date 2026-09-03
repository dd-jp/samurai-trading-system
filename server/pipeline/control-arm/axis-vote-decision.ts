/**
 * Falsifier arm 2's entry decision (#753) — the deterministic axis vote,
 * shaped so the SAME Trader can consume it.
 *
 * ## What the control arm is, and why this file is so small
 *
 * ADR-0014 amendment 2 and ADR-0017's Consequences mandate falsifier arm 2 as
 * the system's primary matched control: *same name selection, same exit rule,
 * same stop, entry by indicator alone, no LLM in the path*. The whole system's
 * claim is that debate beats indicators, and this is the only measurement that
 * can test it — `docs/research/12-edge-hypothesis-critique.md` D4 rules out the
 * tempting substitute, a return-only comparison against a risk-targeted stream.
 *
 * Since #789 the analyst layer is DETERMINISTIC: `assessAxes`
 * (`analysts/technical-analyst.ts`) combines the trend / momentum /
 * participation / structure votes into a `{ direction, confidence }` with no
 * async call and no model anywhere in it, and the technical `AnalystView` the
 * orchestrator already produces carries exactly that pair. So the control arm's
 * entry is not a new signal to implement — it is the analyst layer's own output,
 * thresholded by the Trader's existing conviction floor. As `analysts-spec.md`
 * puts it, the control "becomes the analyst layer's own output thresholded, with
 * no separate implementation to write and **no risk of the control differing
 * from the live arm by accident**."
 *
 * That is why this module contains no thresholding, no sizing, no bracket and no
 * exit logic. Every one of those is read from the SAME `TraderConfig` and the
 * same `subclass-bracket.ts` constants the live arm reads, one stage down. This
 * file's entire job is to say what the axis vote decided, in the shape the
 * Trader already accepts.
 *
 * ## Why a `DebateResult` and not a new Trader entry point
 *
 * `TickSteps.trader` takes a `DebateResult`. Two ways to give the control arm an
 * entry existed: synthesize a `DebateResult`-shaped value from the axis vote, or
 * add a lower-level Trader entry point taking `AnalystView[]` directly.
 *
 * The synthesis wins, and not merely because it is smaller. A second Trader
 * entry point would be a second implementation of "how a direction and a
 * conviction become an order" — a second place for the conviction floor, the
 * position-awareness routing, the frozen bracket, the flatten window and the
 * scale-in rule to be applied, and therefore a second place for them to drift
 * from the live arm's. #753's acceptance criterion is that the two arms' exit
 * rule and stop are *asserted, not configured twice*; a second entry point would
 * make that assertion something to maintain rather than something structural.
 * With the synthesis, `decide.ts` is reached by both arms with a `debate`
 * argument that differs only in where its `direction` and `confidence` came
 * from, and the control genuinely IS the live arm minus one stage.
 *
 * The cost of the synthesis is the honest one and it is paid explicitly below:
 * three of `DebateResult`'s fields describe a debate that did not happen, and
 * each is given the value that says so rather than one that flatters the control.
 *
 * ## The no-LLM guarantee, stated structurally
 *
 * This module imports no LLM client, no debate engine round orchestrator and no
 * mediator — only types. It is a pure, synchronous function of an
 * `AnalystView[]` the caller already holds. There is no seam through which a
 * model call could be injected into it, which is what makes "zero LLM calls
 * against the control arm" a property of the code's shape rather than of a
 * runtime check that could be removed.
 */
import { createHash } from 'node:crypto';
import type { AnalystView, DebateResult } from '../debate-engine/index.js';

/**
 * The analyst whose view IS the deterministic axis vote (#789).
 *
 * A named constant rather than an inline string because it is the single point
 * of contact between this module and the analyst layer: if the axis-vote analyst
 * is ever renamed, exactly one line here changes, and `controlArmDecision`
 * returns `null` — a control arm that declines to trade — rather than silently
 * deciding off some other analyst's view.
 */
export const AXIS_VOTE_ANALYST_TYPE = 'technical';

/**
 * The `debate_id` namespace every control-arm decision is keyed under.
 *
 * Load-bearing in two directions. It keeps the control arm's `trader_log`,
 * `risk_log`, `verdict_log` and `cosine_setups` rows greppable and separable
 * from the live arm's without a schema change to any of those tables — and it
 * makes a control id impossible to mistake for a debate id, because a real
 * `computeDebateId` output is 64 hex characters with no prefix and this is not.
 *
 * It is NOT what makes the control's TRADES distinguishable: `open_positions`
 * and `closed_trades` carry a real `arm` column (migration 0033) so that
 * property is queryable rather than inferred from a string prefix.
 */
export const CONTROL_DEBATE_ID_PREFIX = 'control:';

/**
 * The `trace_id` suffix every control-arm pass runs under. It lives here, beside
 * the debate-id prefix, because it is the other half of the same discriminator:
 * `risk_log`/`trader_log` rows carry it non-nullably on their own key, so a
 * reader that joins those tables can exclude the control arm without depending
 * on a join succeeding. The orchestrator's tick hook applies it.
 */
export const CONTROL_TRACE_SUFFIX = ':control';

/** Free-text `DebateResult` fields, hoisted so the record says the same thing everywhere. */
const NO_DEBATE_HAPPENED =
  'Falsifier arm 2 (#753): no debate was held. The direction and confidence below are the ' +
  "technical analyst's deterministic axis vote (assessAxes), thresholded by the Trader's own " +
  'conviction floor. No model was called at any point on this path.';

/**
 * The control arm's decision for one instrument on one bar, or `null` when the
 * axis vote is not available at all.
 *
 * `null` means the technical view is absent from `views` — a cold instrument
 * whose core indicators could not be read, or an analyst that skipped. It is
 * deliberately NOT used for "the vote was neutral" or "confidence was low":
 * those are decisions the Trader makes, on the same conviction floor and the same
 * `direction === 'neutral'` branch it applies to the live arm, and pre-empting
 * them here would put a second entry gate in the control arm that the live arm
 * does not have.
 */
export function controlArmDecision(input: {
  instrument: string;
  /** The SAME views the live arm's debate is about to run on — not a re-run. */
  views: readonly AnalystView[];
  /** The decision bar the gate opened for this pass. */
  bar: Date;
}): DebateResult | null {
  const axisVote = input.views.find((view) => view.analyst_type === AXIS_VOTE_ANALYST_TYPE);
  if (axisVote === undefined) return null;

  return {
    // The two fields the Trader actually reads to decide. Straight off the axis
    // vote, unmodified: `direction` picks the side, `confidence` is what the
    // Trader's `conviction_floor` thresholds and what its conviction multiplier
    // scales size by — the SAME floor and the SAME multiplier the live arm's
    // debate confidence goes through.
    direction: axisVote.direction,
    confidence: axisVote.confidence,

    // The bar coordinate, carried forward from the gate exactly as the live
    // arm's debate carries it (#687/#743). The Trader inherits its
    // `decision_timestamp` and its idempotency key's bar from here, so a control
    // intent keys to the same bar the live one does — which is precisely why the
    // key also has to carry the arm.
    bar_timestamp: input.bar,
    debate_id: controlDebateId(input.instrument, input.bar, axisVote),

    // ── The fields that describe a debate that did not happen. ──────────────
    // Each is given the value that SAYS SO, rather than the value that would
    // make the control look most like the live arm.
    //
    // `converged: true` is the one that needs defending, because `false` is the
    // superficially humbler choice and would be wrong twice over. The Trader
    // reads `converged` in two places: it applies `non_converged_haircut` to
    // size, and `routeDecision` refuses to scale in or flip a held position on a
    // non-converged debate. A `false` here would therefore give the control a
    // systematically smaller position and a different POSITION-AWARENESS
    // ROUTING than the live arm — differences in the exit and sizing rules,
    // which is exactly what a matched control may not have. And it would be a
    // false statement about the world: convergence means "the mediator signalled
    // agreement before the round cap", and a single deterministic vote has no
    // disagreement left to resolve. It is unanimous by construction. The control
    // arm has no rounds, so "converged" is not a variable for it — it is
    // ALWAYS-DECIDED, and a constant is the honest encoding of that.
    //
    // The consequence, named rather than left to be discovered: on a bar where
    // the LIVE debate fails to converge, the live arm takes the
    // `non_converged_haircut` and refuses a scale-in while the control does
    // neither, so the two arms' sizing diverges on exactly those bars. That is
    // not a defect to fix by mirroring the live arm's convergence — the control
    // has no debate whose convergence could be mirrored, and copying the live
    // flag would make the control's size a function of the live model layer,
    // which is the one input a matched control may not take. It is a known
    // asymmetry of the measurement, and `formatArmComparison` says so in the
    // report rather than leaving the reader to infer it from equal trade counts.
    converged: true,
    // Zero, not one. No round was run, and a `1` here would put a fabricated
    // round into any per-round accounting of what the control cost.
    rounds_completed: 0,
    // Likewise zero: no wall-clock was spent debating. The axis vote's own cost
    // was already paid by the analyst layer, and it is paid ONCE — the control
    // arm reuses the live arm's views rather than re-running them.
    latency_ms: 0,
    // No analyst was argued with, so no analyst influenced an outcome. An empty
    // set rather than a synthesized contribution for the technical analyst:
    // `AnalystContribution.influence_score` measures how much a view MOVED a
    // debate, and there was no debate to move. The Feedback Loop's attribution
    // join reads `debate_log`, which the control arm never writes, so nothing
    // downstream is looking for a contribution here.
    contributions: [],
    open_items: [],
    synthesis: NO_DEBATE_HAPPENED,
    position: NO_DEBATE_HAPPENED,
    disagreement_summary: NO_DEBATE_HAPPENED,
  };
}

/**
 * The control arm's deterministic decision id.
 *
 * Mirrors `computeDebateId`'s posture — a sha256 over a canonical payload,
 * excluding `trace_id` and `timestamp` because both vary across an otherwise
 * identical re-run — so a crash-restart on the same bar re-derives the same id
 * and the setup-store write stays first-write-wins rather than becoming a second
 * row. It hashes only the ONE view it actually decided from, because that view
 * is the whole of the control's input; hashing the full view set would make the
 * control's id move when an unrelated analyst's prose changed.
 */
function controlDebateId(instrument: string, bar: Date, axisVote: AnalystView): string {
  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
    analyst_id: axisVote.analyst_id,
    direction: axisVote.direction,
    confidence: axisVote.confidence,
    key_points: axisVote.key_points,
  });

  return `${CONTROL_DEBATE_ID_PREFIX}${createHash('sha256').update(payload).digest('hex')}`;
}
