import type { BarWindow } from '../../providers/market-data-service/index.js';
import { resolveMiSubject } from '../../providers/universe-pool/index.js';
import type { AnalystView } from '../debate-engine/index.js';
import { confidenceFrom, directionFrom } from './intelligence-scoring.js';
import type { Analyst, AnalystInput, AssetClass } from './types.js';
import { NO_DATA_MARKER } from './types.js';

const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONTEXT_TIMEFRAME = '1h';
const CONTEXT_CANDLE_LOOKBACK = 20;

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
