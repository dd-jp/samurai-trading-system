import type { BacktestResult } from './backtest.js';
import { annualisedSharpe, type FoldRange } from './evidence/index.js';
import type { VolTargetVerdict } from './vol-target-verdict.js';

export interface SignedOutcome {
  readonly sharpeOutOfSample: number;
  readonly totalReturn: number;
}

type Measure = keyof SignedOutcome;
type Picks = 'ownPicks' | 'baselinePicks';

export interface CostStressFlip {
  readonly picks: Picks;
  readonly measure: Measure;
}

export interface CostStress {
  readonly base: SignedOutcome;
  readonly ownPicks: SignedOutcome;
  readonly baselinePicks: SignedOutcome;
  readonly flipped: readonly CostStressFlip[];
}

interface GatedVerdict {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly pass: boolean;
}

export type CostStressed<V extends GatedVerdict> = Omit<V, 'checks'> & {
  readonly checks: V['checks'] & { readonly holdsSignAtDoubledCost: boolean };
  readonly costStress: CostStress;
};

export type CostStressedResult = Omit<BacktestResult, 'verdict'> & {
  readonly verdict: CostStressed<BacktestResult['verdict']>;
};

const MEASURES: readonly Measure[] = ['sharpeOutOfSample', 'totalReturn'];

function flipsFor(picks: Picks, base: SignedOutcome, stressed: SignedOutcome): CostStressFlip[] {
  return MEASURES.filter((measure) => base[measure] > 0 && stressed[measure] <= 0).map(
    (measure) => ({ picks, measure }),
  );
}

// David 2026-10-09 (#1860), "flip if either flips": a reading flips when it is positive at 1x and
// <= 0 at 2x modelled cost, read on the 2x run's own picks and on the 1x picks priced at 2x
export function costStress(
  base: SignedOutcome,
  ownPicks: SignedOutcome,
  baselinePicks: SignedOutcome,
): CostStress {
  return {
    base,
    ownPicks,
    baselinePicks,
    flipped: [
      ...flipsFor('ownPicks', base, ownPicks),
      ...flipsFor('baselinePicks', base, baselinePicks),
    ],
  };
}

export function withCostStress<V extends GatedVerdict>(
  verdict: V,
  stress: CostStress,
): CostStressed<V> {
  const holds = stress.flipped.length === 0;
  return {
    ...verdict,
    checks: { ...verdict.checks, holdsSignAtDoubledCost: holds },
    costStress: stress,
    pass: verdict.pass && holds,
  };
}

export function trialOutcome(verdict: VolTargetVerdict): SignedOutcome {
  return {
    sharpeOutOfSample: verdict.scaled.sharpeOutOfSample,
    totalReturn: verdict.scaled.totalReturn,
  };
}

function seriesOf(result: BacktestResult, trial: number): BacktestResult['trials'][number] {
  const series = result.trials.find((candidate) => candidate.trial === trial);
  if (series === undefined) throw new Error(`cost stress: no series for trial ${trial}`);
  return series;
}

function totalReturn(equity: readonly number[]): number {
  return (equity.at(-1) as number) / (equity[0] as number) - 1;
}

export function candidateOutcome(result: BacktestResult): SignedOutcome {
  return {
    sharpeOutOfSample: result.verdict.walkForward.strategySharpe,
    totalReturn: totalReturn(seriesOf(result, result.verdict.selectedTrial).equity),
  };
}

// `ranges` are the walk-forward folds both runs were scored on; fold 0 only trains
export function baselinePicksAt(
  baseline: BacktestResult,
  stressed: BacktestResult,
  ranges: readonly FoldRange[],
): SignedOutcome {
  const { selectedByFold } = baseline.verdict.walkForward;
  const aligned =
    stressed.dates.length === baseline.dates.length && selectedByFold.length === ranges.length - 1;
  if (!aligned) {
    throw new Error('baselinePicksAt: the 1x and 2x runs do not share their walk-forward folds');
  }
  const path = selectedByFold.flatMap((trial, fold) => {
    const test = ranges[fold + 1] as FoldRange;
    return seriesOf(stressed, trial).returns.slice(test.start, test.end);
  });
  return {
    sharpeOutOfSample: annualisedSharpe(path),
    totalReturn: totalReturn(seriesOf(stressed, baseline.verdict.selectedTrial).equity),
  };
}
