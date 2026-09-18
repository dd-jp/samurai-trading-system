import type { Bar } from '../../providers/market-data-service/index.js';
import type { SetupVector } from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';

export interface SetupMarketContext {
  entry: number;
  atr: number;
  stopDistance: number;
  bars: Bar[];
}

function disagreementMagnitude(debate: DebateResult): number {
  const total = debate.contributions.length;
  if (total === 0) return 0;
  const dissenting = debate.contributions.filter(
    (contribution) => contribution.final_position !== debate.direction,
  ).length;
  return dissenting / total;
}

function trendOver(bars: Bar[]): number {
  const first = bars[0]?.close;
  const last = bars[bars.length - 1]?.close;
  if (first === undefined || last === undefined || !Number.isFinite(first) || first === 0) {
    return 0;
  }
  const trend = (last - first) / first;
  return Number.isFinite(trend) ? trend : 0;
}

export function buildSetupVector(debate: DebateResult, market: SetupMarketContext): SetupVector {
  const { entry, atr, stopDistance, bars } = market;

  return {
    debate_features: [
      debate.confidence,
      debate.direction === 'bullish' ? 1 : debate.direction === 'bearish' ? -1 : 0,
      debate.converged ? 1 : 0,
      disagreementMagnitude(debate),
    ],
    market_features: [
      atr / entry,
      trendOver(bars),
      stopDistance / entry,
    ],
  };
}
