import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../contracts/index.js';
import { SPLIT_STEP_THRESHOLD, snapToSplitRatio, splitRatioAcross } from './split.js';

function barAt(date: string, factor: number): V2Bar {
  return { date, open: 10, high: 11, low: 9, close: 10, volume: 1, rawClose: 10 * factor };
}

function series(...factors: number[]): V2Bar[] {
  return factors.map((factor, index) => barAt(`2026-09-${String(10 + index)}`, factor));
}

describe('snapToSplitRatio', () => {
  it('snaps a dividend-contaminated step to the clean split it is', () => {
    expect(snapToSplitRatio(10.0003)).toBe(10);
    expect(snapToSplitRatio(9.9962)).toBe(10);
    expect(snapToSplitRatio(1.4985)).toBe(1.5);
    expect(snapToSplitRatio(1.2502)).toBe(1.25);
    expect(snapToSplitRatio(0.1002)).toBe(0.1);
    expect(snapToSplitRatio(0.6668)).toBeCloseTo(2 / 3, 12);
  });

  it('leaves a step near no small-integer ratio untouched', () => {
    expect(snapToSplitRatio(1.37)).toBe(1.37);
  });

  it('snaps at the tolerance edge only', () => {
    expect(snapToSplitRatio(10 * 1.0049)).toBe(10);
    expect(snapToSplitRatio(10 * 1.0051)).toBe(10 * 1.0051);
  });
});

describe('splitRatioAcross', () => {
  it('is 1 with fewer than two bars', () => {
    expect(splitRatioAcross([])).toBe(1);
    expect(splitRatioAcross(series(1))).toBe(1);
  });

  it('is 1 across a flat series', () => {
    expect(splitRatioAcross(series(1, 1, 1, 1))).toBe(1);
  });

  it('reads a forward split off the factor step, not off price', () => {
    const bars = series(10.0289, 10.0288, 10.0289, 1.0029, 1.0027, 1.0028);
    expect(splitRatioAcross(bars)).toBe(10);
  });

  it('reads a reverse split as a ratio below 1', () => {
    expect(splitRatioAcross(series(0.1, 0.1, 1, 1))).toBe(0.1);
  });

  it('reads a 3:2 split as a fractional ratio', () => {
    expect(splitRatioAcross(series(1.5, 1.5, 1, 1))).toBe(1.5);
  });

  it('multiplies two splits inside the window', () => {
    expect(splitRatioAcross(series(6, 3, 3, 1))).toBe(6);
  });

  it('ignores a crash that leaves the factor unchanged', () => {
    const crash: V2Bar[] = [
      { date: '2026-09-10', open: 100, high: 101, low: 99, close: 100, volume: 1, rawClose: 100 },
      { date: '2026-09-11', open: 10, high: 11, low: 9, close: 10, volume: 1, rawClose: 10 },
    ];
    expect(splitRatioAcross(crash)).toBe(1);
  });

  it('ignores a gradual dividend restatement that never steps past the threshold', () => {
    expect(splitRatioAcross(series(1.05, 1.04, 1.02, 1.01, 1))).toBe(1);
  });

  it('ignores a special dividend below the threshold', () => {
    expect(splitRatioAcross(series(1.11, 1, 1))).toBe(1);
  });

  it('fires exactly at the threshold, on either side', () => {
    expect(SPLIT_STEP_THRESHOLD).toBe(1.2);
    expect(splitRatioAcross(series(1.2, 1))).toBe(1.2);
    expect(splitRatioAcross(series(1, 1.2))).toBeCloseTo(1 / 1.2, 12);
    expect(splitRatioAcross(series(1.19, 1))).toBe(1);
    expect(splitRatioAcross(series(1, 1.19))).toBe(1);
  });

  it('keeps an unsnappable step as measured', () => {
    expect(splitRatioAcross(series(1.37, 1))).toBeCloseTo(1.37, 12);
  });
});
