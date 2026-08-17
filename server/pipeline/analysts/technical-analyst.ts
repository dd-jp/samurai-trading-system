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

import {
  type BarWindow,
  type IndicatorSpec,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';
import type { AnalystView, Direction } from '../debate-engine/index.js';
import type { Analyst, AnalystInput, AssetClass } from './types.js';

/**
 * Issue #742: the technical read moves from 1h to 5m. At period 14, a 1h
 * SMA/RSI is a 2.3-session lookback on a position that must be flat by
 * close (ADR-0014) — a signal about a different holding period than the one
 * being traded. 1h is retained separately, below, as always-on CONTEXT
 * (`CONTEXT_TIMEFRAME`), not as an input to direction/confidence.
 *
 * Deliberately NOT moved in this change (per #742): `trader/decide.ts`'s
 * `atrIndicatorSpec` timeframe (`TraderConfig.atr_timeframe`) and
 * `production/defaults.ts`'s `DEFAULT_VOLATILITY_INDICATOR`. Those feed the
 * stop and halt paths; bundling them would make this signal-horizon
 * experiment inseparable from a risk-parameter change.
 */
const INDICATOR_TIMEFRAME = '5m';
/** 1h read retained as context only — never feeds direction/confidence. */
const CONTEXT_TIMEFRAME = '1h';
const INDICATOR_LOOKBACK = 14;
const CONTEXT_CANDLE_LOOKBACK = 20;
/** 24h news/sentiment context window, matching the always-on context frame. */
const MI_CONTEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one shared 5m warm-up every 5m spec below (`SMA_SPEC`, `RSI_SPEC`)
 * relies on. `run()` fetches this window FIRST and awaits it, so the store
 * holds >= this many 5m bars before `SMA_SPEC`/`RSI_SPEC` are requested;
 * both specs' own (smaller) lookbacks are then served by
 * `MarketDataServiceImpl`'s `cachedBars` route 1 (same instrument+timeframe,
 * already fetched this bar interval) instead of issuing their own source
 * fetches — one fetch and one store read per tick, not one per indicator.
 *
 * 260 comfortably covers `RSI_SPEC`'s own lookback (`recommendedWarmupFor`
 * on period 14 = 57 bars) with margin, so a live instrument's ordinary warm
 * store never falls through to a second fetch. The 1m-fetch "large limit"
 * warning documented in `alpaca-http-client.ts` does not transfer here:
 * that warning is about `DataSource.fetchBars`' own pagination search
 * widening past its buffer at large `limit`, and 260 5m bars is well under
 * a percent of any request budget mentioned there.
 */
export const WARMUP_5M = 260;

/**
 * `sma` reads the closes directly, so an SMA(14) is exactly 14 bars: the
 * `params.period ?? lookback` fallback resolves to 14 and needs no `+ 1`.
 */
export const SMA_SPEC: IndicatorSpec = {
  indicator: 'sma',
  params: {},
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK,
};
/**
 * The ARITY floor this spec used to sit on: `INDICATOR_LOOKBACK + 1`, with
 * `params.period` pinned rather than left to the `?? lookback` fallback — the
 * same shape `trader/decide.ts`'s `atrIndicatorSpec` and `production.ts`'s
 * `DEFAULT_VOLATILITY_INDICATOR` carry, for the same reason. `rsi` consumes
 * the first bar only to seed the previous close, so N bars yield N-1 changes:
 * this used to ask for 14 bars and get an RSI averaged over 13 changes but
 * divided by 14 — presented in `key_points` as "RSI(14)". Issue #319 made that
 * throw instead of lying. Leaving `params` empty and bumping only `lookback`
 * would have silently made this an RSI(15), which is why the period is pinned.
 */
const RSI_FLOOR_SPEC: IndicatorSpec = {
  indicator: 'rsi',
  params: { period: INDICATOR_LOOKBACK },
  timeframe: INDICATOR_TIMEFRAME,
  lookback: INDICATOR_LOOKBACK + 1,
};

