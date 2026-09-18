
import { NO_DATA_MARKER } from '../../shared/index.js';
import type { AnalystRoundStance } from './analyst-contribution.js';
import type { AnalystView, Direction } from './types.js';

const CONSENSUS_WEIGHT = 0.6;
export const EVIDENCE_WEIGHT = 0.4;

const NO_DATA_SCORE = 0.5;

const KEY_POINTS_SATURATION = 3;

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

const DIRECTION_VALUE: Record<Direction, number> = {
  bearish: -1,
  neutral: 0,
  bullish: 1,
};

function directionValue(direction: Direction): number {
  const value = (DIRECTION_VALUE as Partial<Record<Direction, number>>)[direction];

  return value ?? 0;
}

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

function isAbsenceOfInput(view: AnalystView): boolean {
  return view.key_points.some((point) => point.startsWith(NO_DATA_MARKER));
}

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
