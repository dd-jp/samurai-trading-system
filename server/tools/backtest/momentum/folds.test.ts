import { pbo } from '../overfitting.js';
import {
  argMaxIndex,
  foldRanges,
  foldSharpeMatrix,
  sliceByRanges,
  WALK_FORWARD_FOLDS,
  walkForwardPath,
} from './folds.js';
import { annualisedSharpe } from './stats.js';

describe('foldRanges', () => {
  it('splits the series into contiguous non-overlapping folds covering every index', () => {
    const ranges = foldRanges(100, 16);
    expect(WALK_FORWARD_FOLDS).toBe(16);
    expect(ranges.length).toBe(16);
    expect(ranges[0]?.start).toBe(0);
    expect(ranges[15]?.end).toBe(100);
    for (let fold = 1; fold < ranges.length; fold++) {
      expect(ranges[fold]?.start).toBe(ranges[fold - 1]?.end);
    }
  });

  it('rejects odd, small or unfillable fold counts', () => {
    expect(() => foldRanges(100, 5)).toThrow(/even integer/);
    expect(() => foldRanges(100, 2)).toThrow(/even integer/);
    expect(() => foldRanges(7, 4)).toThrow(/cannot fill/);
  });

  it('defaults embargo to 0, reproducing the un-embargoed ranges exactly', () => {
    expect(foldRanges(100, 16, 0)).toEqual(foldRanges(100, 16));
  });

  it('#1515: trims embargo bars off each side of every internal boundary, not the outer ends', () => {
    const ranges = foldRanges(80, 4, 5);
    expect(ranges).toEqual([
      { fold: 0, start: 0, end: 15 },
      { fold: 1, start: 25, end: 35 },
      { fold: 2, start: 45, end: 55 },
      { fold: 3, start: 65, end: 80 },
    ]);
  });

  it('rejects an embargo that leaves a fold with fewer than 2 bars', () => {
    expect(() => foldRanges(80, 4, 10)).toThrow(/fewer than 2 bars/);
    expect(() => foldRanges(80, 4, -1)).toThrow(/non-negative integer/);
  });
});

describe('sliceByRanges', () => {
  it('concatenates each range verbatim, matching a plain slice at embargo 0', () => {
    const series = Array.from({ length: 40 }, (_, i) => i);
    const ranges = foldRanges(40, 4);
    expect(sliceByRanges(series, ranges.slice(1))).toEqual(series.slice(10, 40));
  });

  it('drops the embargoed gaps a plain slice would still include', () => {
    const series = Array.from({ length: 80 }, (_, i) => i);
    const ranges = foldRanges(80, 4, 5);
    expect(sliceByRanges(series, ranges.slice(1))).toEqual([
      ...series.slice(25, 35),
      ...series.slice(45, 55),
      ...series.slice(65, 80),
    ]);
  });
});

// #1515's motivating case: a position opened near a fold boundary keeps its mark-to-market
// return alive into the next fold. That is normal walk-forward behaviour (training always
// precedes the test fold it is scored against), but pbo()'s CSCV combinatorics also score
// combinations where a later fold "trains" against an earlier fold "testing" it — there, the
// straddling return is the same event counted on both sides, not two independent confirmations
describe('embargo purges a boundary-straddling return (#1515)', () => {
  const length = 80;
  const spikeStart = 15;
  // exclusive: 5 bars each side of the boundary at index 20
  const spikeEnd = 25;
  const spike = 0.06;

  function leakyTrial(): number[] {
    return Array.from({ length }, (_, index) =>
      index >= spikeStart && index < spikeEnd ? spike : 0,
    );
  }

  it('without a gap, the fold before and the fold after the boundary are numerically identical', () => {
    const ranges = foldRanges(length, 4, 0);
    const [matrix] = foldSharpeMatrix([leakyTrial()], ranges);
    // fold 0 = [0,20): 5 spike bars (15-19) + 15 zeros; fold 1 = [20,40): 5 spike bars (20-24)
    // + 15 zeros — the SAME composition, so the same "confirmation" is counted on both sides of
    // a train/test split that separates them, though it is one event, not two independent ones
    expect(matrix?.[0]).toBeCloseTo(matrix?.[1] as number, 10);
    expect(matrix?.[0]).toBeGreaterThan(0);
    expect(matrix?.[2]).toBe(0);
    expect(matrix?.[3]).toBe(0);
  });

  it('with a gap sized to the straddling window, neither side sees it any more', () => {
    const ranges = foldRanges(length, 4, 5);
    const [matrix] = foldSharpeMatrix([leakyTrial()], ranges);
    expect(matrix).toEqual([0, 0, 0, 0]);
  });

  it('understates PBO without the gap: the shared event lets the leaky trial pass as if its overfit training-half win were confirmed out-of-sample by an independent fold', () => {
    // A small, noisy, genuinely-there edge (seeded, not cherry-picked) — realistic enough that
    // the leaky trial only wins the CSCV training half that happens to include a spike fold
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed / 0x7f_ff_ff_ff;
    };
    const genuine = Array.from({ length }, () => 0.0005 + (rand() - 0.5) * 0.02);
    const withoutGap = pbo(foldSharpeMatrix([leakyTrial(), genuine], foldRanges(length, 4, 0))).pbo;
    const withGap = pbo(foldSharpeMatrix([leakyTrial(), genuine], foldRanges(length, 4, 5))).pbo;
    expect(withoutGap).toBeLessThan(withGap);
  });
});

