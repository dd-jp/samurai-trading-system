/**
 * Weighted debates (#435 part 2) — the Debate Engine reading `analyst_weights`.
 *
 * Resolution of David's decision on #377, and of the `debate_id` question the
 * spec recorded as blocking it.
 *
 * ## The debate_id question, and why it dissolves
 *
 * `cross-spec-contracts.md` §1 freezes `debate_id = hash(instrument + bar +
 * AnalystView set)`, stable across the no-persistence re-run-from-scratch. The
 * spec's "Module: Weighted Debates" flagged a collision: if weights change a
 * debate's output but do not enter that hash, two runs at different weights
 * produce the same id with different results.
 *
 * That case is unreachable, for a reason worth stating rather than assuming.
 * Weights move in exactly one place — `runDailyCycle` calling
 * `setAnalystWeight` (daily-cycle.ts) — and the debate bar is an hour
 * (`DEBATE_BAR_TIMEFRAME_MS`). **A weight step can never occur inside a bar**,
 * and `debate_id` includes the bar. So two debates sharing an id necessarily
 * ran under identical weights.
 *
 * The frozen registry entry therefore needs no amendment, and — the reason
 * this file weights the OUTPUT rather than the inputs — the id keeps meaning
 * exactly what it meant: the identity of the debate's inputs. Replay-from-log
 * restores the logged result, weights included, without recomputing.
 *
 * ## Identity at the neutral seed, which is not a hope but arithmetic
 *
 * The spec requires that with every analyst at the neutral seed, a weighted
 * debate produce output identical to an unweighted one — otherwise the first
 * fortnight of any run silently differs from the baseline it is compared
 * against. The multiplier below is a RATIO of weighted to unweighted
 * agreement, so equal weights make numerator and denominator equal and the
 * factor exactly 1. Not approximately: identically.
 */
import type { AnalystContribution, DebateResult } from './types.js';

/**
 * Scales conviction by whether the analysts agreeing with the mediator are the
 * ones with a track record.
 *
 * `weightedAgreement / unweightedAgreement`:
 *
 * - Agreeing analysts are better-weighted than average → factor > 1, conviction
 *   rises. The consensus is carried by analysts that have been right.
 * - Agreeing analysts are worse-weighted than average → factor < 1, conviction
 *   falls. The consensus is carried by analysts that have been wrong.
 * - All weights equal → factor exactly 1.
 *
 * An analyst with no weight row is treated as neutral (1.0) rather than
 * dropped: a new analyst should not have its agreement discounted before it
 * has had a chance to earn a weight.
 */
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

  // Nobody agrees with the mediator — which happens, since `direction` is the
  // mediator's synthesis rather than a vote. There is no agreement to weight,
  // so weights carry no information here and conviction is left alone.
  if (agreeing.length === 0) return 1;

  const totalWeight = contributions.reduce((sum, c) => sum + weightOf(c), 0);
  if (totalWeight <= 0) return 1;

  const weightedAgreement = agreeing.reduce((sum, c) => sum + weightOf(c), 0) / totalWeight;
  const unweightedAgreement = agreeing.length / contributions.length;

  return weightedAgreement / unweightedAgreement;
}

/**
 * Applies the factor to a resolved `DebateResult`.
 *
 * AFTER `runDebate`, deliberately. Weighting the inputs would change what the
 * personas argue over and therefore what `debate_id` identifies; weighting the
 * output leaves the id meaning what the frozen contract says it means, and
 * keeps the whole mechanism a pure function of (result, weights) that a test
 * can pin exactly.
 *
 * Confidence is clamped to [0, 1] — it is a conviction score the Trader sizes
 * on, and a factor above 1 applied to an already-high confidence must not
 * produce a number the downstream conviction floor has never seen.
 */
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
