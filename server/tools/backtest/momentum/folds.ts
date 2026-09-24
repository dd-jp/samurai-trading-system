import { annualisedSharpe } from './stats.js';

export const WALK_FORWARD_FOLDS = 16;

export interface FoldRange {
  readonly fold: number;
  readonly start: number;
  readonly end: number;
}

export function foldRanges(length: number, folds: number = WALK_FORWARD_FOLDS): FoldRange[] {
  if (!Number.isInteger(folds) || folds < 4 || folds % 2 !== 0) {
    throw new Error(`foldRanges: folds must be an even integer >= 4 (got ${folds})`);
  }
  if (length < folds * 2)
    throw new Error(`foldRanges: ${length} returns cannot fill ${folds} folds`);
  const ranges: FoldRange[] = [];
  for (let fold = 0; fold < folds; fold++) {
    ranges.push({
      fold,
      start: Math.floor((fold * length) / folds),
      end: Math.floor(((fold + 1) * length) / folds),
    });
  }
  return ranges;
}

export function foldSharpeMatrix(
  trialReturns: readonly (readonly number[])[],
  ranges: readonly FoldRange[],
): number[][] {
  return trialReturns.map((returns) =>
    ranges.map((range) => annualisedSharpe(returns.slice(range.start, range.end))),
  );
}

export interface WalkForwardPath {
  readonly returns: number[];
  readonly start: number;
  readonly end: number;
  readonly selectedByFold: readonly number[];
}

export function walkForwardPath(
  trialReturns: readonly (readonly number[])[],
  ranges: readonly FoldRange[],
): WalkForwardPath {
  if (trialReturns.length === 0) throw new Error('walkForwardPath: no trials');
  const length = (trialReturns[0] as readonly number[]).length;
  for (const returns of trialReturns) {
    if (returns.length !== length)
      throw new Error('walkForwardPath: trial return series differ in length');
  }
  const returns: number[] = [];
  const selectedByFold: number[] = [];
  for (let fold = 1; fold < ranges.length; fold++) {
    const trainingEnd = (ranges[fold - 1] as FoldRange).end;
    const test = ranges[fold] as FoldRange;
    const selected = argMaxIndex(
      trialReturns.map((series) => annualisedSharpe(series.slice(0, trainingEnd))),
    );
    selectedByFold.push(selected);
    returns.push(...(trialReturns[selected] as readonly number[]).slice(test.start, test.end));
  }
  return {
    returns,
    start: (ranges[1] as FoldRange).start,
    end: (ranges[ranges.length - 1] as FoldRange).end,
    selectedByFold,
  };
}

export function argMaxIndex(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index++) {
    if ((values[index] as number) > (values[best] as number)) best = index;
  }
  return best;
}
