import {
  argMaxIndex,
  foldRanges,
  foldSharpeMatrix,
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
