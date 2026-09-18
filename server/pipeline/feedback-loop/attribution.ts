import type { ClosedTrade, DebateLogStore } from '../../shared/index.js';
import type { AnalystContribution, Direction } from '../debate-engine/index.js';
import { getContributionsForAttribution } from './debate-attribution-lookup.js';
import type { TunableDial } from './types.js';

export interface AnalystCredit {
  analyst_id: string;
  total_credit: number;
  trade_count: number;
}

export function realizedR(trade: ClosedTrade): number | null {
  const initialRisk = Math.abs(trade.entry - trade.stop) * trade.filled_size;
  if (initialRisk === 0) {
    return null;
  }
  return trade.realized_pnl_net / initialRisk;
}

function tradeDirection(side: ClosedTrade['side']): Direction {
  return side === 'buy' ? 'bullish' : 'bearish';
}

function stanceAgreement(stance: Direction, direction: Direction): number {
  if (stance === 'neutral') {
    return 0;
  }
  return stance === direction ? 1 : -1;
}

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

export function bandMidpoint(dial: TunableDial): number {
  return (dial.floor + dial.ceiling) / 2;
}

export function impliedWeight(credit: AnalystCredit, dial: TunableDial): number {
  const meanCredit = credit.total_credit / credit.trade_count;
  const halfBand = (dial.ceiling - dial.floor) / 2;
  return bandMidpoint(dial) + halfBand * Math.tanh(meanCredit);
}
