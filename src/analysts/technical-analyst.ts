/**
 * Technical analyst persona (ticket #70) — see docs/specs/analysts-spec.md
 * "Module: Analyst Roles & Input Model": primary = price/indicators (Market
 * Data Service); context = last-N-candles + volume (always). Mandatory,
 * applies to both crypto and stocks (Technical never sits out an asset
 * class, unlike Fundamental).
 *
 * A stateless pure function of its `AnalystInput` — no module-level mutable
 * state, no wall-clock reads, no caching. Rolling features (SMA/RSI) are
 * computed by the Market Data Service, never here (analysts-spec.md
 * "analysts stay stateless ... never compute or cache them myself").
 *
 * Reasoning is a deterministic indicator rule, not an LLM call: which model
 * fills the "cheap/fast" tier is explicitly out of scope for this spec
 * ("Module: Backtesting Replay" / "Out of Scope: LLM Selection & Prompt
 * Engineering"), and the AC requires byte-identical output from identical
 * inputs, which a real LLM call would not guarantee.
 */

import type { AnalystView, Direction } from '../debate-engine/index.js';
import type { BarWindow, IndicatorSpec } from '../market-data-service/index.js';
import type { Analyst, AnalystInput, AssetClass } from './types.js';

const INDICATOR_TIMEFRAME = '1h';
const INDICATOR_LOOKBACK = 14;
const CONTEXT_CANDLE_LOOKBACK = 20;
/** 24h news/sentiment context window, matching the always-on context frame. */
const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

const SMA_SPEC: IndicatorSpec = { indicator: 'sma', params: {}, lookback: INDICATOR_LOOKBACK };
const RSI_SPEC: IndicatorSpec = { indicator: 'rsi', params: {}, lookback: INDICATOR_LOOKBACK };

/** RSI above this alongside a rising close is treated as overbought, not confirming bullish. */
const RSI_OVERBOUGHT = 70;
/** RSI below this alongside a falling close is treated as oversold, not confirming bearish. */
const RSI_OVERSOLD = 30;

function directionFrom(lastClose: number, sma: number, rsi: number): Direction {
  if (lastClose > sma && rsi < RSI_OVERBOUGHT) {
    return 'bullish';
  }
  if (lastClose < sma && rsi > RSI_OVERSOLD) {
    return 'bearish';
  }
  return 'neutral';
}

/** Distance of RSI from its 50 midpoint, normalized to confidence in [0.05, 0.95]. */
function confidenceFrom(rsi: number): number {
  const distance = Math.abs(rsi - 50) / 50;
  return Math.min(0.95, Math.max(0.05, distance));
}

export const technicalAnalyst: Analyst = {
  analyst_type: 'technical',
  role: 'mandatory',

  applies_to(_asset_class: AssetClass): boolean {
    return true;
  },

  async run(input: AnalystInput): Promise<AnalystView> {
    const { signal, clock } = input;
    const asOf = clock.now();
    const contextWindow: BarWindow = {
      timeframe: INDICATOR_TIMEFRAME,
      lookback: CONTEXT_CANDLE_LOOKBACK,
    };

    const [candles, sma, rsi, marketContext] = await Promise.all([
      input.market_data.getBars(signal.asset, contextWindow, asOf),
      input.market_data.getIndicator(signal.asset, SMA_SPEC, asOf),
      input.market_data.getIndicator(signal.asset, RSI_SPEC, asOf),
      input.market_intelligence.getContext(
        signal.asset_class,
        MI_CONTEXT_WINDOW_MS,
        input.trace_id,
      ),
    ]);

    const lastCandle = candles.at(-1);
    if (!lastCandle) {
      throw new Error(`No bars for ${signal.asset} at or before ${asOf.toISOString()}`);
    }

    const direction = directionFrom(lastCandle.close, sma.value, rsi.value);
    const confidence = confidenceFrom(rsi.value);
    const avgVolume = candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length;

    return {
      trace_id: input.trace_id,
      analyst_id: 'technical',
      analyst_type: 'technical',
      direction,
      confidence,
      key_points: [
        `Last close ${lastCandle.close} vs SMA(${INDICATOR_LOOKBACK})=${sma.value}`,
        `RSI(${INDICATOR_LOOKBACK})=${rsi.value}`,
        `Context: ${candles.length} candles, avg volume ${avgVolume}`,
        `MI context: ${marketContext.news.length} news, ${marketContext.social.length} social items in window`,
      ],
      timestamp: asOf,
    };
  },
};
