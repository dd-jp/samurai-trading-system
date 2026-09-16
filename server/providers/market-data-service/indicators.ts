/**
 * Deterministic technical-indicator computation — fixed rounding, no
 * floating nondeterminism (docs/specs/market-data-service-spec.md).
 * Computed here rather than inside analysts, so analysts stay stateless.
 */
import { type Bar, INDICATOR_KINDS, type IndicatorKind, type IndicatorSpec } from './types.js';

/** Fixed rounding so repeated computations are byte-identical */
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

  // A genuinely flat window (every change zero, e.g. a halted or
  // auction-flat bar): the standard `avgLoss === 0 -> 100` branch below
  // would treat 0/0 as maximum strength, so return the neutral 50 instead (#725)
  if (avgGain === 0 && avgLoss === 0) {
    return 50;
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
 * ATR as a percentage of the last close (#744). Scale-dependent — scales
 * by the leverage factor vs the underlying, so a spec comparing the two
 * directly must target one instrument consistently.
 */
function atrPctValue(bars: Bar[], period: number): number {
  const atrValue = atr(bars, period);
  const lastClose = (bars[bars.length - 1] as Bar).close;

  // A 0 close never occurs in this system's universe, but guarding it keeps
  // the "never NaN/Infinity" contract true unconditionally, not just in practice
  if (lastClose === 0) {
    return 0;
  }

  return (atrValue / lastClose) * 100;
}

/**
 * Donchian channel position (#744): last close's fraction in [0, 1]
 * between the window's lowest low (0) and highest high (1)
 */
function donchianPosValue(bars: Bar[], period: number): number {
  const window = bars.slice(-period);
  const highestHigh = Math.max(...window.map((bar) => bar.high));
  const lowestLow = Math.min(...window.map((bar) => bar.low));
  const range = highestHigh - lowestLow;
  const lastClose = (window[window.length - 1] as Bar).close;

  // Zero-range window: no "where in the range" to report, so answer the
  // neutral midpoint 0.5 rather than let NaN propagate (same posture as #725's RSI fix)
  if (range === 0) {
    return 0.5;
  }

  return (lastClose - lowestLow) / range;
}

/**
 * Wilder's ADX (#744) — exposes only the scalar the confidence cap reads.
 * Uses Wilder's accumulation smoothing form for the TR/+DM/-DM smoothers
 * (matching the Python reference `generate-indicator-golden.py`), not
 * `atr()`'s mean form — the two differ by a constant factor that cancels exactly in `DI = 100 * smoothedDM / smoothedTR`.
 */
function adxValue(bars: Bar[], period: number): number {
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trueRanges: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i] as Bar;
    const previous = bars[i - 1] as Bar;
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }

  const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);

  let smoothedTR = sum(trueRanges.slice(0, period));
  let smoothedPlus = sum(plusDM.slice(0, period));
  let smoothedMinus = sum(minusDM.slice(0, period));

  // Zero true range throughout: nothing to divide DI by, so DI+/DI- read 0 rather than NaN
  const diPlus = () => (smoothedTR === 0 ? 0 : (100 * smoothedPlus) / smoothedTR);
  const diMinus = () => (smoothedTR === 0 ? 0 : (100 * smoothedMinus) / smoothedTR);
  // DI+ === DI- === 0: no directional imbalance to report, so DX reads 0 rather than NaN
  const dxFrom = (plus: number, minus: number) =>
    plus + minus === 0 ? 0 : (100 * Math.abs(plus - minus)) / (plus + minus);

  const dxValues: number[] = [dxFrom(diPlus(), diMinus())];

  for (let i = period; i < trueRanges.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + (trueRanges[i] as number);
    smoothedPlus = smoothedPlus - smoothedPlus / period + (plusDM[i] as number);
    smoothedMinus = smoothedMinus - smoothedMinus / period + (minusDM[i] as number);
    dxValues.push(dxFrom(diPlus(), diMinus()));
  }

  const seedDx = dxValues.slice(0, period);
  let adxAverage = sum(seedDx) / seedDx.length;

  for (const dx of dxValues.slice(period)) {
    adxAverage = (adxAverage * (period - 1) + dx) / period;
  }

  return adxAverage;
}

