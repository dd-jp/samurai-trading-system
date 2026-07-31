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
import type { AnalystContribution, Direction } from '../debate-engine/index.js';
import type { ClosedTrade, DebateLogStore } from '../shared/index.js';
import { getContributionsForAttribution } from './debate-attribution-lookup.js';
import type { FeedbackConfig, TunableDial } from './types.js';

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
 * Signed, influence-weighted credit one analyst earns from one trade.
 *
 * `agreement × R` is the "was it right" term: backing a winner (+1 × +R) and
 * opposing a loser (−1 × −R) both come out positive. Scaling by
 * `influence_score` is the "did it drive the outcome" term.
 *
 * Shadow credit (spec story 3) adds a small extra term when the analyst was
 * right but too quiet to sway the debate, so a quietly-correct analyst can
 * climb back instead of being pinned by its own low influence. It is
 * upside-only: being quietly WRONG is already punished lightly by the low
 * influence weight, and double-penalising it would drive such an analyst to
 * the floor and keep it there.
 */
export function creditForContribution(
  contribution: AnalystContribution,
  r: number,
  direction: Direction,
  config: Pick<FeedbackConfig, 'shadow_credit' | 'shadow_influence_ceiling'>,
): number {
  const agreement = stanceAgreement(contribution.final_position, direction);
  if (agreement === 0) {
    return 0;
  }

  const correctness = agreement * r;
  const influenceCredit = contribution.influence_score * correctness;

  const wasRight = correctness > 0;
  const wasQuiet = contribution.influence_score <= config.shadow_influence_ceiling;
  const shadowCredit = wasRight && wasQuiet ? config.shadow_credit * correctness : 0;

  return influenceCredit + shadowCredit;
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
  config: Pick<FeedbackConfig, 'shadow_credit' | 'shadow_influence_ceiling'>,
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
      existing.total_credit += creditForContribution(contribution, r, direction, config);
      existing.trade_count += 1;
      credits.set(contribution.analyst_id, existing);
    }
  }

  return credits;
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
  const midpoint = (dial.floor + dial.ceiling) / 2;
  const halfBand = (dial.ceiling - dial.floor) / 2;
  return midpoint + halfBand * Math.tanh(meanCredit);
}
