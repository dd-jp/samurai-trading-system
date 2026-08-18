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

import type { Bar } from '../../providers/market-data-service/index.js';
import { computeIndicator } from '../../providers/market-data-service/index.js';

export interface ProxyStrategyConfig {
  fastWindow: number;
  slowWindow: number;
  atrWindow: number;
  atrStopMult: number;
  atrTargetMult: number;
  allowShort: boolean;
}

export interface ProxySignal {
  direction: 'long' | 'short' | 'flat';
  stop: number;
  target: number;
}

/**
 * `bars` must be ascending by `close_time` and contain at least
 * `max(fastWindow, slowWindow, atrWindow + 1)` entries ending at the bar
 * being evaluated — the same "lookback + 1 for ATR" convention
 * `trader/decide.ts` already uses, since `computeIndicator`'s `atr` case
 * seeds from the start of whatever window it is given.
 */
/**
 * The timeframe every spec in this module describes (#315).
 *
 * Stage 2's whole universe is ingested as daily aggregates. Descriptive rather
 * than selecting: `computeIndicator` runs on a slice the caller already holds,
 * so the field records WHICH bars these are instead of choosing them.
 */
const REPLAY_TIMEFRAME = '1d';

export function proxySignal(bars: readonly Bar[], config: ProxyStrategyConfig): ProxySignal {
  const fastSma = computeIndicator(bars.slice(-config.fastWindow) as Bar[], {
    indicator: 'sma',
    params: {},
    timeframe: REPLAY_TIMEFRAME,
    lookback: config.fastWindow,
  });
  const slowSma = computeIndicator(bars.slice(-config.slowWindow) as Bar[], {
    indicator: 'sma',
    params: {},
    timeframe: REPLAY_TIMEFRAME,
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

  // Always exactly `atrWindow + 1` bars in (per the module doc comment
  // above), so this is a plain re-seeded mean of the trailing true ranges,
  // never a converged Wilder recurrence — see the fuller note on the
  // matching call in `replay-driver.ts`'s `marketState` (#836/#289 H11).
  const atrValue = computeIndicator(bars.slice(-(config.atrWindow + 1)) as Bar[], {
    indicator: 'atr',
    params: {},
    timeframe: REPLAY_TIMEFRAME,
    lookback: config.atrWindow,
  });

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