/**
 * MACD histogram (#744): `macdLine - signalLine` as a flat scalar, not a
 * shared `macd` kind — widening `IndicatorValue.value` would touch the
 * cache key, the accessor, and four consumers. `fast`/`slow`/`signal` are
 * all required; none fall back to `spec.lookback` since no one of the three is obviously "the" period.
 */
function macdHistogramValue(bars: Bar[], fast: number, slow: number, signal: number): number {
  const values = closes(bars);

  const emaSeries = (source: number[], period: number): number[] => {
    const smoothing = 2 / (period + 1);
    let value = source.slice(0, period).reduce((acc, point) => acc + point, 0) / period;
    const series = [value];
    for (const point of source.slice(period)) {
      value = point * smoothing + value * (1 - smoothing);
      series.push(value);
    }
    return series;
  };

  // fastSeries[k] is the EMA at values index (fast - 1 + k)
  const fastSeries = emaSeries(values, fast);
  // slowSeries[k] is the EMA at values index (slow - 1 + k)
  const slowSeries = emaSeries(values, slow);

  // MACD line exists only where both EMAs do: from max(fast, slow) - 1 onward
  const macdStart = Math.max(fast, slow) - 1;
  const macdLine: number[] = [];
  for (let index = macdStart; index < values.length; index++) {
    const fastValue = fastSeries[index - (fast - 1)] as number;
    const slowValue = slowSeries[index - (slow - 1)] as number;
    macdLine.push(fastValue - slowValue);
  }

  const signalSmoothing = 2 / (signal + 1);
  let signalValue = macdLine.slice(0, signal).reduce((acc, point) => acc + point, 0) / signal;
  for (const point of macdLine.slice(signal)) {
    signalValue = point * signalSmoothing + signalValue * (1 - signalSmoothing);
  }

  const lastMacd = macdLine[macdLine.length - 1] as number;
  return lastMacd - signalValue;
}

/**
 * Bollinger/Keltner squeeze ratio (#744): `bbWidth / kcWidth`; below 1
 * means the Bollinger Band has narrowed inside the Keltner Channel. Keltner
 * half must reuse `ema`/`atr` over the full window passed in — truncating
 * it to `kc_period + 1` bars would present Cutler's smoothing as Wilder's (the RSI warm-up defect class, see F1/F2).
 */
function bbKcSqueezeValue(
  bars: Bar[],
  bbPeriod: number,
  bbMult: number,
  kcPeriod: number,
  kcMult: number,
): number {
  const values = closes(bars);
  const bbWindow = values.slice(-bbPeriod);
  const mean = bbWindow.reduce((acc, value) => acc + value, 0) / bbPeriod;
  const variance = bbWindow.reduce((acc, value) => acc + (value - mean) ** 2, 0) / bbPeriod;
  const bbWidth = 2 * bbMult * Math.sqrt(variance);

  const kcAtr = atr(bars, kcPeriod);
  const kcWidth = 2 * kcMult * kcAtr;

  // Zero-ATR window: true range being 0 throughout also forces bbWidth to
  // 0, so answer the neutral ratio 1 (bands touching) rather than NaN
  if (kcWidth === 0) {
    return 1;
  }

  return bbWidth / kcWidth;
}

/**
 * Bars must be ascending by close_time — enforced here rather than trusted,
 * since a reversed window would silently feed wrong true-range legs into
 * `atr` and reprice every stop derived from it. Throws rather than sorts:
 * a misordered window means the feed is broken, and repairing it here would hide that from every other consumer.
 */
function assertAscending(bars: Bar[]): void {
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1] as Bar;
    const current = bars[i] as Bar;
    if (current.close_time.getTime() < previous.close_time.getTime()) {
      throw new Error(
        `computeIndicator: bars must be ascending by close_time — ` +
          `${current.close_time.toISOString()} follows ${previous.close_time.toISOString()} ` +
          `at index ${i}. Computing over a misordered window would silently produce a wrong ` +
          'indicator value rather than fail.',
      );
    }
  }
}

