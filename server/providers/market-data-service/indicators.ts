import { type Bar, INDICATOR_KINDS, type IndicatorKind, type IndicatorSpec } from './types.js';

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

function atrPctValue(bars: Bar[], period: number): number {
  const atrValue = atr(bars, period);
  const lastClose = (bars[bars.length - 1] as Bar).close;

  if (lastClose === 0) {
    return 0;
  }

  return (atrValue / lastClose) * 100;
}

function donchianPosValue(bars: Bar[], period: number): number {
  const window = bars.slice(-period);
  const highestHigh = Math.max(...window.map((bar) => bar.high));
  const lowestLow = Math.min(...window.map((bar) => bar.low));
  const range = highestHigh - lowestLow;
  const lastClose = (window[window.length - 1] as Bar).close;

  if (range === 0) {
    return 0.5;
  }

  return (lastClose - lowestLow) / range;
}

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

  const diPlus = () => (smoothedTR === 0 ? 0 : (100 * smoothedPlus) / smoothedTR);
  const diMinus = () => (smoothedTR === 0 ? 0 : (100 * smoothedMinus) / smoothedTR);
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

  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);

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

  if (kcWidth === 0) {
    return 1;
  }

  return bbWidth / kcWidth;
}

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

export class InsufficientBarsError extends Error {
  readonly indicator: string;
  readonly period: number;
  readonly required: number;
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

interface IndicatorDefinition {
  readonly minimumBars: (spec: IndicatorSpec) => number;
  readonly recommendedWarmup: (spec: IndicatorSpec) => number;
  readonly reportedPeriod: (spec: IndicatorSpec) => number;
  readonly compute: (bars: Bar[], spec: IndicatorSpec) => number;
}

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

function requiredIntParam(spec: IndicatorSpec, name: string): number {
  const value = requiredParam(spec, name);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `computeIndicator: ${spec.indicator}'s params.${name} must be a positive integer, got ${value}.`,
    );
  }
  return value;
}

function requiredPositiveParam(spec: IndicatorSpec, name: string): number {
  const value = requiredParam(spec, name);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `computeIndicator: ${spec.indicator}'s params.${name} must be a positive finite number, got ${value}.`,
    );
  }
  return value;
}

function periodIndicator(
  minimumBars: (period: number) => number,
  recommendedWarmup: (period: number) => number,
  compute: (bars: Bar[], period: number) => number,
): IndicatorDefinition {
  return {
    minimumBars: (spec) => minimumBars(periodOf(spec)),
    recommendedWarmup: (spec) => recommendedWarmup(periodOf(spec)),
    reportedPeriod: (spec) => periodOf(spec),
    compute: (bars, spec) => compute(bars, periodOf(spec)),
  };
}

const lookback = (period: number): number => period;
const pastLookback = (period: number): number => period + 1;
const wilderWarmup = (period: number): number => 4 * period + 1;

const INDICATORS: Record<IndicatorKind, IndicatorDefinition> = {
  sma: periodIndicator(lookback, lookback, (bars, period) => sma(closes(bars), period)),
  ema: periodIndicator(lookback, wilderWarmup, (bars, period) => ema(closes(bars), period)),
  rsi: periodIndicator(pastLookback, wilderWarmup, (bars, period) => rsi(closes(bars), period)),
  atr: periodIndicator(pastLookback, wilderWarmup, atr),
  atr_pct: periodIndicator(pastLookback, wilderWarmup, atrPctValue),
  donchian_pos: periodIndicator(lookback, lookback, donchianPosValue),
  adx: periodIndicator(
    (period) => 2 * period,
    (period) => 2 * period + 4 * period,
    adxValue,
  ),
  macd_histogram: {
    minimumBars: (spec) => {
      const fast = requiredIntParam(spec, 'fast');
      const slow = requiredIntParam(spec, 'slow');
      const signal = requiredIntParam(spec, 'signal');
      return Math.max(fast, slow) + signal - 1;
    },
    recommendedWarmup: (spec) => {
      const fast = requiredIntParam(spec, 'fast');
      const slow = requiredIntParam(spec, 'slow');
      const signal = requiredIntParam(spec, 'signal');
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
      return Math.max(bbPeriod, kcPeriod + 1);
    },
    recommendedWarmup: (spec) => {
      const bbPeriod = requiredIntParam(spec, 'bb_period');
      const kcPeriod = requiredIntParam(spec, 'kc_period');
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

function definitionFor(indicator: IndicatorKind): IndicatorDefinition {
  const definition = INDICATORS[indicator];
  if (definition === undefined) {
    throw new Error(
      `Unsupported indicator: ${indicator}. Known kinds: ${INDICATOR_KINDS.join(', ')}.`,
    );
  }
  return definition;
}

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

export function minimumBarsFor(spec: IndicatorSpec): number {
  return definitionFor(spec.indicator).minimumBars(spec);
}

export function recommendedWarmupFor(spec: IndicatorSpec): number {
  return definitionFor(spec.indicator).recommendedWarmup(spec);
}

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