/**
 * RSI(14) over a CONVERGED warm-up — `recommendedWarmupFor` = `4 x period + 1`
 * = 57 bars — rather than the `minimumBarsFor` floor of 15 (#722).
 *
 * At the floor, `changes.slice(period)` is empty, so `rsi`'s Wilder smoothing
 * loop ran ZERO times and the value the debate read was the simple-mean seed:
 * Cutler's RSI wearing Wilder's name. That is not an alternative convention,
 * it is a warm-up artefact — the number was a function of where the window
 * happened to start. Measured against a converged 200-bar warm-up on the same
 * bar it moved a median 4.6 RSI points, p90 12.0, and flipped the 70/30
 * overbought/oversold classification on 18% of bars
 * (`docs/reviews/indicator-characterisation-2026-08-16.md` F2). Adopting the
 * recommendation reprices every technical opinion in the system at once; that
 * is a knowing, accepted cost, decided on #722 rather than a side effect.
 *
 * Derived from `recommendedWarmupFor` rather than written as 57, so the spec
 * cannot drift away from the function that justifies it. `minimumBarsFor` is
 * still 15 and is deliberately unchanged: it is the fabrication floor, and a
 * cold instrument that holds only 20 bars still gets a (less-warm) RSI rather
 * than no view at all.
 *
 * Exported for the same reason `atrIndicatorSpec` is (#304): so the goldens and
 * `rsi-warmup.test.ts` pin THIS spec rather than a hand-rebuilt copy that would
 * keep passing if the real one drifted.
 */
export const RSI_SPEC: IndicatorSpec = {
  ...RSI_FLOOR_SPEC,
  lookback: recommendedWarmupFor(RSI_FLOOR_SPEC),
};

/** RSI above this alongside a rising close is treated as overbought, not confirming bullish. */
export const RSI_OVERBOUGHT = 70;
/** RSI below this alongside a falling close is treated as oversold, not confirming bearish. */
export const RSI_OVERSOLD = 30;

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
export function confidenceFrom(rsi: number): number {
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
    const technicalWindow: BarWindow = { timeframe: INDICATOR_TIMEFRAME, lookback: WARMUP_5M };
    const contextWindow: BarWindow = {
      timeframe: CONTEXT_TIMEFRAME,
      lookback: CONTEXT_CANDLE_LOOKBACK,
    };

    // Awaited BEFORE the Promise.all below, on purpose (#742): this is the
    // shared 5m warm-up fetch. SMA_SPEC/RSI_SPEC's own getIndicator calls
    // run concurrently with the (separate-timeframe) context read below, and
    // by then the store already holds >= WARMUP_5M 5m bars for this
    // instrument, so both specs are served from the store instead of each
    // triggering their own DataSource.fetchBars call.
    const technicalBars = await input.market_data.getBars(signal.asset, technicalWindow, asOf);

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

    const lastCandle = technicalBars.at(-1);
    if (!lastCandle) {
      throw new Error(
        `No ${INDICATOR_TIMEFRAME} bars for ${signal.asset} at or before ${asOf.toISOString()}`,
      );
    }

    const direction = directionFrom(lastCandle.close, sma.value, rsi.value);
    const confidence = confidenceFrom(rsi.value);
    // No fallback numeric here on purpose: an empty context read has no
    // volume to average, and reporting "avg volume 0" would be a fabricated
    // claim about the tape, not an approximation (the same fabrication class
    // #319 made computeIndicator throw on rather than silently answer).
    // `direction`/`confidence` never depend on this string, so an absent 1h
    // context degrades the prose only, never the decision.
    const contextLine =
      candles.length === 0
        ? `Context (${CONTEXT_TIMEFRAME}): unavailable`
        : `Context (${CONTEXT_TIMEFRAME}): ${candles.length} candles, avg volume ${candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length}`;

    return {
      trace_id: input.trace_id,
      analyst_id: 'technical',
      analyst_type: 'technical',
      direction,
      confidence,
      key_points: [
        `Last close ${lastCandle.close} vs SMA(${INDICATOR_LOOKBACK})=${sma.value}`,
        `RSI(${INDICATOR_LOOKBACK})=${rsi.value}`,
        contextLine,
        `MI context: ${marketContext.news.length} news, ${marketContext.social.length} social items in window`,
      ],
      timestamp: asOf,
    };
  },
};
