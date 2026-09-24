import { deflatedSharpe, minbtlGuard, pbo } from '../overfitting.js';
import type { MinBtlVerdict } from '../validation-types.js';
import { argMaxIndex, foldRanges, foldSharpeMatrix, walkForwardPath } from './folds.js';
import type { TrialConfig, Venue } from './grid.js';
import type { SimulationResult } from './simulate.js';
import {
  annualisedSharpe,
  annualisedVol,
  compoundedAnnualReturn,
  maxDrawdown,
  moments,
  perPeriodSharpe,
} from './stats.js';

export const SHARPE_HAIRCUT_MULTIPLIER = 0.6;
export const MIN_DEFLATED_SHARPE = 0.95;
export const MAX_PBO = 0.1;
export const MINBTL_TARGET_SHARPE = 0.6;
export const US_DELISTING_SHARPE_HAIRCUT = 0.05;
export const US_MAX_MISSING_COVERAGE = 0.02;
export const YEARLY_LOSS_LIMIT_GBP = 1_500;
export const CAPITAL_CEILING_DRAWDOWN_MULTIPLE = 1.5;

export interface TrialSummary {
  readonly trial: number;
  readonly hash: string;
  readonly sharpe: number;
  readonly annualReturn: number;
  readonly annualVol: number;
  readonly maxDrawdown: number;
  readonly finalEquity: number;
  readonly fills: number;
  readonly stopHits: number;
  readonly skippedFills: number;
  readonly zeroShareTargets: number;
  readonly totalCost: number;
  readonly custodyCost: number;
  readonly budgetDays: SimulationResult['budgetDays'];
  readonly foldSharpes: readonly number[];
}

export interface VerdictInput {
  readonly venue: Venue;
  readonly startCapitalGbp: number;
  readonly wholeShares: boolean;
  readonly trials: readonly { config: TrialConfig; hash: string; result: SimulationResult }[];
  readonly benchmark: SimulationResult;
  readonly totalTrialsCounted: number;
  readonly missingCoverageFraction: number;
  readonly folds?: number;
}

export interface SubBookVerdict {
  readonly venue: Venue;
  readonly startCapitalGbp: number;
  readonly wholeShares: boolean;
  readonly evaluatedFrom: string;
  readonly evaluatedTo: string;
  readonly evaluatedYears: number;
  readonly trialsCounted: number;
  readonly trials: readonly TrialSummary[];
  readonly benchmark: Omit<TrialSummary, 'trial' | 'hash'>;
  readonly selectedTrial: number;
  readonly walkForward: {
    readonly from: string;
    readonly to: string;
    readonly selectedByFold: readonly number[];
    readonly strategySharpe: number;
    readonly strategySharpeAfterDelistingHaircut: number;
    readonly strategySharpeHaircut: number;
    readonly benchmarkSharpe: number;
    readonly strategyMaxDrawdown: number;
    readonly benchmarkMaxDrawdown: number;
    readonly beatsBenchmark: boolean;
  };
  readonly deflatedSharpe: number;
  readonly deflatedSharpeWalkForward: number;
  readonly pbo: number;
  readonly minbtl: MinBtlVerdict;
  readonly delistingHaircutApplied: number;
  readonly missingCoverageFraction: number;
  readonly coverageStopFailed: boolean;
  readonly capitalCeilingGbp: number;
  readonly checks: {
    readonly beatsBenchmarkAfterHaircut: boolean;
    readonly dsrAtLeast095: boolean;
    readonly pboAtMost010: boolean;
    readonly coverageWithinStop: boolean;
  };
  readonly pass: boolean;
}

