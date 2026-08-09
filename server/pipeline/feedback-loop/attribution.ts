/**
 * Influence-weighted performance attribution (#91). See
 * docs/specs/feedback-loop-spec.md ("Module: Weight Attribution").
 *
 * Attributes each closed trade's realized R to the analysts who debated it,
 * signed by stance-vs-outcome: the drivers of a winner gain, the drivers of a
 * loser lose, and an analyst who argued AGAINST a trade that went on to lose
 * gains — it was right. Contributions are read from the debate log by
 * `debate_id` (the ephemeral `DebateResult` is not persisted, decision #10).
 *
 * Pure: computes targets, writes nothing. Bounding and persistence are
 * guardrails.ts / daily-cycle.ts.
 */
import type { ClosedTrade, DebateLogStore } from '../../shared/index.js';
import type { AnalystContribution, Direction } from '../debate-engine/index.js';
import { getContributionsForAttribution } from './debate-attribution-lookup.js';
import type { TunableDial } from './types.js';

/** Accumulated signed credit for one analyst across the cycle's window. */
export interface AnalystCredit {
  analyst_id: string;
  /** Sum of signed, influence-weighted R across every attributed trade. */
  total_credit: number;
  /** How many trades contributed — the divisor for the per-trade mean. */
  trade_count: number;
}

/**
 * R = realized_pnl_net ÷ (|entry − stop| × filled_size) — frozen by
 * cross-spec-contracts.md §4. Always `filled_size`, never requested size.
 *
 * Returns `null` when initial risk is zero (a zero-width bracket or a lot
 * that never filled): R is undefined there, and a trade with no denominator
 * must be skipped rather than attributed as an infinite outcome.
 */
export function realizedR(trade: ClosedTrade): number | null {
  const initialRisk = Math.abs(trade.entry - trade.stop) * trade.filled_size;
  if (initialRisk === 0) {
    return null;
  }
  return trade.realized_pnl_net / initialRisk;
}

/** The direction a trade's side expresses, for stance comparison. */
function tradeDirection(side: ClosedTrade['side']): Direction {
  return side === 'buy' ? 'bullish' : 'bearish';
}

/**
 * +1 if the analyst backed the trade, −1 if it argued the other way, 0 if it
 * ended neutral. A neutral analyst took no directional stand, so it earns
 * neither credit nor blame for the outcome.
 */
function stanceAgreement(stance: Direction, direction: Direction): number {
  if (stance === 'neutral') {
    return 0;
  }
  return stance === direction ? 1 : -1;
}

/**
 * Signed credit one analyst earns from one trade: `agreement × R`. Backing a
 * winner (+1 × +R) and opposing a loser (−1 × −R) both come out positive.
 *
 * ## Why `influence_score` is NOT a factor here (#370, decided 2026-08-05)
 *
 * It used to scale this term as the "did it drive the outcome" half, with a
 * shadow-credit top-up for a right-but-quiet analyst. Two findings retired
 * that design rather than one:
 *
 *  1. **The formula and this consumer disagreed on sign.**
 *     `computeInfluenceScore` (debate-engine/analyst-contribution.ts) measures
 *     how often an analyst CHANGED stance across rounds — i.e. how much it was
 *     persuaded. Weighting credit by it paid analysts for being moved while
 *     the doc here claimed it paid them for moving others. A follower and a
 *     driver scored identically.
 *  2. **It is 0 in practice.** Debates converge in round one, and the score is
 *     0 for fewer than two recorded stances. So the influence term contributed
 *     nothing and shadow credit — which fires only below the influence ceiling
 *     — silently carried the entire signal, at a tenth of its magnitude and
 *     upside-only. Weighting was running on a dead input scaled by a constant.
 *
 * Correctness alone is what this system can honestly measure today. It is
 * signed both ways, so a wrong analyst is now penalised at the same magnitude
 * a right one is rewarded, where the old shadow-only path effectively floored
 * losers at 0.
 *
 * `influence_score` is still COMPUTED and still written to the debate log — it
 * remains a fair observation of stance movement, and re-arming it as a credit
 * factor is open work. It is simply no longer allowed to weight an analyst.
 *
 * Magnitude is safe by construction: `impliedWeight` squashes mean credit
 * through `tanh` onto the dial's band and `guardrails.ts` caps the per-cycle
 * step, so removing a ≤1.0 scaling factor cannot produce an out-of-band target
 * or a larger step than the operator allowed.
 */
export function creditForContribution(
  contribution: AnalystContribution,
  r: number,
  direction: Direction,
): number {
  const agreement = stanceAgreement(contribution.final_position, direction);
  if (agreement === 0) {
    return 0;
  }

  return agreement * r;
}

/**
 * Accumulate per-analyst credit across the cycle's closed trades.
 *
 * A trade is SKIPPED (not zero-attributed) when its debate log row is missing
 * or its R is undefined: attributing a trade we cannot explain would move
 * weights on no evidence.
 */
export function accumulateCredit(
  trades: readonly ClosedTrade[],
  debateLog: DebateLogStore,
): Map<string, AnalystCredit> {
  const credits = new Map<string, AnalystCredit>();

  for (const trade of trades) {
    const r = realizedR(trade);
    if (r === null) {
      continue;
    }
    const contributions = getContributionsForAttribution(debateLog, trade.debate_id);
    if (contributions === undefined) {
      continue;
    }

    const direction = tradeDirection(trade.side);
    for (const contribution of contributions) {
      const existing = credits.get(contribution.analyst_id) ?? {
        analyst_id: contribution.analyst_id,
        total_credit: 0,
        trade_count: 0,
      };
      existing.total_credit += creditForContribution(contribution, r, direction);
      existing.trade_count += 1;
      credits.set(contribution.analyst_id, existing);
    }
  }

  return credits;
}

/**
 * The dial's midpoint — where an analyst with no evidence either way belongs.
 *
 * Exported because two callers must agree on it exactly (#371): this is both
 * `impliedWeight`'s fixed point (`tanh(0) === 0`) and the value
 * `seedAnalystWeights` writes for an analyst with no record at all. Two
 * independent spellings of `(floor + ceiling) / 2` would let a future
 * asymmetric band silently disagree about where "neutral" is — and a seed
 * away from the fixed point makes the first cycles a drift back to the
 * middle rather than a response to evidence.
 */
export function bandMidpoint(dial: TunableDial): number {
  return (dial.floor + dial.ceiling) / 2;
}

/**
 * The performance-implied weight an analyst's record argues for — the target
 * a cycle steps TOWARD, never lands on (guardrails.ts caps the step).
 *
 * Mean credit per trade (an expectancy in R-space, unbounded on both sides)
 * is squashed through `tanh` onto the dial's hard band. `tanh` is chosen for
 * two properties the band needs: it is monotonic, so a better record never
 * implies a lower weight, and it saturates, so an extreme R cannot imply a
 * target outside the human-set floor/ceiling. Zero mean credit — a genuinely
 * even record — implies the band's midpoint.
 *
 * Analysts with no trades in the window are absent from `credits` and are
 * therefore never targeted: no evidence, no move.
 */
export function impliedWeight(credit: AnalystCredit, dial: TunableDial): number {
  const meanCredit = credit.total_credit / credit.trade_count;
  const halfBand = (dial.ceiling - dial.floor) / 2;
  return bandMidpoint(dial) + halfBand * Math.tanh(meanCredit);
}
