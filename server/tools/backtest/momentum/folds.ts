import { annualisedSharpe } from './stats.js';

export const WALK_FORWARD_FOLDS = 16;

export interface FoldRange {
  readonly fold: number;
  readonly start: number;
  readonly end: number;
}

function assertFoldable(length: number, folds: number, embargo: number): void {
  if (!Number.isInteger(folds) || folds < 4 || folds % 2 !== 0) {
    throw new Error(`foldRanges: folds must be an even integer >= 4 (got ${folds})`);
  }
  if (!Number.isInteger(embargo) || embargo < 0) {
    throw new Error(`foldRanges: embargo must be a non-negative integer (got ${embargo})`);
  }
  if (length < folds * 2)
    throw new Error(`foldRanges: ${length} returns cannot fill ${folds} folds`);
}

// #1515: embargo trims this many bars off each side of every INTERNAL fold boundary (not the
// series' own outer ends), purging the carried-over mark-to-market return of a position opened
// near a boundary from both the fold it closes in and the fold it was opened in — the CSCV
// combinatorics in pbo() otherwise pair those two folds as if they were independent (#1785 §4)
function foldRange(fold: number, folds: number, length: number, embargo: number): FoldRange {
  const boundary = (atFold: number) => Math.floor((atFold * length) / folds);
  const start = boundary(fold) + (fold > 0 ? embargo : 0);
  const end = boundary(fold + 1) - (fold < folds - 1 ? embargo : 0);
  // < 2, not <= 0: moments() throws below 2 returns, and a would-be-valid 1-bar fold is not
  // a useful signal either — proven unreachable at embargo 0 since length >= folds * 2
  if (end - start < 2) {
    throw new Error(
      `foldRanges: embargo ${embargo} leaves fold ${fold} of ${folds} over ${length} with fewer than 2 bars`,
    );
  }
  return { fold, start, end };
}

export function foldRanges(
  length: number,
  folds: number = WALK_FORWARD_FOLDS,
  embargo: number = 0,
): FoldRange[] {
  assertFoldable(length, folds, embargo);
  const ranges: FoldRange[] = [];
  for (let fold = 0; fold < folds; fold++) ranges.push(foldRange(fold, folds, length, embargo));
  return ranges;
}

export function sliceByRanges(series: readonly number[], ranges: readonly FoldRange[]): number[] {
  return ranges.flatMap((range) => series.slice(range.start, range.end));
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
  // The exact per-fold slices `returns` was built from. At embargo 0 these are contiguous, so
  // sliceByRanges(series, testRanges) === series.slice(start, end); with an embargo they diverge
  // (the gaps between folds are excluded), and only testRanges reproduces the same day-set on
  // another series — this is what walkForwardBenchmark must slice by, not start/end (#1785 §4)
  readonly testRanges: readonly FoldRange[];
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
  const testRanges: FoldRange[] = [];
  for (let fold = 1; fold < ranges.length; fold++) {
    const trainingEnd = (ranges[fold - 1] as FoldRange).end;
    const test = ranges[fold] as FoldRange;
    const selected = argMaxIndex(
      trialReturns.map((series) => annualisedSharpe(series.slice(0, trainingEnd))),
    );
    selectedByFold.push(selected);
    testRanges.push(test);
    returns.push(...(trialReturns[selected] as readonly number[]).slice(test.start, test.end));
  }
  return {
    returns,
    start: (ranges[1] as FoldRange).start,
    end: (ranges[ranges.length - 1] as FoldRange).end,
    selectedByFold,
    testRanges,
  };
}

export function argMaxIndex(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index++) {
    if ((values[index] as number) > (values[best] as number)) best = index;
  }
  return best;
}
