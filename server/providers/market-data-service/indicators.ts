/**
 * Deterministic technical-indicator computation (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Indicators):
 * "a vetted TA computation with fixed rounding; no floating nondeterminism."
 * Computed here — never inside analysts — so analysts stay stateless.
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

/** Pairwise differences: [values[1]-values[0], values[2]-values[1], ...] */
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

  /**
   * `avgGain === 0 && avgLoss === 0` is a genuinely flat window — every
   * change zero, the standard `avgLoss === 0 -> 100` branch below would
   * treat `0/0` as maximum strength rather than as no information (#725,
   * `docs/reviews/indicator-characterisation-2026-08-16.md` F3). That
   * matters because a halted or auction-flat instrument in the live LSE
   * leveraged-ETP universe (ADR-0016) hits this shape routinely, not as an
   * edge case: auctions and halts are exactly when bars go flat.
   *
   * Returns 50 rather than throwing. Refusing here would forfeit the
   * instrument for the tick — the technical analyst is `mandatory`
   * (`technical-analyst.ts`), so a throw escalates to a per-instrument
   * `quorum_skip` (`computeIndicator`'s own doc comment traces that path).
   * A flat tape during an auction or halt is a real, EXPECTED market state,
   * not a data error, so treating it as an exception the instrument cannot
   * trade through would be the wrong posture — the same reasoning
   * `minimumBarsFor` vs `recommendedWarmupFor` already draws elsewhere in
   * this module: a genuine-but-uninformative reading beats no reading at
   * all. 50 is the neutral midpoint `confidenceFrom` (`technical-analyst.ts`)
   * already treats as "no information" — `|50 - 50| / 50` clamps to the
   * 0.05 floor — so the analyst stays present in the debate but argues at
   * near-minimum strength instead of the 0.95 a flat 0/0 previously bought
   * it. This is a NEW branch, not a change to the `avgLoss === 0` one below:
   * a strictly rising window (`avgGain > 0`) still answers 100, which is the
   * standard Wilder reading.
   */
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
 * ATR expressed as a percentage of the last close (#744). Scale-DEPENDENT —
 * ADR-0016 §"Volume caveat" reasoning applies to it: on a leveraged ETP this
 * scales by the leverage factor versus the liquid underlying, so a spec
 * comparing the two directly must target one instrument consistently. Reuses
 * `atr` unchanged rather than re-deriving true range.
 */
function atrPctValue(bars: Bar[], period: number): number {
  const atrValue = atr(bars, period);
  const lastClose = (bars[bars.length - 1] as Bar).close;

  // Degenerate denominator: a genuinely 0 close never occurs in this
  // system's universe, but returning 0 rather than Infinity/NaN here costs
  // nothing and keeps the contract "never NaN/Infinity" true unconditionally
  // rather than true-in-practice
  if (lastClose === 0) {
    return 0;
  }

  return (atrValue / lastClose) * 100;
}

/**
 * Donchian channel position (#744): where the last close sits between the
 * window's highest high and lowest low, as a fraction in [0, 1]. 0 is
 * pinned to the lowest low, 1 to the highest high. Windowed like `sma` —
 * warm-up blind, reads only the trailing `period` bars.
 */
function donchianPosValue(bars: Bar[], period: number): number {
  const window = bars.slice(-period);
  const highestHigh = Math.max(...window.map((bar) => bar.high));
  const lowestLow = Math.min(...window.map((bar) => bar.low));
  const range = highestHigh - lowestLow;
  const lastClose = (window[window.length - 1] as Bar).close;

  // Degenerate denominator (`upper === lower`): a zero-range window — e.g.
  // the flat-doji fixture segment — has no "where in the range" to report
  // 0.5, the range's own midpoint, is the neutral reading: the same posture
  // the RSI flat-tape fix (#725) takes for its own 0/0 shape — a
  // genuine-but-uninformative value beats NaN propagating into whatever
  // reads this next
  if (range === 0) {
    return 0.5;
  }

  return (lastClose - lowestLow) / range;
}

/**
 * Wilder's ADX (#744) — exposes only the single scalar the confidence cap
 * reads. DI+/DI- are computed internally but never returned as their own
 * kinds, per the issue's cut list (kept out for the same reason MACD's line
 * and signal stay out: one vote per axis, this is the axis exception because
 * it feeds the confidence cap rather than a vote).
 *
 * Uses Wilder's ACCUMULATION form (`sm - sm/period + cur`, seeded with the
 * plain SUM of the first `period` values) for the TR/+DM/-DM smoothers,
 * rather than the MEAN form `atr()` above uses for true range. The two
 * differ by a constant factor of `period` throughout, which cancels exactly
 * in `DI = 100 * smoothedDM / smoothedTR` — so DI+/DI-/DX/ADX come out
 * identical either way. The accumulation form is used here because it is the
 * form Wilder's own published definition uses for +DM/-DM/TR, and because
 * the independent Python reference (`generate-indicator-golden.py`) uses the
 * same form — matching it avoids a spurious last-bit disagreement between
 * the two references, not a correctness difference.
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

  // Degenerate denominator: a window with zero true range throughout (the
  // flat-doji segment) has nothing to divide DI by. Both DI+ and DI- read 0
  // rather than NaN — no directional movement is not "maximally directional"
  const diPlus = () => (smoothedTR === 0 ? 0 : (100 * smoothedPlus) / smoothedTR);
  const diMinus = () => (smoothedTR === 0 ? 0 : (100 * smoothedMinus) / smoothedTR);
  // Degenerate denominator: DI+ === DI- === 0 (both smoothers flat) has no
  // directional imbalance to report — 0, not NaN
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
 * MACD histogram (#744) — `macdLine - signalLine`, a FLAT SCALAR rather than
 * a shared `macd` kind with an output selector (the issue's constraint: the
 * `params` map is interpolated into the cache key, and widening
 * `IndicatorValue.value` would touch the cache, the accessor and four
 * consumers; a flat kind costs zero type changes). The line and the signal
 * are NOT exposed as their own kinds — the issue's cut list.
 *
 * `fast`/`slow`/`signal` are all REQUIRED (`requiredIntParam` below); none
 * fall back to `spec.lookback` the way `periodOf` does for the single-period
 * kinds, because there is no single obviously-right fallback among three
 * named parameters — silently picking one is exactly the "RSI(13) labelled
 * 14" failure mode this ticket exists to not repeat.
 *
 * Builds the FULL fast/slow EMA series (not just the final scalar) because
 * the signal line is itself an EMA of the MACD line series — it needs every
 * intermediate value to seed and fold, the same way `rsi`/`atr` above fold a
 * whole series into one number, just with an extra layer.
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

  const fastSeries = emaSeries(values, fast); // fastSeries[k] is the EMA at values index (fast - 1 + k)
  const slowSeries = emaSeries(values, slow); // slowSeries[k] is the EMA at values index (slow - 1 + k)

  // The MACD line exists only where BOTH EMAs exist, i.e. from
  // max(fast, slow) - 1 onward — this is `minimumBarsFor`'s arity for this
  // kind, restated as an index rather than declared twice
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
 * Bollinger/Keltner squeeze ratio (#744): `bbWidth / kcWidth`. Below 1 means
 * the Bollinger Band has narrowed inside the Keltner Channel — the "squeeze"
 * a breakout is expected to follow. A flat scalar RATIO, not a boolean or a
 * pair of separate kinds — standalone Keltner is on the issue's cut list
 * (duplicates Bollinger; keep only this ratio).
 *
 * `bb_period`/`bb_mult`/`kc_period`/`kc_mult` are all REQUIRED — same
 * reasoning as `macdHistogramValue`: four named parameters, no single one is
 * "the" period a generic fallback could guess at.
 *
 * Bollinger half is WINDOWED (population mean/stddev of the trailing
 * `bb_period` closes, matching this module's population-not-sample `sma`
 * convention — divide by `bb_period`, not `bb_period - 1`). Keltner half is
 * RECURSIVE: `ema`/`atr` over the FULL window passed in, not a window
 * truncated to `kc_period + 1` bars — truncating would seed-and-never-fold,
 * presenting Cutler's smoothing as Wilder's, the exact class of defect
 * `docs/reviews/indicator-characterisation-2026-08-16.md` F1/F2 found in
 * RSI's warm-up.
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

  // Degenerate denominator (`upper === lower` on the Keltran side, i.e.
  // `kcWidth === 0`): a zero-ATR window has no ratio to report. A window
  // with zero true range throughout forces every close in it to be equal
  // too (TR's `|high - prevClose|`/`|low - prevClose|` legs pin `high`,
  // `low` and `close` all to the same value bar over bar), so `bbWidth` is
  // 0 in exactly the same cases — the ratio is answered as 1 (bands exactly
  // touching, neither squeezed nor expanded), the same neutral-reading
  // posture the RSI flat-tape fix (#725) takes for its own 0/0 shape
  if (kcWidth === 0) {
    return 1;
  }

  return bbWidth / kcWidth;
}

/**
 * Ascending order is this module's precondition, so it is asserted here
 * rather than trusted — every production indicator computation funnels
 * through `computeIndicator` (`service.ts` `getIndicator`, `trader/decide.ts`,
 * `proxy-strategy.ts`, `replay-driver.ts`), and each one of them either
 * documents ascending bars or inherits the guarantee from
 * `MarketDataService.getBars`. A documented contract is not an enforced one:
 * a source that returned a descending or interleaved window would feed
 * reversed true-range legs into `atr` and silently reprice every stop derived
 * from it, with no error anywhere. Cost is one pass over ~15 bars, against an
 * indicator that already walks them.
 *
 * Throwing, not sorting: a misordered window means the data source is broken,
 * and quietly repairing it here would hide that from every other consumer of
 * the same feed. Contained by design — `production.ts`'s tick loop logs the
 * throw and forfeits one tick rather than the run, and the backtest lets it
 * propagate deliberately (`backtest.ts`). This is the posture `replay-driver`'s
 * `BarCursor` already takes on the same contract, for the same reason.
 *
 * Non-decreasing rather than strictly increasing: an inversion is the failure
 * mode that corrupts the maths; equal close_times do not reorder anything.
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
 * Raised when a window is too short for the period it is asked to compute
 * over (issue #319). Typed rather than a bare `Error` so "this window is too
 * short" stays distinguishable from "this feed is misordered"
 * (`assertAscending`) — the latter must keep propagating and forfeit the tick,
 * never be absorbed into a skip, and a bare `Error` would make a `catch`
 * unable to tell them apart. No production caller catches it today
 * (`trader/decide.ts` pre-checks `minimumBarsFor` instead, which is why it can
 * skip without a `catch` at all); the type is what keeps that option open and
 * what the tests assert on rather than a message regex.
 *
 * Carries the numbers a human needs rather than only a message, matching
 * `AlpacaDataUnderfetchError`'s shape (the client-level half of this same
 * failure family, #292): a caller that wants to degrade can read `received`
 * and `required` instead of re-parsing the text. Never retryable — repeating
 * the request cannot conjure bars that do not exist.
 */
export class InsufficientBarsError extends Error {
  /** `spec.indicator` — any member of `INDICATOR_KINDS` */
  readonly indicator: string;
  /**
   * The single figure a human reads as "how deep" — `IndicatorDefinition
   * .reportedPeriod(spec)` (#744). `params.period ?? lookback` for the
   * single-period kinds; for the multi-parameter additions
   * (`macd_histogram`, `bb_kc_squeeze`) the larger of the two periods that
   * dominate the arity, since no single one of their several named
   * parameters is "the" period.
   */
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
 * One definition per kind, replacing the two parallel `switch` statements that
 * `minimumBarsFor` and `computeIndicator` used to carry (#703 step B2).
 *
 * They were parallel in the literal sense: adding a kind meant editing both,
 * and adding it to only the second is a silent, specific bug rather than a
 * missing case. `minimumBarsFor`'s `default` threw `Unsupported indicator`,
 * so a kind present only in `computeIndicator` would have thrown from the
 * ARITY check with a message saying the indicator does not exist — while the
 * arithmetic for it sat right there. Worse in the other direction: a kind whose
 * arity was declared `period` when it consumes a predecessor computes over
 * `period - 1` deltas and divides by `period`, which is a fabrication that
 * returns a plausible number. This repo has paid for that exact mistake twice
 * (the ATR off-by-one at `decide.ts:47-53`, the RSI(13)-labelled-14 at
 * `technical-analyst.ts:40-49`).
 *
 * `Record<IndicatorKind, IndicatorDefinition>` makes both a compile error: the
 * union has no member without a row, and no row can omit its arity.
 *
 * `seedBars: 0 | 1` plus a `recursive` flag (#703 B2's original shape) could
 * only describe kinds with one `period` parameter. #744 adds two
 * MULTI-parameter kinds (`macd_histogram`: fast/slow/signal;
 * `bb_kc_squeeze`: bb_period/bb_mult/kc_period/kc_mult), whose arity is not a
 * constant offset from a single period — it is a function of which
 * parameters were actually supplied. `minimumBars`/`recommendedWarmup`/
 * `reportedPeriod` are therefore FUNCTIONS of the whole spec rather than
 * declared constants; the single-period kinds' rows are the constant case of
 * that function, unchanged in behaviour from the previous shape.
 */
interface IndicatorDefinition {
  /** Bars needed for a genuine value — the ARITY floor `minimumBarsFor` reports */
  readonly minimumBars: (spec: IndicatorSpec) => number;
  /**
   * The WIDTH dial `recommendedWarmupFor` reports — a warm-up long enough
   * that one more bar barely moves the value. Strictly separate from
   * `minimumBars`: see `recommendedWarmupFor`'s own doc comment for why
   * raising the floor to this would be the wrong move.
   */
  readonly recommendedWarmup: (spec: IndicatorSpec) => number;
  /**
   * The single figure `InsufficientBarsError.period` reports and its message
   * names. For a single-`period` kind this is `periodOf(spec)`; for a
   * multi-parameter kind it is the parameter that dominates the arity (the
   * larger of `fast`/`slow` for `macd_histogram`, the larger of
   * `bb_period`/`kc_period` for `bb_kc_squeeze`) — a human-readable "how
   * deep", not a claim that a single number captures the whole spec.
   */
  readonly reportedPeriod: (spec: IndicatorSpec) => number;
  /** Takes the full window; each kind reads what it needs from `spec.params`. Rounding is the caller's. */
  readonly compute: (bars: Bar[], spec: IndicatorSpec) => number;
}

/**
 * Requires `spec.params[name]`, throwing and NAMING the parameter if it is
 * absent — the enforcement `periodOf`'s `spec.params.period ?? spec.lookback`
 * deliberately does NOT provide. That fallback is `periodOf`'s convention for
 * kinds with exactly one, genuinely-a-window-length parameter (`sma`, `ema`,
 * `rsi`, `atr`, and #744's single-period additions `atr_pct`, `donchian_pos`,
 * `adx`): the lookback and the period are the same kind of number there, so
 * "the whole lookback is the period" is a real, useful default.
 *
 * `macd_histogram` (fast/slow/signal) and `bb_kc_squeeze`
 * (bb_period/bb_mult/kc_period/kc_mult) have no such single obviously-right
 * fallback among their several named parameters — silently picking one, or
 * silently reusing `spec.lookback` for all of them, is exactly the "RSI(13)
 * labelled 14" and "ATR off-by-one" failure mode this ticket's acceptance
 * criteria name by number. So these kinds never call `periodOf`; every
 * parameter they read goes through this function or one of the two below,
 * and a caller who omits one gets a throw naming it, not a fabricated value.
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
  // #744 additions below. `atr_pct`, `donchian_pos` and `adx` each take one
  // `period` parameter and use `periodOf` exactly like the four kinds above
  // — the lookback-fallback IS the right default for them. `macd_histogram`
  // and `bb_kc_squeeze` never call `periodOf`; see `requiredParam`'s comment
  atr_pct: {
    // Same arity as `atr`: one seed bar for the true range's predecessor
    // close, on top of `period`
    minimumBars: (spec) => periodOf(spec) + 1,
    recommendedWarmup: (spec) => 4 * periodOf(spec) + 1,
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => atrPctValue(bars, periodOf(spec)),
  },
  donchian_pos: {
    // Windowed like `sma`: reads only the trailing `period` bars' high/low,
    // no predecessor to seed
    minimumBars: (spec) => periodOf(spec),
    recommendedWarmup: (spec) => periodOf(spec),
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => donchianPosValue(bars, periodOf(spec)),
  },
  adx: {
    // 2 x period is genuine ARITY, not a warm-up preference (contrast with
    // the `+ 4 * period` below): the first ADX value is a simple mean of
    // `period` DX readings, and each DX reading itself needs a `period`-long
    // smoothed DI+/DI- — so there is no `period`-length DX average to take
    // at all below 2 x period, the same structural reason `rsi`/`atr` need
    // `period + 1` rather than `period`. See `adxValue`'s doc comment for the
    // index-by-index derivation
    minimumBars: (spec) => 2 * periodOf(spec),
    // Beyond the 2 x period arity floor, ADX is doubly Wilder-smoothed (the
    // DI+/DI-/TR smoothers, then the DX-to-ADX smoother), each converging at
    // the same `(period - 1) / period` rate `recommendedWarmupFor`'s doc
    // comment derives for `ema`/`rsi`/`atr`. A further `4 x period` bars past
    // the floor is the same convergence margin applied once more; unlike the
    // `2 x period` term this half genuinely is a warm-up preference, hence
    // still separate from `minimumBars`
    recommendedWarmup: (spec) => 2 * periodOf(spec) + 4 * periodOf(spec),
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => adxValue(bars, periodOf(spec)),
  },
  macd_histogram: {
    minimumBars: (spec) => {
      const fast = requiredIntParam(spec, 'fast');
      const slow = requiredIntParam(spec, 'slow');
      const signal = requiredIntParam(spec, 'signal');
      // The MACD line exists from `max(fast, slow) - 1` onward (both EMAs
      // must exist); the signal EMA then needs `signal` MACD-line values to
      // seed itself. See `macdHistogramValue`'s doc comment for the index
      // derivation this mirrors
      return Math.max(fast, slow) + signal - 1;
    },
    recommendedWarmup: (spec) => {
      const fast = requiredIntParam(spec, 'fast');
      const slow = requiredIntParam(spec, 'slow');
      const signal = requiredIntParam(spec, 'signal');
      // Dominated by the slower EMA's convergence (the same `4 x period`
      // margin as `ema` above); the signal line's own `signal`-value seed
      // rides on top of it exactly as it does in `minimumBars`
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
      // Bollinger half is windowed (`bb_period` bars, no seed). Keltner half
      // is `atr(bars, kc_period)`, which needs `kc_period + 1` (the
      // predecessor-close seed bar). Whichever is larger sets the floor.
      return Math.max(bbPeriod, kcPeriod + 1);
    },
    recommendedWarmup: (spec) => {
      const bbPeriod = requiredIntParam(spec, 'bb_period');
      const kcPeriod = requiredIntParam(spec, 'kc_period');
      // Bollinger half is warm-up blind (like `sma`, stays at `bb_period`)
      // Keltner half is recursive (`ema`/`atr`), so it gets the same
      // `4 x period + 1` convergence margin those kinds get
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
 * Looked up rather than indexed, and it still throws.
 *
 * `IndicatorSpec.indicator` is typed `IndicatorKind`, so this is unreachable
 * for a well-typed caller — and there is no unvalidated path today either:
 * the orchestrator contains no `JSON.parse` at all, so
 * `ProductionConfig.volatilityIndicator` is written in TypeScript rather than
 * loaded, and the golden fixture — the one place an unknown kind can arrive —
 * is checked at its own parse boundary.
 *
 * So this is a BACKSTOP with no current caller, and is stated as one rather
 * than justified by a config file that does not exist. It stays because a
 * cast (`as IndicatorKind`) silences the compiler at any call site, and
 * unchecked the failure reads `.compute is not a function` — naming neither
 * the spec nor the kind.
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
 * `params.period` selects the indicator's own window inside the pinned
 * lookback; absent, the full lookback IS the period.
 *
 * A non-positive or non-integer period is rejected rather than tolerated:
 * `sma`'s `slice(-period)` at `period = 0` returns the WHOLE array (`-0 === 0`)
 * and would answer a full-window mean labelled a 0-period one; a `NaN` period
 * makes every length comparison below false; and a FRACTIONAL period seeds
 * over `slice`'s truncated count while `rsi`/`atr` divide by the untruncated
 * one. All three are the same silent fabrication this module now refuses.
 *
 * This throws on a path `atrFor` does NOT guard (it calls `minimumBarsFor`
 * outside any catch), so it is only safe because no period in this repo is
 * computed: `TraderConfig.atr_lookback` is the literal 14 in
 * `DEFAULT_TRADER_CONFIG`, spread unchanged by `paper-profile.ts`, and the
 * Feedback Loop's `strategy_params` dials are written to the tuning store
 * only — nothing feeds a tuned value back into an `IndicatorSpec`. If that
 * ever changes, a stepped dial is exactly how a fractional period would
 * arrive, and this check would turn a mispriced tick into a dead one; revisit
 * it then rather than assuming it stays free.
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
 * How many bars `spec` needs before it can produce a genuine `period`-length
 * value. Exported so a caller that must DEGRADE rather than fail — today only
 * `trader/decide.ts`'s `atrFor`, which returns null so `buildBracket` skips
 * the trade — can ask the arity question up front instead of catching the
 * throw. Catch-based control flow there would also have to be narrow enough
 * not to swallow `assertAscending`'s error, which `production.ts` deliberately
 * lets surface as a forfeited tick.
 *
 * The `+ 1` on `rsi`/`atr` is the same "N bars yield N-1 deltas" rule
 * `atrIndicatorSpec` and `DEFAULT_VOLATILITY_INDICATOR` already encode: both
 * consume the first bar only to seed a predecessor (`previousClose` for the
 * true range; the prior close for the RSI change). `sma`/`ema` read the closes
 * directly, so they need exactly `period`.
 *
 * Delegates to `IndicatorDefinition.minimumBars(spec)` (#744): for the four
 * original kinds this is exactly `periodOf(spec) + seedBars` as before. For
 * the multi-parameter additions (`macd_histogram`, `bb_kc_squeeze`) the arity
 * is a function of several named parameters rather than one offset, which is
 * why the row now carries a function instead of a constant.
 */
export function minimumBarsFor(spec: IndicatorSpec): number {
  return definitionFor(spec.indicator).minimumBars(spec);
}

/**
 * A warm-up long enough that one more bar no longer moves the value — the
 * WIDTH question, kept strictly separate from `minimumBarsFor`'s ARITY one.
 *
 * B1 measured what the difference costs. Every live spec used to sit at exactly
 * `minimumBarsFor`, so `changes.slice(period)` was empty and the smoothing loop
 * ran ZERO times: what the debate read as "RSI(14)" was the simple-mean seed,
 * Cutler's RSI rather than Wilder's. Against a converged warm-up on the same
 * bar that was a median 4.6 RSI points, p90 12.0, and it flipped the 70/30
 * overbought/oversold classification on 18% of bars —
 * `docs/reviews/indicator-characterisation-2026-08-16.md` F1/F2.
 *
 * **`RSI_SPEC` adopts this (#722)**; the same review records the after-figures.
 * The ATR specs (`atrIndicatorSpec(14)`, `DEFAULT_VOLATILITY_INDICATOR`) are
 * still on the floor — the identical gap, owned by `atr-equivalence.test.ts`
 * and untouched here, because moving it reprices every stop rather than every
 * opinion.
 *
 * **`minimumBarsFor` is deliberately NOT raised to this.** It is the
 * fabrication floor: below it every kind here answers with a window it did not
 * have, which is why #319 made it throw. `trader/decide.ts:126` pre-checks
 * against it precisely to decide whether a genuine value is obtainable at all.
 * Raising it would turn "this number would be better with more history" into
 * "this instrument cannot trade", forfeiting cold-start ticks over a warm-up
 * preference. The two questions have different answers and different
 * consequences, so they get different functions.
 *
 * `4 x period + 1` is ~98% convergence for a Wilder smoother (each step retains
 * `(period - 1) / period`, so `0.929^56 ~ 0.016` of the seed survives at
 * period 14) and is the conventional figure rather than a fitted one — nothing
 * here is permitted to search it, since ADR-0018 D4 caps the selection budget
 * and a warm-up chosen by outcome is a fitted parameter.
 *
 * Windowed kinds get `minimumBarsFor` back unchanged. That is not a shortcut:
 * `sma` reads `slice(-period)` and its value is warm-up-BLIND, pinned by
 * `rsi-warmup.test.ts` at 14 bars of history against 400.
 *
 * Adopting this for a live spec is a separate, deliberate decision — it
 * reprices every technical opinion in the system at once. #722 took it for
 * RSI. Any further adoption is the same kind of decision and not a
 * consequence of this one.
 *
 * Delegates to `IndicatorDefinition.recommendedWarmup(spec)` (#744) — same
 * `4 x period + 1` figure for every recursive kind this module has ever had,
 * now stated per-row instead of via a shared `recursive` flag, because the
 * multi-parameter additions don't have a single `period` to multiply.
 */
export function recommendedWarmupFor(spec: IndicatorSpec): number {
  return definitionFor(spec.indicator).recommendedWarmup(spec);
}

/**
 * Computes `spec.indicator` deterministically over `bars` — a close-time-
 * filtered, ascending-by-close_time window whose length is the pinned
 * `spec.lookback`. `params.period` selects the indicator's own window
 * within that lookback (defaults to the full lookback for sma/ema/rsi).
 *
 * Throws if `bars` is not ascending (`assertAscending`), or if the window
 * holds fewer than `minimumBarsFor(spec)` bars (`InsufficientBarsError`).
 *
 * THROWING, not returning a degraded value, is the failure mode (issue #319).
 * Every unguarded short-window answer here is a FABRICATION rather than an
 * approximation — `atr` divides by `seedRanges.length`, so 3 bars at
 * `period: 14` answers a 2-range mean presented as ATR(14); `sma` means
 * whatever `slice(-period)` found; `rsi` divides by `period` regardless of how
 * many changes it actually saw. There is no caller that can use such a number
 * safely, and the two consumers that must not simply die already convert a
 * throw into their own explicit degraded state: `atrFor` skips the trade
 * (via `minimumBarsFor`, before the call), and
 * `MarketDataVolatilityReadingProvider` fails CLOSED, aggregating a rejected
 * `getIndicator` as `FAILURE_READING` (`Infinity`) so the volatility breaker
 * trips conservatively instead of going inert. Returning `null` here would
 * instead push a new nullable through every consumer, and the ones that forgot
 * to handle it would land back at a `NaN` sizing a live stop.
 *
 * Containment was checked, not assumed, because this path fires far more often
 * than `assertAscending` ever did (a cold instrument, a fresh DB after
 * restart, a venue gap). No throw from here escapes one instrument's pass:
 * the technical analyst's SMA/RSI reject inside
 * `AnalystOrchestrator.runAnalysts`'s per-persona `catch`, which records the
 * reason and — technical being `mandatory` — returns an empty view set, so
 * `SequentialTickRunner` short-circuits that instrument at `analysts` with a
 * logged `quorum_skip`; `simulated-adapter`'s `buildMarketState` surfaces as
 * an `error` execution result; and `production.ts`'s tick loop is the
 * backstop that costs one tick rather than the run. Note `runTickPlan` has no
 * per-instrument catch of its own, so that backstop is the only one below the
 * process — which is why every consumer above converts rather than propagates.
 *
 * The length guard is checked AFTER the ordering guard on purpose: a
 * misordered window means a broken FEED, which is the more actionable
 * diagnosis, so it must not be masked by a length complaint when a window
 * happens to be both.
 *
 * No longer calls `periodOf(spec)` unconditionally (#744): that call would
 * silently answer `spec.lookback` for `macd_histogram`/`bb_kc_squeeze`, whose
 * specs carry no `params.period` at all — the exact "silently inherit the
 * generic lookback" fabrication this ticket's multi-parameter throw exists to
 * prevent, reintroduced through this function instead of `periodOf` itself.
 * The reported `period` in a thrown `InsufficientBarsError` now comes from
 * the definition's own `reportedPeriod(spec)`, which for multi-parameter
 * kinds validates (and can itself throw, naming the parameter) rather than
 * assuming one exists.
 */
export function computeIndicator(bars: Bar[], spec: IndicatorSpec): number {
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
