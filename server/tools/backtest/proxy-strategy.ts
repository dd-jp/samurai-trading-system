/**
 * Mechanical proxy strategy (ticket #242) — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Mechanical Proxy
 * Strategy") and wayfinder map #154 decision #156.
 *
 * Stands in for the live LLM debate pipeline during Stage 2 validation: a
 * deterministic dual-SMA crossover with ATR-sized stop/target. Not a
 * candidate live strategy — it exists solely so Stage 2 validates the
 * backtest harness against a known, inspectable rule instead of an opaque
 * LLM debate.
 *
 * Entry is **level-based**, not edge-triggered: this function reports which
 * direction the trend currently favors (or 'flat' if neither SMA leads, or
 * the favored side is short but `allowShort` is false) on every bar. The
 * caller (the replay driver, #243) decides whether to act on it — it enters
 * only when it is *currently flat itself*, not merely because the signal
 * flipped this bar. That split (this module reports the trend; the driver
 * owns position state) keeps this function pure.
 */

import type { Bar, IndicatorSpec } from '../../providers/market-data-service/index.js';
import {
  computeIndicator,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';

export interface ProxyStrategyConfig {
  fastWindow: number;
  slowWindow: number;
  atrWindow: number;
  atrStopMult: number;
  atrTargetMult: number;
  allowShort: boolean;
}

/**
 * The replay's ATR spec, at the CONVERGED warm-up (#857).
 *
 * Until #857 both backtest ATR call sites built this spec inline with
 * `params: {}` and `lookback: config.atrWindow`, and fed it exactly
 * `bars.slice(-(config.atrWindow + 1))`. `periodOf` falls back to
 * `spec.lookback` when `params.period` is absent, so the period was
 * `atrWindow` and the true-range array was exactly `atrWindow` long —
 * `trueRanges.slice(period)` was ALWAYS empty and `atr()`'s Wilder smoothing
 * loop ran ZERO times. Every backtest ATR reading was the plain re-seeded mean
 * of the trailing true ranges, the same "seed-and-never-fold" shape #722 fixed
 * for `RSI_SPEC` and #757 for the two live ATR specs. #836 found it and
 * correctly declined to fix it inside a perf-only ticket.
 *
 * That left `computeIndicator({ indicator: 'atr' })` answering two different
 * formulas depending on caller — converged for the live registry callers,
 * seed-only here — which is what this spec removes. Measured cost of the
 * change: `docs/reviews/indicator-characterisation-2026-08-16.md`, F1's
 * backtest half.
 *
 * `params.period` is pinned EXPLICITLY rather than left to the
 * `params.period ?? spec.lookback` fallback. With `lookback` now carrying the
 * bar-window width, that fallback would silently make this an ATR(57) rather
 * than an ATR(14) with a 57-bar warm-up — a different indicator, not a wider
 * warm-up. `atrIndicatorSpec` (trader/decide.ts) pins it for the same reason
 * and records the off-by-one having shipped once already (`0281a8c`).
 *
 * `timeframe` is DESCRIPTIVE, exactly as in `proxySignal` — see its comment.
 */
export function proxyAtrSpec(config: ProxyStrategyConfig, timeframe: string): IndicatorSpec {
  const floor: IndicatorSpec = {
    indicator: 'atr',
    params: { period: config.atrWindow },
    timeframe,
    lookback: config.atrWindow + 1,
  };
  return { ...floor, lookback: recommendedWarmupFor(floor) };
}

/**
 * Bars a caller must hold before `proxySignal` answers a genuine value (#857).
 *
 * THREE sites have to agree on this width or the convergence above is
 * partially inert, and they now all derive from this one function:
 * `proxySignal`'s own ATR slice, `ReplayDriver.marketState`'s slice, and —
 * the one that decides whether either slice can ever be full —
 * `ReplayDriver.run`'s warm-up gate, which skips a step whose visible prefix
 * is shorter than this. Widening the two slices while leaving the gate on
 * `atrWindow + 1` would hand a 15-bar prefix to a 57-bar slice and quietly
 * compute the seed again on every early step.
 *
 * That is exactly the trap #722 hit with `WARM_START_WINDOWS` (a spec widened,
 * a warm-start store not) and #757 hit with `decide.ts` (a spec widened, a
 * literal `atr_lookback + 1` fetch not). Stated once, derived everywhere.
 */
export function proxyWarmupBars(config: ProxyStrategyConfig, timeframe: string): number {
  return Math.max(config.fastWindow, config.slowWindow, proxyAtrSpec(config, timeframe).lookback);
}

export interface ProxySignal {
  direction: 'long' | 'short' | 'flat';
  stop: number;
  target: number;
}

/**
 * `bars` must be ascending by `close_time` and contain at least
 * `proxyWarmupBars(config, timeframe)` entries ending at the bar being
 * evaluated. That was `max(fastWindow, slowWindow, atrWindow + 1)` until #857
 * — the ATR arity FLOOR, which made the Wilder smoothing loop unreachable;
 * it is now the converged ATR warm-up, matching what `trader/decide.ts`
 * fetches on the live path since #757. A shorter window still returns a
 * number rather than erroring, so the caller's gate is what makes this real.
 */
/**
 * `timeframe` is the timeframe the caller's `bars` are on (#664).
 *
 * It was a module constant `REPLAY_TIMEFRAME = '1d'` until then, justified by
 * "Stage 2's whole universe is ingested as daily aggregates" (#315). ADR-0014
 * moved the product to an intraday, flat-by-close horizon, so that premise is
 * gone and the value is the caller's to state.
 *
 * It remains DESCRIPTIVE rather than selecting: `computeIndicator` runs on a
 * slice the caller already holds, so the field records WHICH bars these are
 * instead of choosing them. That is precisely why a constant is not good
 * enough — a `'1d'` label on minute bars is a false record and nothing
 * downstream would catch it. `ReplayDriver` checks the value against
 * `Bar.timeframe` before any of this runs.
 */
export function proxySignal(
  bars: readonly Bar[],
  config: ProxyStrategyConfig,
  timeframe: string,
): ProxySignal {
  const fastSma = computeIndicator(bars.slice(-config.fastWindow) as Bar[], {
    indicator: 'sma',
    params: {},
    timeframe,
    lookback: config.fastWindow,
  });
  const slowSma = computeIndicator(bars.slice(-config.slowWindow) as Bar[], {
    indicator: 'sma',
    params: {},
    timeframe,
    lookback: config.slowWindow,
  });

  const favored: 'long' | 'short' | 'flat' =
    fastSma > slowSma ? 'long' : fastSma < slowSma ? 'short' : 'flat';

  const lastBar = bars[bars.length - 1];
  if (lastBar === undefined) {
    throw new Error('proxySignal: bars must not be empty.');
  }
  const lastClose = lastBar.close;

  if (favored === 'flat' || (favored === 'short' && !config.allowShort)) {
    return { direction: 'flat', stop: lastClose, target: lastClose };
  }

  // The CONVERGED window (#857), sliced from the spec's own lookback rather
  // than from a literal, so this and `replay-driver.ts`'s matching call and
  // its warm-up gate cannot drift apart. It was `slice(-(atrWindow + 1))`
  // until #857 — see `proxyAtrSpec`
  const atrSpec = proxyAtrSpec(config, timeframe);
  const atrValue = computeIndicator(bars.slice(-atrSpec.lookback) as Bar[], atrSpec);

  return favored === 'long'
    ? {
        direction: 'long',
        stop: lastClose - atrValue * config.atrStopMult,
        target: lastClose + atrValue * config.atrTargetMult,
      }
    : {
        direction: 'short',
        stop: lastClose + atrValue * config.atrStopMult,
        target: lastClose - atrValue * config.atrTargetMult,
      };
}
