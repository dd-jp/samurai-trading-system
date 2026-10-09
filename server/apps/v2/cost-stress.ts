import type { BacktestResult } from './backtest.js';
import type { VolTargetVerdict } from './vol-target-verdict.js';

export interface SignedOutcome {
  readonly sharpeOutOfSample: number;
  readonly totalReturn: number;
}

interface GatedVerdict {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly pass: boolean;
}

export type CostStressed<V extends GatedVerdict> = Omit<V, 'checks'> & {
  readonly checks: V['checks'] & { readonly holdsSignAtDoubledCost: boolean };
};

export type CostStressedResult = Omit<BacktestResult, 'verdict'> & {
  readonly verdict: CostStressed<BacktestResult['verdict']>;
};

function turnsNonPositive(base: number, stressed: number): boolean {
  return base > 0 && stressed <= 0;
}

// David 2026-10-09 (#1860): a trial or candidate fails when its own out-of-sample Sharpe or its
// total return is positive at 1x and turns <= 0 at 2x modelled cost
export function flipsSignAtDoubledCost(base: SignedOutcome, stressed: SignedOutcome): boolean {
  return (
    turnsNonPositive(base.sharpeOutOfSample, stressed.sharpeOutOfSample) ||
    turnsNonPositive(base.totalReturn, stressed.totalReturn)
  );
}

export function withCostStress<V extends GatedVerdict>(
  verdict: V,
  flipped: boolean,
): CostStressed<V> {
  return {
    ...verdict,
    checks: { ...verdict.checks, holdsSignAtDoubledCost: !flipped },
    pass: verdict.pass && !flipped,
  };
}

export function trialOutcome(verdict: VolTargetVerdict): SignedOutcome {
  return {
    sharpeOutOfSample: verdict.scaled.sharpeOutOfSample,
    totalReturn: verdict.scaled.totalReturn,
  };
}

export function candidateOutcome(result: BacktestResult): SignedOutcome {
  const selected = result.trials.find((series) => series.trial === result.verdict.selectedTrial);
  if (selected === undefined) {
    throw new Error(`candidateOutcome: no series for trial ${result.verdict.selectedTrial}`);
  }
  const { equity } = selected;
  return {
    sharpeOutOfSample: result.verdict.walkForward.strategySharpe,
    totalReturn: (equity.at(-1) as number) / (equity[0] as number) - 1,
  };
}
