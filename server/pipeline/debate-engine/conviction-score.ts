/**
 * Conviction score calculation (#35) — see docs/specs/debate-engine-spec.md
 * ("Module: Conviction Score Algorithm") and story 14 ("produce a conviction
 * score (hybrid of disagreement inverse + evidence strength), so that the
 * Trader has a scalar measure of consensus strength").
 *
 * Blocked-by #34 (Round Structure & Termination Orchestrator) does not yet
 * exist, so this is a pure builder over an explicit local input shape rather
 * than something wired into round-orchestration internals — same pattern
 * `analyst-contribution.ts` used ahead of full pipeline wiring. Once #34
 * lands, it calls this with the real per-round stances it produces.
 *
 * Exact formula and weighting are explicitly called out in the spec as TBD,
 * to be refined empirically — the weights below are named constants so
 * they're easy to retune without touching the combination logic.
 */
import type { AnalystRoundStance } from './analyst-contribution.js';
import type { AnalystView, Direction } from './types.js';

/** Weight given to the disagreement metric in the hybrid combination. */
const DISAGREEMENT_WEIGHT = 0.6;
/** Weight given to the evidence-strength metric in the hybrid combination. */
const EVIDENCE_WEIGHT = 0.4;

/** Score returned when there is no debate state to evaluate (no views). */
const NO_DATA_SCORE = 0.5;

/**
 * Number of key points per analyst considered "full" evidence for
 * normalization purposes; more key points than this don't add further
 * evidence-strength credit.
 */
const KEY_POINTS_SATURATION = 3;

/**
 * Calculates the conviction score (0.0-1.0) for a debate: a hybrid
 * combination of the disagreement metric (inverse of bull/bear divergence)
 * and evidence strength (quality/quantity of arguments presented).
 *
 * `roundStances` may be sparse or empty, matching `buildAnalystContributions`
 * — an analyst with no recorded round stances falls back to its original
 * `AnalystView.direction` when determining final position.
 */
export function computeConvictionScore(
  views: AnalystView[],
  roundStances: AnalystRoundStance[],
): number {
  if (views.length === 0) {
    return NO_DATA_SCORE;
  }

  const disagreement = computeDisagreementMetric(views, roundStances);
  const evidence = computeEvidenceStrength(views);

  const score = DISAGREEMENT_WEIGHT * disagreement + EVIDENCE_WEIGHT * evidence;

  return clamp(score);
}

/** Numeric positions for each direction on a bearish(-1)..bullish(+1) axis. */
const DIRECTION_VALUE: Record<Direction, number> = {
  bearish: -1,
  neutral: 0,
  bullish: 1,
};

/**
 * Disagreement metric: inverse of bull/bear divergence, normalized 0-1
 * where 1 = full agreement. Maps final positions onto a bearish(-1)..
 * bullish(+1) axis and takes the spread between the extremes: no spread
 * (everyone agrees) scores 1, the maximum spread (bullish vs. bearish
 * analysts both present) scores 0.
 */
function computeDisagreementMetric(
  views: AnalystView[],
  roundStances: AnalystRoundStance[],
): number {
  const values = views.map((view) => DIRECTION_VALUE[finalPositionFor(view, roundStances)]);

  const spread = Math.max(...values) - Math.min(...values);

  return clamp(1 - spread / 2);
}

function finalPositionFor(view: AnalystView, roundStances: AnalystRoundStance[]): Direction {
  const stances = roundStances
    .filter((entry) => entry.analyst_id === view.analyst_id)
    .sort((a, b) => a.round - b.round);

  const lastStance = stances[stances.length - 1]?.stance;

  return lastStance ?? view.direction;
}

/**
 * Evidence strength: quality/quantity of arguments presented, normalized
 * 0-1. Combines the average number of key points per analyst (saturating at
 * `KEY_POINTS_SATURATION`) with the average stated confidence across views.
 */
function computeEvidenceStrength(views: AnalystView[]): number {
  const avgKeyPoints = views.reduce((sum, view) => sum + view.key_points.length, 0) / views.length;
  const keyPointsScore = clamp(avgKeyPoints / KEY_POINTS_SATURATION);

  const avgConfidence = views.reduce((sum, view) => sum + view.confidence, 0) / views.length;

  return clamp((keyPointsScore + avgConfidence) / 2);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
