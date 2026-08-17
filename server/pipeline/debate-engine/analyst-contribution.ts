/**
 * Per-analyst contribution tracking (#36) — see docs/specs/debate-engine-spec.md
 * ("Key Interfaces", `AnalystContribution`) and story 15 ("track each
 * analyst's contribution... so the Feedback Loop can later adjust analyst
 * weights").
 *
 * Blocked-by #34 (Round Structure & Termination Orchestrator) does not yet
 * exist, so this is a pure builder over an explicit local input shape rather
 * than something wired into round-orchestration internals. Once #34 lands,
 * it calls this with the real per-round stances it produces — same pattern
 * `debate-log-store.ts`'s `buildDebateLog` used ahead of full pipeline
 * wiring (#63).
 */
import type { AnalystContribution, AnalystView, Direction } from './types.js';

/**
 * One analyst's directional stance at the end of a given debate round, "as
 * interpreted through debate lens" (issue #36) — i.e. how the round
 * orchestrator reads that analyst's position after bull/bear/mediator
 * exchange, not necessarily the analyst's original `AnalystView.direction`.
 */
export interface AnalystRoundStance {
  analyst_id: string;
  round: number;
  stance: Direction;
}

/**
 * Builds one `AnalystContribution` per `AnalystView`, in the same order as
 * `views`. `roundStances` is keyed by `analyst_id` and may be sparse — an
 * analyst with no recorded round stances (e.g. dropped after the initial
 * view under #37's timeout/quorum handling, not yet implemented) falls back
 * to an empty `stance_during_debate` and its original `view.direction` as
 * `final_position`.
 */
export function buildAnalystContributions(
  views: AnalystView[],
  roundStances: AnalystRoundStance[],
): AnalystContribution[] {
  return views.map((view) => {
    const stanceDuringDebate = roundStances
      .filter((entry) => entry.analyst_id === view.analyst_id)
      .sort((a, b) => a.round - b.round)
      .map((entry) => entry.stance);

    const lastStance = stanceDuringDebate[stanceDuringDebate.length - 1];
    const finalPosition = lastStance ?? view.direction;

    return {
      analyst_id: view.analyst_id,
      analyst_type: view.analyst_type,
      stance_during_debate: stanceDuringDebate,
      final_position: finalPosition,
      rationale: view.key_points.join('; '),
      influence_score: computeInfluenceScore(stanceDuringDebate),
    };
  });
}

/**
 * Influence score: fraction of consecutive-round transitions in which the
 * analyst's stance changed, normalized 0.0-1.0. Fewer than two recorded
 * rounds means no transition is observable, so the score is 0. This is a
 * mechanical stance-shift metric, not a semantic one — semantic disagreement
 * detection (#32) is a separate, LLM-backed concern out of scope here (spec's
 * "LLM Selection & Prompt Engineering" exclusion).
 */
export function computeInfluenceScore(stanceDuringDebate: Direction[]): number {
  if (stanceDuringDebate.length < 2) {
    return 0;
  }

  let changes = 0;
  for (let i = 1; i < stanceDuringDebate.length; i++) {
    if (stanceDuringDebate[i] !== stanceDuringDebate[i - 1]) {
      changes++;
    }
  }

  return changes / (stanceDuringDebate.length - 1);
}
