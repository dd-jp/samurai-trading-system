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

import { NO_DATA_MARKER } from '../analysts/types.js';
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
 * combination of the directional-consensus metric and evidence strength
 * (quality/quantity of arguments presented).
 *
 * `roundStances` may be sparse or empty, matching `buildAnalystContributions`
 * — an analyst with no recorded round stances falls back to its original
 * `AnalystView.direction` when determining final position.
 *
 * `debateVerdict` is the mediator's final stance, counted as one more
 * participant. Optional so the pre-#625 callers and the pure unit tests keep
 * compiling; the production adapter always supplies it. See
 * `computeDirectionalConsensus` for why bull/bear stances are NOT included.
 */
export function computeConvictionScore(
  views: AnalystView[],
  roundStances: AnalystRoundStance[],
  debateVerdict?: Direction,
): number {
  if (views.length === 0) {
    return NO_DATA_SCORE;
  }

  const directional = computeDirectionalConsensus(views, roundStances, debateVerdict);
  const evidence = computeEvidenceStrength(views);

  const score = DISAGREEMENT_WEIGHT * directional + EVIDENCE_WEIGHT * evidence;

  return clamp(score);
}

/** Numeric positions for each direction on a bearish(-1)..bullish(+1) axis. */
const DIRECTION_VALUE: Record<Direction, number> = {
  bearish: -1,
  neutral: 0,
  bullish: 1,
};

/**
 * Directional consensus: how strongly the participants lean ONE WAY,
 * normalized 0-1. Maps final positions onto a bearish(-1)..bullish(+1) axis
 * and takes the magnitude of their mean.
 *
 * **This replaced a spread-between-extremes metric in #625, which measured
 * agreement rather than conviction and produced three compounding defects.**
 * `max - min` is blind to how MANY participants hold each position, so a
 * table of silent analysts had zero spread and therefore scored 1.0 — full
 * conviction — while a single analyst forming a real directional opinion
 * introduced a spread and collapsed the score to ~0.5. The system was most
 * confident exactly when nobody had said anything, and the only branch with
 * headroom above the Trader's conviction floor was "every analyst neutral,
 * mediator overrides to a direction" — a trade no analyst agreed with. A mean
 * counts participants, so silence and disagreement both score 0 and only a
 * genuine directional lean scores high.
 *
 * The mediator's verdict is counted as one more participant, which is what
 * makes the debate able to move the score at all (#625 defect 2: the adapter
 * echoed analyst input directions back as "round stances", so rounds
 * contributed exactly zero to a score we were paying an LLM to produce).
 *
 * **Bull and bear stances are deliberately excluded.** Their direction is an
 * ASSIGNED ROLE, not an opinion — the bear argues bearish because it was told
 * to. Counting them would add a permanent -1 and +1 to every debate, pinning
 * the mean near zero and making conviction unreachable by construction.
 *
 * INVARIANT worth keeping: with no directional lean the first term is 0, so
 * the score cannot exceed `EVIDENCE_WEIGHT` (0.4) — below every conviction
 * floor the Trader ships. A debate in which nobody takes a side can therefore
 * never open a position, arithmetically rather than by a threshold that could
 * be retuned.
 */
function computeDirectionalConsensus(
  views: AnalystView[],
  roundStances: AnalystRoundStance[],
  debateVerdict?: Direction,
): number {
  const values = views.map((view) => DIRECTION_VALUE[finalPositionFor(view, roundStances)]);
  if (debateVerdict !== undefined) {
    values.push(DIRECTION_VALUE[debateVerdict]);
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

  return clamp(Math.abs(mean));
}

function finalPositionFor(view: AnalystView, roundStances: AnalystRoundStance[]): Direction {
  const stances = roundStances
    .filter((entry) => entry.analyst_id === view.analyst_id)
    .sort((a, b) => a.round - b.round);

  const lastStance = stances[stances.length - 1]?.stance;

  return lastStance ?? view.direction;
}

/**
 * An analyst that never looked. `NO_DATA_MARKER` is stamped into `key_points`
 * by the sentiment and fundamental analysts when the Market Intelligence store
 * returns nothing, and its own doc comment is explicit that this is "an
 * ABSENCE OF INPUT, not a neutral read of the market... It never looked."
 */
function isAbsenceOfInput(view: AnalystView): boolean {
  return view.key_points.some((point) => point.includes(NO_DATA_MARKER));
}

/**
 * Evidence strength: quality/quantity of arguments presented, normalized
 * 0-1. Combines the average number of key points per analyst (saturating at
 * `KEY_POINTS_SATURATION`) with the average stated confidence across the
 * analysts that ACTUALLY CONTRIBUTED.
 *
 * **Excluding absent analysts is #625 defect 1's real fix, and it is not a
 * tuning choice.** `NO_DATA_MARKER`'s own prompt text instructs the debate to
 * treat the absence as an absence — and then this function averaged it in as
 * weak evidence, which is the opposite. On the production stock desk the
 * sentiment and fundamental analysts are pinned at confidence 0.05 by the #436
 * NO_DATA branch, so `avgConfidence` was `(0.95 + 0.05 + 0.05) / 3 = 0.35`
 * however strong the one analyst that did look happened to be. That capped the
 * whole score at **0.5478** against a **0.55** conviction floor: a stock could
 * never trade, at any RSI, in any market, and no change to the consensus term
 * moves that — both `1 - spread/2` and `|mean|` yield 0.5 for this shape, so
 * the ceiling reproduces exactly. The ceiling was the muted analysts, not the
 * formula around them.
 *
 * The absent analysts are still counted as neutral votes in
 * `computeDirectionalConsensus` — that part is honest, since an analyst with
 * no input genuinely has no direction, and it keeps a lone dissenter from
 * sizing as if the whole desk agreed. So conviction rises on its own as #552
 * gives those analysts real data, rather than needing a threshold retune.
 *
 * With every analyst absent there is no evidence to average, and the score
 * falls back to the consensus term alone rather than dividing by zero.
 */
function computeEvidenceStrength(views: AnalystView[]): number {
  const contributing = views.filter((view) => !isAbsenceOfInput(view));
  if (contributing.length === 0) {
    return 0;
  }

  const avgKeyPoints =
    contributing.reduce((sum, view) => sum + view.key_points.length, 0) / contributing.length;
  const keyPointsScore = clamp(avgKeyPoints / KEY_POINTS_SATURATION);

  const avgConfidence =
    contributing.reduce((sum, view) => sum + view.confidence, 0) / contributing.length;

  return clamp((keyPointsScore + avgConfidence) / 2);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
