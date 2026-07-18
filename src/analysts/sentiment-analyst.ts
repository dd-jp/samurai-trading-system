/**
 * Sentiment analyst persona (ticket #71) — see docs/specs/analysts-spec.md
 * "Module: Analyst Roles & Input Model": primary = social signals (Market
 * Intelligence); context = contemporaneous price/volume, to normalize crowd
 * sentiment against actual market movement. Optional; applies to both
 * crypto and stocks.
 *
 * A stateless pure function of its `AnalystInput`, mirroring
 * technical-analyst.ts and fundamental-analyst.ts: a deterministic rule
 * over the primary/context inputs, not an LLM call.
 */

import type { AnalystView, Direction } from '../debate-engine/index.js';
import type { BarWindow } from '../market-data-service/types.js';
import type { IntelligenceItem } from '../market-intelligence/index.js';
import type { Analyst, AnalystInput, AssetClass } from './types.js';

/** 24h social context window, matching technical-analyst's always-on context frame. */
const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONTEXT_TIMEFRAME = '1h';
const CONTEXT_CANDLE_LOOKBACK = 20;

function directionFrom(items: IntelligenceItem[]): Direction {
  if (items.length === 0) {
    return 'neutral';
  }
  const netSentiment = items.reduce((sum, item) => sum + item.sentiment, 0) / items.length;
  if (netSentiment > 0) {
    return 'bullish';
  }
  if (netSentiment < 0) {
    return 'bearish';
  }
  return 'neutral';
}

/** Average item confidence, clamped to [0.05, 0.95]; no social items this window reads as low confidence. */
function confidenceFrom(items: IntelligenceItem[]): number {
  if (items.length === 0) {
    return 0.05;
  }
  const avg = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
  return Math.min(0.95, Math.max(0.05, avg));
}

export const sentimentAnalyst: Analyst = {
  analyst_type: 'sentiment',
  role: 'optional',

  applies_to(_asset_class: AssetClass): boolean {
    return true;
  },

  async run(input: AnalystInput): Promise<AnalystView> {
    const { signal, clock } = input;
    const asOf = clock.now();
    const contextWindow: BarWindow = {
      timeframe: CONTEXT_TIMEFRAME,
      lookback: CONTEXT_CANDLE_LOOKBACK,
    };

    const [marketContext, candles] = await Promise.all([
      input.market_intelligence.getContext(
        signal.asset_class,
        MI_CONTEXT_WINDOW_MS,
        input.trace_id,
      ),
      input.market_data.getBars(signal.asset, contextWindow, asOf),
    ]);

    const direction = directionFrom(marketContext.social);
    const confidence = confidenceFrom(marketContext.social);
    const avgVolume =
      candles.length === 0
        ? 0
        : candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length;

    return {
      trace_id: input.trace_id,
      analyst_id: 'sentiment',
      analyst_type: 'sentiment',
      direction,
      confidence,
      key_points: [
        `${marketContext.social.length} social items in window, net sentiment driving ${direction}`,
        `Context: ${candles.length} candles, avg volume ${avgVolume}`,
      ],
      timestamp: asOf,
    };
  },
};
