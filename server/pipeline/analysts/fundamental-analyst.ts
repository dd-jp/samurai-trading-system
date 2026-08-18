/**
 * Fundamental analyst persona (ticket #71) — see docs/specs/analysts-spec.md
 * "Module: Analyst Roles & Input Model": primary = earnings/SEC filings/news
 * (Market Intelligence); context = contemporaneous price reaction (always).
 * Mandatory, stocks-only — no earnings/SEC data exists for crypto.
 *
 * A stateless pure function of its `AnalystInput`, mirroring
 * technical-analyst.ts: no module-level mutable state, no wall-clock reads.
 * Reasoning is a deterministic rule over the primary/context inputs, not an
 * LLM call — model tier selection is explicitly out of scope for this spec
 * ("Out of Scope: LLM Selection & Prompt Engineering").
 */

import type { IntelligenceItem } from '../../providers/market-intelligence/index.js';
import type { AnalystView, Direction } from '../debate-engine/index.js';
import type { Analyst, AnalystInput, AssetClass } from './types.js';
import { NO_DATA_MARKER } from './types.js';

/** 24h news context window, matching technical-analyst's always-on context frame. */
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

/** Average item confidence, clamped to [0.05, 0.95]; no news this window reads as low confidence. */
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

    const [marketContext, mark] = await Promise.all([
      input.market_intelligence.getContext(
        signal.asset_class,
        MI_CONTEXT_WINDOW_MS,
        input.trace_id,
        input.bar,
      ),
      input.market_data.getMark(signal.asset, asOf),
    ]);

    const direction = directionFrom(marketContext.news);
    const confidence = confidenceFrom(marketContext.news);

    return {
      trace_id: input.trace_id,
      analyst_id: 'fundamental',
      analyst_type: 'fundamental',
      direction,
      confidence,
      key_points: [
        // #436, and this one matters more than sentiment's: `fundamental` is
        // MANDATORY for stocks in the spec, so an equity debate runs 1 real
        // analyst of 3 while this returns a constant. ADR-0007 removed the
        // human approval gate, so nobody downstream catches it either. The
        // marker at least makes the debate — and the audit trail — state that
        // the input was absent rather than unremarkable.
        marketContext.news.length === 0
          ? `${NO_DATA_MARKER}: no news or filing items available for this window — the market-intelligence store returned nothing, so this is an ABSENCE OF INPUT, not a neutral read of the fundamentals. Weight it accordingly.`
          : `${marketContext.news.length} news/filing items in window, net sentiment driving ${direction}`,
        `Price reaction context: mark=${mark.price} observed ${mark.observed_at.toISOString()}`,
      ],
      timestamp: asOf,
    };
  },
};
