import {
  annualisedSharpe,
  argMaxIndex,
  deflatedSharpe,
  foldRanges,
  foldSharpeMatrix,
  maxDrawdown,
  moments,
  PBO_REJECT_THRESHOLD,
  pbo,
  perPeriodSharpe,
  type RegimeDay,
  type RegimeSplit,
  regimePeriods,
  regimeSplit,
  sliceByRanges,
  WALK_FORWARD_FOLDS,
  type WalkForwardPath,
  walkForwardPath,
} from './evidence/index.js';

// Q7: beat the benchmark after a 40% Sharpe haircut, applied as strategy × 0.6 > benchmark (doc 66 Session B (e))
const SHARPE_HAIRCUT_MULTIPLIER = 0.6;
const MIN_DEFLATED_SHARPE = 0.95;
export const CAPITAL_CEILING_DRAWDOWN_MULTIPLE = 1.5;

export interface BookSeries {
  readonly equity: readonly number[];
  readonly returns: readonly number[];
}

export interface TrialSeries extends BookSeries {
  readonly trial: number;
}

export interface VerdictInput {
  readonly dates: readonly string[];
  readonly trials: readonly TrialSeries[];
  readonly benchmark: BookSeries;
  readonly trialsCounted: number;
  readonly lossCapGbp: number;
  readonly folds?: number | undefined;
  readonly embargo?: number | undefined;
}

export interface TrialResult {
  readonly trial: number;
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly foldSharpes: readonly number[];
}

export interface BacktestVerdict {
  readonly from: string;
  readonly to: string;
  readonly trialsCounted: number;
  readonly trials: readonly TrialResult[];
  readonly selectedTrial: number;
  readonly walkForward: {
    readonly selectedByFold: readonly number[];
    readonly strategySharpe: number;
    readonly strategySharpeHaircut: number;
    readonly benchmarkSharpe: number;
  };
  readonly benchmarkSharpe: number;
  readonly benchmarkMaxDrawdown: number;
  readonly deflatedSharpe: number;
  readonly deflatedSharpeWalkForward: number;
  readonly pbo: number;
  readonly maxDrawdown: number;
  readonly capitalCeilingGbp: number;
  readonly regimeSplit: RegimeSplit;
  readonly checks: {
    readonly beatsBenchmarkAfterHaircut: boolean;
    readonly beatsBenchmarkWithAnyPeriodRemoved: boolean;
    readonly deflatedSharpeAtLeast095: boolean;
    readonly pboAtMost010: boolean;
  };
  readonly pass: boolean;
}

function deflate(returns: readonly number[], trialsCounted: number): number {
  const stats = moments(returns);
  if (stats.stdev === 0) return 0;
  return deflatedSharpe(
    perPeriodSharpe(returns),
    trialsCounted,
    returns.length,
    stats.skew,
    stats.excessKurtosis,
  );
}

function assertAligned(input: VerdictInput): void {
  if (input.trials.length < 2) throw new Error('backtestVerdict: PBO needs at least 2 trials');
  const length = input.dates.length;
  for (const series of [...input.trials, input.benchmark]) {
    if (series.returns.length !== length || series.equity.length !== length + 1) {
      throw new Error('backtestVerdict: every series must cover the same dates');
    }
  }
  if (input.trialsCounted < input.trials.length) {
    throw new Error('backtestVerdict: the trial counter is below the trials in this run');
  }
}

function walkForwardDays(
  dates: readonly string[],
  path: WalkForwardPath,
  benchmark: readonly number[],
): RegimeDay[] {
  const indices = sliceByRanges(
    dates.map((_, index) => index),
    path.testRanges,
  );
  return indices.map((dateIndex, position) => ({
    date: dates[dateIndex] as string,
    strategy: path.returns[position] as number,
    benchmark: benchmark[dateIndex] as number,
  }));
}

export function capitalCeilingGbp(lossCapGbp: number, drawdown: number): number {
  return lossCapGbp / (drawdown * CAPITAL_CEILING_DRAWDOWN_MULTIPLE);
}

export function backtestVerdict(input: VerdictInput): BacktestVerdict {
  assertAligned(input);
  const returns = input.trials.map((series) => series.returns);
  const ranges = foldRanges(
    input.dates.length,
    input.folds ?? WALK_FORWARD_FOLDS,
    input.embargo ?? 0,
  );
  const matrix = foldSharpeMatrix(returns, ranges);
  const trials = input.trials.map((series, index) => ({
    trial: series.trial,
    sharpe: annualisedSharpe(series.returns),
    maxDrawdown: maxDrawdown(series.equity),
    foldSharpes: matrix[index] as number[],
  }));
  const selected = input.trials[argMaxIndex(trials.map((trial) => trial.sharpe))] as TrialSeries;
  const path = walkForwardPath(returns, ranges);
  const strategySharpe = annualisedSharpe(path.returns);
  const haircut = strategySharpe * SHARPE_HAIRCUT_MULTIPLIER;
  const walkForwardBenchmark = annualisedSharpe(
    sliceByRanges(input.benchmark.returns, path.testRanges),
  );
  const dsr = deflate(selected.returns, input.trialsCounted);
  const probability = pbo(matrix).pbo;
  const drawdown = maxDrawdown(selected.equity);
  const from = input.dates[0] as string;
  const to = input.dates[input.dates.length - 1] as string;
  const regimes = regimeSplit(
    walkForwardDays(input.dates, path, input.benchmark.returns),
    regimePeriods(from, to),
    SHARPE_HAIRCUT_MULTIPLIER,
  );
  const checks = {
    beatsBenchmarkAfterHaircut: haircut > walkForwardBenchmark,
    beatsBenchmarkWithAnyPeriodRemoved: regimes.beatsBenchmarkWithAnyPeriodRemoved,
    deflatedSharpeAtLeast095: dsr >= MIN_DEFLATED_SHARPE,
    pboAtMost010: probability <= PBO_REJECT_THRESHOLD,
  };
  return {
    from,
    to,
    trialsCounted: input.trialsCounted,
    trials,
    selectedTrial: selected.trial,
    walkForward: {
      selectedByFold: path.selectedByFold.map(
        (index) => (input.trials[index] as TrialSeries).trial,
      ),
      strategySharpe,
      strategySharpeHaircut: haircut,
      benchmarkSharpe: walkForwardBenchmark,
    },
    benchmarkSharpe: annualisedSharpe(input.benchmark.returns),
    benchmarkMaxDrawdown: maxDrawdown(input.benchmark.equity),
    deflatedSharpe: dsr,
    deflatedSharpeWalkForward: deflate(path.returns, input.trialsCounted),
    pbo: probability,
    maxDrawdown: drawdown,
    capitalCeilingGbp: capitalCeilingGbp(input.lossCapGbp, drawdown),
    regimeSplit: regimes,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}
