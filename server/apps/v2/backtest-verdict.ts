import {
  annualisedSharpe,
  argMaxIndex,
  deflatedSharpe,
  type FoldRange,
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
export const SHARPE_HAIRCUT_MULTIPLIER = 0.6;
export const MIN_DEFLATED_SHARPE = 0.95;
export const CAPITAL_CEILING_DRAWDOWN_MULTIPLE = 1.5;
// David, 2026-10-08 on #1747 (ruling 1): above the 95th percentile of the random-entry runs
export const RANDOM_BAND_QUANTILE = 0.95;

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
  readonly delayed?: readonly BookSeries[] | undefined;
  readonly random?: readonly BookSeries[] | undefined;
  readonly randomUnmatched?: number | undefined;
}

interface WalkForward {
  readonly path: WalkForwardPath;
  readonly strategySharpe: number;
  readonly strategySharpeHaircut: number;
  readonly benchmarkSharpe: number;
}

export interface TrialResult {
  readonly trial: number;
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly foldSharpes: readonly number[];
}

export interface OneBarDelay {
  readonly selectedByFold: readonly number[];
  readonly strategySharpe: number;
  readonly strategySharpeHaircut: number;
  readonly benchmarkSharpe: number;
  readonly survives: boolean;
}

export interface RandomEntries {
  readonly runs: number;
  readonly edge: number;
  readonly band: number;
  readonly edges: readonly number[];
  readonly unmatchedRuns: number;
  readonly beats: boolean;
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
  readonly oneBarDelay: OneBarDelay | null;
  readonly randomEntries: RandomEntries | null;
  readonly checks: {
    readonly beatsBenchmarkAfterHaircut: boolean;
    readonly beatsBenchmarkWithAnyPeriodRemoved: boolean;
    readonly survivesOneBarDelay: boolean;
    readonly beatsRandomEntries: boolean;
    readonly deflatedSharpeAtLeast095: boolean;
    readonly pboAtMost010: boolean;
  };
  readonly pass: boolean;
}

