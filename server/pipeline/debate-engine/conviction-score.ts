/**
 * Conviction score calculation (#35) — see docs/specs/debate-engine-spec.md
 * ("Module: Conviction Score Algorithm") and story 14 ("produce a conviction
 * score (hybrid of disagreement inverse + evidence strength), so that the
 * Trader has a scalar measure of consensus strength").
 *
 * A pure builder over an explicit local input shape rather than something
 * wired into round-orchestration internals — `debate-adapter.ts` calls it
 * from the mediator persona it hands to #34's round orchestrator
 * (`round-orchestrator.ts`), with the real per-round stances it accumulates.
 *
 * Formula and combination logic were resolved by #625 (2026-08-14) — see
 * debate-engine-spec.md's "Module: Conviction Score Algorithm" for the three
 * defects it fixed. The 0.6/0.4 weighting itself is still empirical and
 * carried over unchanged (#625 fixed the combination, not the weights), so
 * it stays a named constant below to retune without touching that logic.
 */

import { NO_DATA_MARKER } from '../analysts/index.js';
import type { AnalystRoundStance } from './analyst-contribution.js';
import type { AnalystView, Direction } from './types.js';

/**
 * Weight given to the directional-consensus metric in the hybrid combination.
 *
 * Named `DISAGREEMENT_WEIGHT` before #625, when the first term measured spread
 * between extremes. It now scales `computeDirectionalConsensus`, which measures
 * a lean rather than a disagreement, so the old name inverted the sense of the
 * thing it multiplied.
 */
const CONSENSUS_WEIGHT = 0.6;
/** Weight given to the evidence-strength metric in the hybrid combination */
export const EVIDENCE_WEIGHT = 0.4;

/** Score returned when there is no debate state to evaluate (no views) */
const NO_DATA_SCORE = 0.5;

/**
 * Number of key points per analyst considered "full" evidence for
 * normalization purposes; more key points than this don't add further
 * evidence-strength credit
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
 * `debateVerdict` is the mediator's final stance, folded into the consensus
 * term subject to `computeDirectionalConsensus`'s carve-outs below. It is
 * **required but nullable**, deliberately: a caller that simply omits it
 * gets a materially different, mediator-free score on a path that gates
 * trades, so the omission has to fail at compile time rather than degrade
 * silently. Passing `undefined` is the explicit way to ask for the
 * mediator-free score (the pure unit tests, and any caller with no mediator);
 * the production adapter always supplies a real stance. See
 * `computeDirectionalConsensus` for why bull/bear stances are NOT included.
 */
export function computeConvictionScore(
  views: AnalystView[],
  roundStances: AnalystRoundStance[],
  debateVerdict: Direction | undefined,
): number {
  if (views.length === 0) {
    return NO_DATA_SCORE;
  }

  const directional = computeDirectionalConsensus(views, roundStances, debateVerdict);
  const evidence = computeEvidenceStrength(views);

  const score = CONSENSUS_WEIGHT * directional + EVIDENCE_WEIGHT * evidence;

  return clamp(score);
}

/** Numeric positions for each direction on a bearish(-1)..bullish(+1) axis */
const DIRECTION_VALUE: Record<Direction, number> = {
  bearish: -1,
  neutral: 0,
  bullish: 1,
};

/**
 * `DIRECTION_VALUE` lookup that survives an off-union value at runtime.
 *
 * The mediator's stance is LLM output that has crossed a parse boundary, so the
 * `Direction` type is a claim about it rather than a guarantee. A bare index
 * would yield `undefined`, propagate to `NaN` through the mean, and hand the
 * Trader a `NaN` conviction — which compares false against every floor and so
 * fails silently as "no trade" rather than as an error. Unknown stances are
 * counted as neutral, matching how an analyst with no direction is treated.
 */
function directionValue(direction: Direction): number {
  const value = (DIRECTION_VALUE as Partial<Record<Direction, number>>)[direction];

  return value ?? 0;
}

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
 * When the carve-outs below don't exclude it, the mediator's verdict is
 * counted as one more participant — which is what makes the debate able to
 * move the score at all (#625 defect 2: the adapter echoed analyst input
 * directions back as "round stances", so rounds contributed exactly zero to
 * a score we were paying an LLM to produce).
 *
 * **Bull and bear stances are deliberately excluded.** Their direction is an
 * ASSIGNED ROLE, not an opinion — the bear argues bearish because it was told
 * to. Counting them would add a permanent -1 and +1 to every debate, pinning
 * the mean near zero and making conviction unreachable by construction.
 *
 * INVARIANT: for any NON-EMPTY set of analyst views, with no directional lean
 * the first term is 0, so the score cannot exceed `EVIDENCE_WEIGHT` (0.4) —
 * below every conviction floor the Trader ships. A debate in which nobody
 * takes a side can therefore never open a position, arithmetically rather
 * than by a threshold that could be retuned. This now holds unconditionally
 * over this function's own inputs, including with a mediator verdict present
 * — see the next paragraph. (`computeConvictionScore` short-circuits on an
 * EMPTY `views` array before this function ever runs, returning
 * `NO_DATA_SCORE` = 0.5, which does exceed 0.4 — that path is a "no debate
 * ran at all" fallback, not a directional-lean question, and is unaffected
 * by #683.)
 *
 * **#683 — the mediator amplifies a lean but cannot create one.** Without this
 * carve-out, with every analyst neutral, the mediator's single vote alone
 * would supply a lean of `1/(n+1)` out of nothing, whose size depends on how
 * many analysts sit on the desk: at maximum evidence that computes to
 * **exactly 0.55** on a three-analyst desk (tying `conviction_floor`) and
 * **0.60** on a two-analyst desk (clearing it outright), and the Trader gates
 * on `confidence < conviction_floor` (`decide.ts`, strict `<`, predates
 * #683), so the tied score would authorise a trade no analyst had actually
 * taken a side on — the pre-#625 branch this module set out to close,
 * surviving at the boundary. Fixed by computing the analysts' own directional
 * mean first: when it is exactly 0 (every analyst neutral, or a desk that
 * cancels out exactly, e.g. one bullish and one bearish), the mediator's
 * verdict is excluded entirely and the consensus term is 0 regardless of what
 * the mediator says. When the analysts' own mean is non-zero, the mediator is
 * still counted as one more equal participant, exactly as before — it can
 * move an existing lean up or down, it just cannot manufacture one from
 * nothing. This closes the hole for every desk size, not just the three- and
 * two-analyst cases measured above, because the fix depends on the analyst
 * mean rather than on `n`.
 */
function computeDirectionalConsensus(
  views: AnalystView[],
  roundStances: AnalystRoundStance[],
  debateVerdict?: Direction,
): number {
  const analystValues = views.map((view) => directionValue(finalPositionFor(view, roundStances)));
  const analystMean = analystValues.reduce((sum, value) => sum + value, 0) / analystValues.length;

  if (debateVerdict === undefined) {
    return clamp(Math.abs(analystMean));
  }

  if (analystMean === 0) {
    return 0;
  }

  const values = [...analystValues, directionValue(debateVerdict)];
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
 *
 * Matched as a PREFIX, not a substring. Both stampers emit `${NO_DATA_MARKER}:
 * ...` at the head of the key point, so the prefix is what they actually
 * produce; a substring match would additionally fire on any LLM-authored key
 * point that happened to quote the marker text mid-sentence, silently dropping
 * a real contributor out of the evidence average.
 */
function isAbsenceOfInput(view: AnalystView): boolean {
  return view.key_points.some((point) => point.startsWith(NO_DATA_MARKER));
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