describe('foldSharpeMatrix', () => {
  it('holds one annualised Sharpe per trial per fold', () => {
    const returns = Array.from({ length: 40 }, (_, index) => (index % 3) / 100);
    const ranges = foldRanges(40, 4);
    const matrix = foldSharpeMatrix([returns, returns.map((value) => -value)], ranges);
    expect(matrix.length).toBe(2);
    expect(matrix[0]?.length).toBe(4);
    expect(matrix[0]?.[0]).toBeCloseTo(annualisedSharpe(returns.slice(0, 10)));
    expect(matrix[1]?.[0]).toBeCloseTo(-(matrix[0]?.[0] as number));
  });
});

describe('walkForwardPath', () => {
  it('selects by training Sharpe over all prior folds and stitches the test fold of the winner', () => {
    const length = 40;
    const strong = Array.from({ length }, (_, index) => 0.01 + (index % 2) / 1000);
    const weak = Array.from({ length }, (_, index) => -0.01 + (index % 2) / 1000);
    const ranges = foldRanges(length, 4);
    const path = walkForwardPath([weak, strong], ranges);
    expect(path.selectedByFold).toEqual([1, 1, 1]);
    expect(path.start).toBe(10);
    expect(path.end).toBe(40);
    expect(path.returns).toEqual(strong.slice(10, 40));
    expect(path.testRanges).toEqual(ranges.slice(1));
  });

  it('#1515: testRanges lets a second series be sliced the same way the path was built', () => {
    const length = 80;
    const strong = Array.from({ length }, (_, index) => 0.01 + (index % 2) / 1000);
    const weak = Array.from({ length }, (_, index) => -0.01 + (index % 2) / 1000);
    const noEmbargo = walkForwardPath([weak, strong], foldRanges(length, 4, 0));
    expect(sliceByRanges(strong, noEmbargo.testRanges)).toEqual(
      strong.slice(noEmbargo.start, noEmbargo.end),
    );
    const embargoed = walkForwardPath([weak, strong], foldRanges(length, 4, 5));
    expect(sliceByRanges(strong, embargoed.testRanges)).not.toEqual(
      strong.slice(embargoed.start, embargoed.end),
    );
  });

  it('switches selection when the early leader fades', () => {
    const length = 40;
    const earlyLeader = Array.from({ length }, (_, index) =>
      index < 20 ? 0.02 + (index % 2) / 1000 : -0.02 + (index % 2) / 1000,
    );
    const steady = Array.from({ length }, (_, index) => 0.005 + (index % 2) / 1000);
    const path = walkForwardPath([earlyLeader, steady], foldRanges(length, 4));
    expect(path.selectedByFold[0]).toBe(0);
    expect(path.selectedByFold[2]).toBe(1);
  });

  it('rejects no trials or unequal series lengths', () => {
    expect(() => walkForwardPath([], foldRanges(40, 4))).toThrow(/no trials/);
    expect(() => walkForwardPath([[0.1, 0.2], [0.1]], foldRanges(40, 4))).toThrow(
      /differ in length/,
    );
  });
});

describe('argMaxIndex', () => {
  it('returns the first maximum', () => {
    expect(argMaxIndex([1, 3, 3, 2])).toBe(1);
    expect(argMaxIndex([5])).toBe(0);
  });
});