/**
 * Raised when a window is too short for its period (#319). Typed rather
 * than a bare `Error` so "window too short" stays distinguishable from
 * `assertAscending`'s "feed is misordered" — the latter must keep
 * propagating rather than be absorbed into a skip.
 */
export class InsufficientBarsError extends Error {
  /** `spec.indicator` — any member of `INDICATOR_KINDS` */
  readonly indicator: string;
  /** The dominant period a human reads as "how deep" — `IndicatorDefinition.reportedPeriod(spec)` (#744) */
  readonly period: number;
  /** Bars this indicator needs before it can produce a genuine `period`-length value */
  readonly required: number;
  /** Bars the window actually held */
  readonly received: number;

  constructor(details: { indicator: string; period: number; required: number; received: number }) {
    super(
      `computeIndicator: ${details.indicator}(${details.period}) needs ${details.required} ` +
        `bars but received ${details.received}. Computing it anyway would present a value ` +
        `derived from ${details.received} bars as a ${details.period}-period one — a ` +
        'fabricated indicator, not a degraded one, and every stop sized from it is mispriced.',
    );
    this.name = 'InsufficientBarsError';
    this.indicator = details.indicator;
    this.period = details.period;
    this.required = details.required;
    this.received = details.received;
  }
}

/**
 * One definition per kind (#703 B2), replacing two parallel `switch`
 * statements — `Record<IndicatorKind, IndicatorDefinition>` makes an
 * omitted kind or arity a compile error instead of a silent mismatch.
 * `minimumBars`/`recommendedWarmup`/`reportedPeriod` are functions of the
 * whole spec, not constants, because #744's multi-parameter kinds have no single period to key off.
 */
interface IndicatorDefinition {
  /** Bars needed for a genuine value — the arity floor `minimumBarsFor` reports */
  readonly minimumBars: (spec: IndicatorSpec) => number;
  /** The warm-up width `recommendedWarmupFor` reports; strictly separate from `minimumBars`'s arity floor */
  readonly recommendedWarmup: (spec: IndicatorSpec) => number;
  /** The figure `InsufficientBarsError.period` reports — `periodOf(spec)` for single-period kinds, else the dominant parameter */
  readonly reportedPeriod: (spec: IndicatorSpec) => number;
  /** Takes the full window; each kind reads what it needs from `spec.params`. Rounding is the caller's. */
  readonly compute: (bars: Bar[], spec: IndicatorSpec) => number;
}

/**
 * Requires `spec.params[name]`, throwing and naming the parameter if
 * absent — unlike `periodOf`'s `spec.lookback` fallback, multi-parameter
 * kinds (`macd_histogram`, `bb_kc_squeeze`) have no single obviously-right default among their several named parameters
 */
function requiredParam(spec: IndicatorSpec, name: string): number {
  const value = spec.params[name];
  if (value === undefined) {
    throw new Error(
      `computeIndicator: ${spec.indicator} requires params.${name}, which was not provided. ` +
        `${spec.indicator} takes multiple named parameters, none of which fall back to ` +
        "spec.lookback or to each other — that fallback is periodOf's convention for " +
        'single-period kinds only, and silently reusing it here has already produced two ' +
        'shipped mislabelling defects (the ATR off-by-one, RSI(13) labelled 14).',
    );
  }
  return value;
}

/** `requiredParam`, additionally rejecting non-positive-integer values (see `periodOf`'s reasoning) */
function requiredIntParam(spec: IndicatorSpec, name: string): number {
  const value = requiredParam(spec, name);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `computeIndicator: ${spec.indicator}'s params.${name} must be a positive integer, got ${value}.`,
    );
  }
  return value;
}

