/**
 * Deterministic technical-indicator computation (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Indicators):
 * "a vetted TA computation with fixed rounding; no floating nondeterminism."
 * Computed here — never inside analysts — so analysts stay stateless.
 */
import type { Bar, IndicatorSpec } from './types.js';

/** Fixed rounding so repeated computations are byte-identical. */
const ROUNDING_PRECISION = 8;

function round(value: number): number {
  return Number(value.toFixed(ROUNDING_PRECISION));
}

function closes(bars: Bar[]): number[] {
  return bars.map((bar) => bar.close);
}

function sma(values: number[], period: number): number {
  const window = values.slice(-period);
  const sum = window.reduce((acc, value) => acc + value, 0);
  return sum / window.length;
}

function ema(values: number[], period: number): number {
  const seedWindow = values.slice(0, period);
  const smoothing = 2 / (period + 1);
  let emaValue = seedWindow.reduce((acc, value) => acc + value, 0) / seedWindow.length;

  for (const value of values.slice(period)) {
    emaValue = value * smoothing + emaValue * (1 - smoothing);
  }

  return emaValue;
}

/** Pairwise differences: [values[1]-values[0], values[2]-values[1], ...]. */
function diffs(values: number[]): number[] {
  const result: number[] = [];
  let previous: number | undefined;
  for (const value of values) {
    if (previous !== undefined) {
      result.push(value - previous);
    }
    previous = value;
  }
  return result;
}

function rsi(values: number[], period: number): number {
  const changes = diffs(values);
  const seedChanges = changes.slice(0, period);

  let avgGain =
    seedChanges.filter((change) => change > 0).reduce((acc, change) => acc + change, 0) / period;
  let avgLoss =
    seedChanges.filter((change) => change < 0).reduce((acc, change) => acc - change, 0) / period;

  for (const change of changes.slice(period)) {
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(bars: Bar[], period: number): number {
  const trueRanges: number[] = [];
  let previousClose: number | undefined;
  for (const current of bars) {
    if (previousClose !== undefined) {
      trueRanges.push(
        Math.max(
          current.high - current.low,
          Math.abs(current.high - previousClose),
          Math.abs(current.low - previousClose),
        ),
      );
    }
    previousClose = current.close;
  }

  const seedRanges = trueRanges.slice(0, period);
  let atrValue = seedRanges.reduce((acc, range) => acc + range, 0) / seedRanges.length;

  for (const range of trueRanges.slice(period)) {
    atrValue = (atrValue * (period - 1) + range) / period;
  }

  return atrValue;
}

/**
 * Computes `spec.indicator` deterministically over `bars` — a close-time-
 * filtered, ascending-by-close_time window whose length is the pinned
 * `spec.lookback`. `params.period` selects the indicator's own window
 * within that lookback (defaults to the full lookback for sma/ema/rsi).
 */
export function computeIndicator(bars: Bar[], spec: IndicatorSpec): number {
  const period = spec.params.period ?? spec.lookback;

  switch (spec.indicator) {
    case 'sma':
      return round(sma(closes(bars), period));
    case 'ema':
      return round(ema(closes(bars), period));
    case 'rsi':
      return round(rsi(closes(bars), period));
    case 'atr':
      return round(atr(bars, period));
    default:
      throw new Error(`Unsupported indicator: ${spec.indicator}`);
  }
}
