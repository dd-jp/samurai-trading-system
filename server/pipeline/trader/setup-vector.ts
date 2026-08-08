/**
 * The setup embedding the cosine layer retrieves against (#432, trader-spec.md
 * story 12: "embed each setup as a combined vector of debate features +
 * market-regime features, so that I match 'this kind of debate in this kind of
 * market'").
 *
 * #75 built retrieval and #73 built sizing, but neither built the vector — so
 * `decide()` had no way to query the store and hardcoded the no-precedent
 * default instead. This is that missing piece.
 *
 * Every feature is deliberately UNITLESS and O(1)-scaled. Cosine similarity is
 * scale-sensitive: mixing a raw ATR in dollars (10^4 for BTC, 10^0 for a penny
 * stock) with a 0-1 conviction would make the vector a pure price-level
 * detector, and BTC would never match AAPL however alike the setups were.
 * Dividing the price-unit features by `entry` is what makes a cross-instrument
 * neighbor search meaningful at all.
 */

import type { Bar } from '../../providers/market-data-service/index.js';
import type { SetupVector } from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';

/** The priced context `decide()` has already computed by embedding time. */
export interface SetupMarketContext {
  /** Mark price at the decision bar. Must be finite and non-zero. */
  entry: number;
  /** ATR over `config.atr_lookback`, in price units. */
  atr: number;
  /** `atr_k x max(ATR, vol_floor)` — carries whether the floor was engaged. */
  stopDistance: number;
  /** The same window ATR was computed from, ascending by close_time. */
  bars: Bar[];
}

/**
 * Share of analysts still pointing somewhere other than the debate's final
 * direction — the structured stand-in for trader-spec.md's "disagreement
 * magnitude". `disagreement_summary` is free text and the Trader has no LLM to
 * read it with; `contributions[].final_position` says the same thing in a
 * number. 0 when the debate carried no contributions.
 */
function disagreementMagnitude(debate: DebateResult): number {
  const total = debate.contributions.length;
  if (total === 0) return 0;
  const dissenting = debate.contributions.filter(
    (contribution) => contribution.final_position !== debate.direction,
  ).length;
  return dissenting / total;
}

/**
 * Fractional move across the ATR window: the regime feature that separates
 * "bullish debate in an uptrend" from "bullish debate against a downtrend".
 * Returns 0 rather than Infinity on a zero/absent first close — an
 * unusable trend reading must not poison every other feature via the
 * vector norm.
 */
function trendOver(bars: Bar[]): number {
  const first = bars[0]?.close;
  const last = bars[bars.length - 1]?.close;
  if (first === undefined || last === undefined || !Number.isFinite(first) || first === 0) {
    return 0;
  }
  const trend = (last - first) / first;
  return Number.isFinite(trend) ? trend : 0;
}

/**
 * Embeds the decision as `{debate_features, market_features}`.
 *
 * Feature ORDER is load-bearing and must never be reordered or extended in the
 * middle: `cosineSimilarity` compares by index against vectors written by
 * earlier runs and stored in `cosine_setups`. Changing the layout silently
 * re-interprets every historical row rather than failing — append only, and
 * treat a layout change as a store migration.
 */
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
      // Volatility as a fraction of price — the "volatility bucket", left
      // continuous rather than bucketed so near-identical regimes stay near
      // each other in cosine space instead of snapping to bucket edges.
      atr / entry,
      trendOver(bars),
      // Stop width as a fraction of price. Equals `atr_k x (atr/entry)` unless
      // the vol floor was engaged, so it is exactly the feature that tells a
      // floored (ultra-low-vol) setup apart from a genuinely quiet one.
      stopDistance / entry,
    ],
  };
}