export function deflatedSharpeOfReturns(returns: readonly number[], trialsCounted: number): number {
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

function assertCoversDates(series: readonly BookSeries[], length: number): void {
  for (const book of series) {
    if (book.returns.length !== length || book.equity.length !== length + 1) {
      throw new Error('backtestVerdict: every series must cover the same dates');
    }
  }
}

function assertRandomRuns(random: readonly BookSeries[] | undefined, length: number): void {
  if (random === undefined) return;
  if (random.length === 0) throw new Error('backtestVerdict: the random canary has no runs');
  assertCoversDates(random, length);
}

function assertAligned(input: VerdictInput): void {
  if (input.trials.length < 2) throw new Error('backtestVerdict: PBO needs at least 2 trials');
  const delayed = input.delayed ?? input.trials;
  if (delayed.length !== input.trials.length) {
    throw new Error('backtestVerdict: the delayed run must carry every trial');
  }
  assertCoversDates([...input.trials, ...delayed, input.benchmark], input.dates.length);
  assertRandomRuns(input.random, input.dates.length);
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

function walkForward(
  trials: readonly BookSeries[],
  ranges: readonly FoldRange[],
  benchmark: readonly number[],
): WalkForward {
  const path = walkForwardPath(
    trials.map((series) => series.returns),
    ranges,
  );
  const strategySharpe = annualisedSharpe(path.returns);
  return {
    path,
    strategySharpe,
    strategySharpeHaircut: strategySharpe * SHARPE_HAIRCUT_MULTIPLIER,
    benchmarkSharpe: annualisedSharpe(sliceByRanges(benchmark, path.testRanges)),
  };
}

// David, 2026-10-07 on #1747 (rulings 1, 2 and 5): the edge must survive a one-bar delay, judged
// by the verdict's own haircut test; no delayed run is no pass
function oneBarDelay(input: VerdictInput, ranges: readonly FoldRange[]): OneBarDelay | null {
  if (input.delayed === undefined) return null;
  const delayed = walkForward(input.delayed, ranges, input.benchmark.returns);
  return {
    selectedByFold: trialNumbers(input, delayed.path),
    strategySharpe: delayed.strategySharpe,
    strategySharpeHaircut: delayed.strategySharpeHaircut,
    benchmarkSharpe: delayed.benchmarkSharpe,
    survives: delayed.strategySharpeHaircut > delayed.benchmarkSharpe,
  };
}

// Linear interpolation between order statistics (Hyndman and Fan type 7)
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const lower = sorted[below] as number;
  const upper = sorted[Math.min(below + 1, sorted.length - 1)] as number;
  return lower + (upper - lower) * (position - below);
}

// David, 2026-10-08 on #1747 (rulings 1 and 2): the edge is walk-forward Sharpe minus the
// benchmark's over the same days, and the candidate must sit above the random runs' band;
// David, 2026-10-09 on #1747: a run still unmatched at the window's end fails the check
function randomEntries(input: VerdictInput, forward: WalkForward): RandomEntries | null {
  if (input.random === undefined) return null;
  const edges = input.random.map(
    (series) =>
      annualisedSharpe(sliceByRanges(series.returns, forward.path.testRanges)) -
      forward.benchmarkSharpe,
  );
  const band = quantile(edges, RANDOM_BAND_QUANTILE);
  const edge = forward.strategySharpe - forward.benchmarkSharpe;
  const unmatchedRuns = input.randomUnmatched ?? 0;
  return {
    runs: edges.length,
    edge,
    band,
    edges,
    unmatchedRuns,
    beats: unmatchedRuns === 0 && edge > band,
  };
}

export function walkForwardRanges(
  length: number,
  folds: number | undefined,
  embargo: number | undefined,
): FoldRange[] {
  return foldRanges(length, folds ?? WALK_FORWARD_FOLDS, embargo ?? 0);
}

function trialNumbers(input: VerdictInput, path: WalkForwardPath): number[] {
  return path.selectedByFold.map((index) => (input.trials[index] as TrialSeries).trial);
}

export function capitalCeilingGbp(lossCapGbp: number, drawdown: number): number {
  return lossCapGbp / (drawdown * CAPITAL_CEILING_DRAWDOWN_MULTIPLE);
}

export function backtestVerdict(input: VerdictInput): BacktestVerdict {
  assertAligned(input);
  const returns = input.trials.map((series) => series.returns);
  const ranges = walkForwardRanges(input.dates.length, input.folds, input.embargo);
  const matrix = foldSharpeMatrix(returns, ranges);
  const trials = input.trials.map((series, index) => ({
    trial: series.trial,
    sharpe: annualisedSharpe(series.returns),
    maxDrawdown: maxDrawdown(series.equity),
    foldSharpes: matrix[index] as number[],
  }));
  const selected = input.trials[argMaxIndex(trials.map((trial) => trial.sharpe))] as TrialSeries;
  const forward = walkForward(input.trials, ranges, input.benchmark.returns);
  const { path, strategySharpe } = forward;
  const haircut = forward.strategySharpeHaircut;
  const walkForwardBenchmark = forward.benchmarkSharpe;
  const delay = oneBarDelay(input, ranges);
  const random = randomEntries(input, forward);
  const dsr = deflatedSharpeOfReturns(selected.returns, input.trialsCounted);
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
    survivesOneBarDelay: delay?.survives === true,
    beatsRandomEntries: random?.beats === true,
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
      selectedByFold: trialNumbers(input, path),
      strategySharpe,
      strategySharpeHaircut: haircut,
      benchmarkSharpe: walkForwardBenchmark,
    },
    benchmarkSharpe: annualisedSharpe(input.benchmark.returns),
    benchmarkMaxDrawdown: maxDrawdown(input.benchmark.equity),
    deflatedSharpe: dsr,
    deflatedSharpeWalkForward: deflatedSharpeOfReturns(path.returns, input.trialsCounted),
    pbo: probability,
    maxDrawdown: drawdown,
    capitalCeilingGbp: capitalCeilingGbp(input.lossCapGbp, drawdown),
    regimeSplit: regimes,
    oneBarDelay: delay,
    randomEntries: random,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}