/** `requiredParam`, additionally rejecting non-positive or non-finite values — for multiplier params */
function requiredPositiveParam(spec: IndicatorSpec, name: string): number {
  const value = requiredParam(spec, name);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `computeIndicator: ${spec.indicator}'s params.${name} must be a positive finite number, got ${value}.`,
    );
  }
  return value;
}

const INDICATORS: Record<IndicatorKind, IndicatorDefinition> = {
  sma: {
    minimumBars: (spec) => periodOf(spec),
    recommendedWarmup: (spec) => periodOf(spec),
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => sma(closes(bars), periodOf(spec)),
  },
  ema: {
    minimumBars: (spec) => periodOf(spec),
    recommendedWarmup: (spec) => 4 * periodOf(spec) + 1,
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => ema(closes(bars), periodOf(spec)),
  },
  rsi: {
    minimumBars: (spec) => periodOf(spec) + 1,
    recommendedWarmup: (spec) => 4 * periodOf(spec) + 1,
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => rsi(closes(bars), periodOf(spec)),
  },
  atr: {
    minimumBars: (spec) => periodOf(spec) + 1,
    recommendedWarmup: (spec) => 4 * periodOf(spec) + 1,
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => atr(bars, periodOf(spec)),
  },
  // #744 additions: atr_pct/donchian_pos/adx use periodOf like the kinds
  // above; macd_histogram/bb_kc_squeeze never call it (see requiredParam)
  atr_pct: {
    // Same arity as atr: one seed bar for the predecessor close, plus period
    minimumBars: (spec) => periodOf(spec) + 1,
    recommendedWarmup: (spec) => 4 * periodOf(spec) + 1,
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => atrPctValue(bars, periodOf(spec)),
  },
  donchian_pos: {
    // Windowed like sma: trailing `period` bars only, no seed bar needed
    minimumBars: (spec) => periodOf(spec),
    recommendedWarmup: (spec) => periodOf(spec),
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => donchianPosValue(bars, periodOf(spec)),
  },
  adx: {
    // 2 x period is genuine arity, not a warm-up preference: the first ADX
    // value needs `period` DX readings, each itself needing a period-long
    // smoothed DI — no period-length DX average exists below 2 x period
    minimumBars: (spec) => 2 * periodOf(spec),
    // Beyond the 2x-period arity floor, ADX is doubly Wilder-smoothed, so it
    // gets a further 4 x period convergence margin on top
    recommendedWarmup: (spec) => 2 * periodOf(spec) + 4 * periodOf(spec),
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => adxValue(bars, periodOf(spec)),
  },
  macd_histogram: {
    minimumBars: (spec) => {
      const fast = requiredIntParam(spec, 'fast');
      const slow = requiredIntParam(spec, 'slow');
      const signal = requiredIntParam(spec, 'signal');
      // MACD line exists from max(fast, slow) - 1 onward; the signal EMA
      // then needs `signal` more MACD-line values to seed itself
      return Math.max(fast, slow) + signal - 1;
    },
    recommendedWarmup: (spec) => {
      const fast = requiredIntParam(spec, 'fast');
      const slow = requiredIntParam(spec, 'slow');
      const signal = requiredIntParam(spec, 'signal');
      // Dominated by the slower EMA's 4x-period convergence margin
      return 4 * Math.max(fast, slow) + signal - 1;
    },
    reportedPeriod: (spec) =>
      Math.max(requiredIntParam(spec, 'fast'), requiredIntParam(spec, 'slow')),
    compute: (bars, spec) =>
      macdHistogramValue(
        bars,
        requiredIntParam(spec, 'fast'),
        requiredIntParam(spec, 'slow'),
        requiredIntParam(spec, 'signal'),
      ),
  },
  bb_kc_squeeze: {
    minimumBars: (spec) => {
      const bbPeriod = requiredIntParam(spec, 'bb_period');
      requiredPositiveParam(spec, 'bb_mult');
      const kcPeriod = requiredIntParam(spec, 'kc_period');
      requiredPositiveParam(spec, 'kc_mult');
      // Bollinger half needs bb_period bars (no seed); Keltner half needs
      // kc_period + 1 (atr's predecessor-close seed). Larger sets the floor.
      return Math.max(bbPeriod, kcPeriod + 1);
    },
    recommendedWarmup: (spec) => {
      const bbPeriod = requiredIntParam(spec, 'bb_period');
      const kcPeriod = requiredIntParam(spec, 'kc_period');
      // Bollinger half is warm-up-blind (stays at bb_period); Keltner half gets ema/atr's 4x-period margin
      return Math.max(bbPeriod, 4 * kcPeriod + 1);
    },
    reportedPeriod: (spec) =>
      Math.max(requiredIntParam(spec, 'bb_period'), requiredIntParam(spec, 'kc_period')),
    compute: (bars, spec) =>
      bbKcSqueezeValue(
        bars,
        requiredIntParam(spec, 'bb_period'),
        requiredPositiveParam(spec, 'bb_mult'),
        requiredIntParam(spec, 'kc_period'),
        requiredPositiveParam(spec, 'kc_mult'),
      ),
  },
};

