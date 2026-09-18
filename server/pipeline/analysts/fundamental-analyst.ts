
import type { IntelligenceItem } from '../../providers/market-intelligence/index.js';
import { resolveMiSubject } from '../../providers/universe-pool/index.js';
import type { AnalystView, Direction } from '../debate-engine/index.js';
import type { Analyst, AnalystInput, AssetClass } from './types.js';
import { NO_DATA_MARKER } from './types.js';

const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

export const fundamentalAnalyst: Analyst = {
  analyst_type: 'fundamental',
  role: 'mandatory',

  applies_to(asset_class: AssetClass): boolean {
    return asset_class === 'stocks';
  },

  async run(input: AnalystInput): Promise<AnalystView> {
    const { signal, clock } = input;
    const asOf = clock.now();

    const miSubject = resolveMiSubject(signal.asset);

    const [marketContext, mark] = await Promise.all([
      input.market_intelligence.getContext(
        signal.asset_class,
        MI_CONTEXT_WINDOW_MS,
        input.trace_id,
        input.bar,
        miSubject,
      ),
      input.market_data.getMark(signal.asset, asOf),
    ]);

    const evidence = [...marketContext.news, ...marketContext.intel];
    const direction = directionFrom(evidence);
    const confidence = confidenceFrom(evidence);

    return {
      trace_id: input.trace_id,
      analyst_id: 'fundamental',
      analyst_type: 'fundamental',
      direction,
      confidence,
      key_points: [
        evidence.length === 0
          ? `${NO_DATA_MARKER}: no news, filing or intel items available for this window — the market-intelligence store returned nothing, so this is an ABSENCE OF INPUT, not a neutral read of the fundamentals. Weight it accordingly.`
          : `${marketContext.news.length} news/filing items, ${marketContext.intel.length} intel items in window, net sentiment driving ${direction}`,
        `Price reaction context: mark=${mark.price} observed ${mark.observed_at.toISOString()}`,
      ],
      timestamp: asOf,
    };
  },
};
