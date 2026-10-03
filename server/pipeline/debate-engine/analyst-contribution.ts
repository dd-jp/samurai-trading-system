import type { AnalystContribution, AnalystView, Direction } from './types.js';

export interface AnalystRoundStance {
  analyst_id: string;
  round: number;
  stance: Direction;
}

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

function computeInfluenceScore(stanceDuringDebate: Direction[]): number {
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
