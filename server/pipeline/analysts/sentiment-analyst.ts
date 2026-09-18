
import type { BarWindow } from '../../providers/market-data-service/index.js';
import type { IntelligenceItem } from '../../providers/market-intelligence/index.js';
import { resolveMiSubject } from '../../providers/universe-pool/index.js';
import type { AnalystView, Direction } from '../debate-engine/index.js';
import type { Analyst, AnalystInput, AssetClass } from './types.js';
import { NO_DATA_MARKER } from './types.js';

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

    const miSubject = resolveMiSubject(signal.asset);

    const [marketContext, candles] = await Promise.all([
      input.market_intelligence.getContext(
        signal.asset_class,
        MI_CONTEXT_WINDOW_MS,
        input.trace_id,
        input.bar,
        miSubject,
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
        marketContext.social.length === 0
          ? `${NO_DATA_MARKER}: no social items available for this window — the market-intelligence store returned nothing, so this is an ABSENCE OF INPUT, not a neutral read of the market. Weight it accordingly.`
          : `${marketContext.social.length} social items in window, net sentiment driving ${direction}`,
        `Context: ${candles.length} candles, avg volume ${avgVolume}`,
      ],
      timestamp: asOf,
    };
  },
};