export function subBookVerdict(input: VerdictInput): SubBookVerdict {
  if (input.trials.length < 2) throw new Error('subBookVerdict: need >= 2 trials for PBO');
  const trialReturns = input.trials.map(({ result }) => result.returns);
  const ranges = foldRanges((trialReturns[0] as readonly number[]).length, input.folds);
  const matrix = foldSharpeMatrix(trialReturns, ranges);
  const summaries = input.trials.map(({ config, hash, result }, index) => ({
    trial: config.trial,
    hash,
    ...summarise(result),
    foldSharpes: matrix[index] as number[],
  }));
  const benchmarkFolds = foldSharpeMatrix([input.benchmark.returns], ranges)[0] as number[];
  const selectedIndex = argMaxIndex(summaries.map((summary) => summary.sharpe));
  const selected = input.trials[selectedIndex] as VerdictInput['trials'][number];
  const path = walkForwardPath(trialReturns, ranges);
  const benchmarkPath = input.benchmark.returns.slice(path.start, path.end);
  const haircut = input.venue === 'us' ? US_DELISTING_SHARPE_HAIRCUT : 0;
  const strategySharpe = annualisedSharpe(path.returns);
  const afterDelisting = strategySharpe - haircut;
  const haircutSharpe = afterDelisting * SHARPE_HAIRCUT_MULTIPLIER;
  const benchmarkSharpe = annualisedSharpe(benchmarkPath);
  const dates = input.benchmark.dates;
  const window = {
    start: new Date(`${dates[0] as string}T00:00:00Z`),
    end: new Date(`${dates[dates.length - 1] as string}T00:00:00Z`),
  };
  const dsr = deflate(selected.result.returns, input.totalTrialsCounted);
  const dsrWalkForward = deflate(path.returns, input.totalTrialsCounted);
  const pboVerdict = pbo(matrix);
  const coverageStopFailed =
    input.venue === 'us' && input.missingCoverageFraction > US_MAX_MISSING_COVERAGE;
  const checks = {
    beatsBenchmarkAfterHaircut: haircutSharpe > benchmarkSharpe,
    dsrAtLeast095: dsr >= MIN_DEFLATED_SHARPE,
    pboAtMost010: pboVerdict.pbo <= MAX_PBO,
    coverageWithinStop: !coverageStopFailed,
  };
  const selectedMaxDrawdown = maxDrawdown(selected.result.equity);
  return {
    venue: input.venue,
    startCapitalGbp: input.startCapitalGbp,
    wholeShares: input.wholeShares,
    evaluatedFrom: dates[0] as string,
    evaluatedTo: dates[dates.length - 1] as string,
    evaluatedYears: (window.end.getTime() - window.start.getTime()) / (365.25 * 86_400_000),
    trialsCounted: input.totalTrialsCounted,
    trials: summaries,
    benchmark: { ...summarise(input.benchmark), foldSharpes: benchmarkFolds },
    selectedTrial: selected.config.trial,
    walkForward: {
      from: dates[path.start + 1] as string,
      to: dates[path.end] as string,
      selectedByFold: path.selectedByFold.map(
        (index) => (input.trials[index] as { config: TrialConfig }).config.trial,
      ),
      strategySharpe,
      strategySharpeAfterDelistingHaircut: afterDelisting,
      strategySharpeHaircut: haircutSharpe,
      benchmarkSharpe,
      strategyMaxDrawdown: maxDrawdown(equityFromReturns(path.returns)),
      benchmarkMaxDrawdown: maxDrawdown(equityFromReturns(benchmarkPath)),
      beatsBenchmark: checks.beatsBenchmarkAfterHaircut,
    },
    deflatedSharpe: dsr,
    deflatedSharpeWalkForward: dsrWalkForward,
    pbo: pboVerdict.pbo,
    minbtl: minbtlGuard(window, input.totalTrialsCounted, MINBTL_TARGET_SHARPE),
    delistingHaircutApplied: haircut,
    missingCoverageFraction: input.missingCoverageFraction,
    coverageStopFailed,
    capitalCeilingGbp:
      selectedMaxDrawdown > 0
        ? YEARLY_LOSS_LIMIT_GBP / (selectedMaxDrawdown * CAPITAL_CEILING_DRAWDOWN_MULTIPLE)
        : Number.POSITIVE_INFINITY,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

function summarise(result: SimulationResult): Omit<TrialSummary, 'trial' | 'hash' | 'foldSharpes'> {
  return {
    sharpe: annualisedSharpe(result.returns),
    annualReturn: compoundedAnnualReturn(result.equity),
    annualVol: annualisedVol(result.returns),
    maxDrawdown: maxDrawdown(result.equity),
    finalEquity: result.equity[result.equity.length - 1] as number,
    fills: result.fills.length,
    stopHits: result.stopHits,
    skippedFills: result.skippedFills,
    zeroShareTargets: result.zeroShareTargets,
    totalCost: result.totalCost,
    custodyCost: result.custodyCost,
    budgetDays: result.budgetDays,
  };
}

function deflate(returns: readonly number[], trials: number): number {
  const stats = moments(returns);
  if (stats.stdev === 0) return 0;
  return deflatedSharpe(
    perPeriodSharpe(returns),
    trials,
    returns.length,
    stats.skew,
    stats.excessKurtosis,
  );
}

export function equityFromReturns(returns: readonly number[], start = 1): number[] {
  const equity = [start];
  for (const value of returns) equity.push((equity[equity.length - 1] as number) * (1 + value));
  return equity;
}
