import type { AnalystContribution, DebateResult } from './types.js';

export function weightedConvictionFactor(
  contributions: readonly AnalystContribution[],
  direction: DebateResult['direction'],
  weights: Readonly<Record<string, number>>,
): number {
  if (contributions.length === 0) return 1;

  const weightOf = (contribution: AnalystContribution): number => {
    const weight = weights[contribution.analyst_id];
    return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1;
  };

  const agreeing = contributions.filter(
    (contribution) => contribution.final_position === direction,
  );

  if (agreeing.length === 0) return 1;

  const totalWeight = contributions.reduce((sum, c) => sum + weightOf(c), 0);
  if (totalWeight <= 0) return 1;

  const weightedAgreement = agreeing.reduce((sum, c) => sum + weightOf(c), 0) / totalWeight;
  const unweightedAgreement = agreeing.length / contributions.length;

  return weightedAgreement / unweightedAgreement;
}

export function applyAnalystWeights(
  result: DebateResult,
  weights: Readonly<Record<string, number>>,
): DebateResult {
  const factor = weightedConvictionFactor(result.contributions, result.direction, weights);
  if (factor === 1) return result;

  return {
    ...result,
    confidence: Math.min(1, Math.max(0, result.confidence * factor)),
  };
}