/**
 * Looked up rather than indexed, so an unknown kind throws by name instead
 * of `.compute is not a function`. Unreachable for a well-typed caller —
 * kept as a backstop against a cast (`as IndicatorKind`) silencing the compiler at some call site.
 */
function definitionFor(indicator: IndicatorKind): IndicatorDefinition {
  const definition = INDICATORS[indicator];
  if (definition === undefined) {
    throw new Error(
      `Unsupported indicator: ${indicator}. Known kinds: ${INDICATOR_KINDS.join(', ')}.`,
    );
  }
  return definition;
}

/**
 * `params.period` selects the indicator's window inside the lookback,
 * defaulting to the full lookback. Non-integer/non-positive periods are
 * rejected: e.g. `sma`'s `slice(-period)` at `period = 0` would silently return the whole array as a fabricated "0-period" mean.
 */
function periodOf(spec: IndicatorSpec): number {
  const period = spec.params.period ?? spec.lookback;
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(
      `computeIndicator: ${spec.indicator} period must be a positive integer, got ${period}. ` +
        'A zero, negative or non-integer period yields a value computed over an unrelated ' +
        'window rather than an error.',
    );
  }
  return period;
}

/**
 * Bars `spec` needs for a genuine `period`-length value. Exported so a
 * caller that must degrade (`atrFor` in `trader/decide.ts`) can check
 * arity up front instead of catching `InsufficientBarsError`.
 */
export function minimumBarsFor(spec: IndicatorSpec): number {
  return definitionFor(spec.indicator).minimumBars(spec);
}

/**
 * Warm-up long enough that one more bar barely moves the value — the WIDTH
 * question, kept strictly separate from `minimumBarsFor`'s ARITY floor
 * (raising the floor to this would forfeit cold-start ticks instead of
 * just producing a less-converged reading). `4 x period + 1` is ~98%
 * convergence for a Wilder smoother (each step retains `(period-1)/period`) and is the conventional figure, not a fitted one.
 */
export function recommendedWarmupFor(spec: IndicatorSpec): number {
  return definitionFor(spec.indicator).recommendedWarmup(spec);
}

/**
 * Computes `spec.indicator` over `bars`. Throws rather than returning a
 * degraded value (#319) — an unguarded short window fabricates a value
 * (e.g. a 3-bar mean presented as period-14 ATR), not an approximation;
 * callers that must degrade check `minimumBarsFor` first instead of catching.
 */
export function computeIndicator(bars: Bar[], spec: IndicatorSpec): number {
  // Ordering checked before length: a misordered feed is the more actionable diagnosis
  assertAscending(bars);
  const definition = definitionFor(spec.indicator);

  const required = definition.minimumBars(spec);
  if (bars.length < required) {
    throw new InsufficientBarsError({
      indicator: spec.indicator,
      period: definition.reportedPeriod(spec),
      required,
      received: bars.length,
    });
  }

  return round(definition.compute(bars, spec));
}
