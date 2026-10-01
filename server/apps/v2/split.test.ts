import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../contracts/index.js';
import {
  isSplitStep,
  SPLIT_ADJUSTED_GAP_BAND,
  SPLIT_STEP_EPSILON,
  SPLIT_STEP_THRESHOLD,
  snapToSplitRatio,
  splitRatioAcross,
} from './split.js';

function barAt(date: string, factor: number): V2Bar {
  return { date, open: 10, high: 11, low: 9, close: 10, volume: 1, rawClose: 10 * factor };
}

const ratioOf = (bars: readonly V2Bar[]) => splitRatioAcross(bars).ratio;

function series(...factors: number[]): V2Bar[] {
  return factors.map((factor, index) => barAt(`2026-09-${String(10 + index)}`, factor));
}

describe('snapToSplitRatio', () => {
  it('snaps a dividend-contaminated step to the clean split it is', () => {
    expect(snapToSplitRatio(10.0003)).toBe(10);
    expect(snapToSplitRatio(9.9962)).toBe(10);
    expect(snapToSplitRatio(1.4985)).toBe(1.5);
    expect(snapToSplitRatio(1.2502)).toBe(1.25);
    expect(snapToSplitRatio(1.2004)).toBe(1.2);
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
    expect(ratioOf([])).toBe(1);
    expect(ratioOf(series(1))).toBe(1);
  });

  it('is 1 across a flat series', () => {
    expect(ratioOf(series(1, 1, 1, 1))).toBe(1);
  });

  it('reads a forward split off the factor step, not off price', () => {
    const bars = series(10.0289, 10.0288, 10.0289, 1.0029, 1.0027, 1.0028);
    expect(ratioOf(bars)).toBe(10);
  });

  it('reads a reverse split as a ratio below 1', () => {
    expect(ratioOf(series(0.1, 0.1, 1, 1))).toBe(0.1);
  });

  it('reads a 3:2 split as a fractional ratio', () => {
    expect(ratioOf(series(1.5, 1.5, 1, 1))).toBe(1.5);
  });

  it('multiplies two splits inside the window', () => {
    expect(ratioOf(series(6, 3, 3, 1))).toBe(6);
  });

  it('ignores a crash that leaves the factor unchanged', () => {
    const crash: V2Bar[] = [
      { date: '2026-09-10', open: 100, high: 101, low: 99, close: 100, volume: 1, rawClose: 100 },
      { date: '2026-09-11', open: 10, high: 11, low: 9, close: 10, volume: 1, rawClose: 10 },
    ];
    expect(ratioOf(crash)).toBe(1);
  });

  it('ignores a gradual dividend restatement that never steps past the threshold', () => {
    expect(ratioOf(series(1.05, 1.04, 1.02, 1.01, 1))).toBe(1);
  });

  it('ignores a special dividend below the threshold', () => {
    expect(ratioOf(series(1.11, 1, 1))).toBe(1);
  });

  it('fires exactly at the threshold, on either side', () => {
    expect(SPLIT_STEP_THRESHOLD).toBe(1.2);
    expect(ratioOf(series(1.2, 1))).toBe(1.2);
    expect(ratioOf(series(1, 1.2))).toBeCloseTo(1 / 1.2, 12);
    expect(ratioOf(series(1.19, 1))).toBe(1);
    expect(ratioOf(series(1, 1.19))).toBe(1);
  });

  it('keeps an unsnappable step as measured', () => {
    expect(ratioOf(series(1.37, 1))).toBeCloseTo(1.37, 12);
  });

  describe('adjusted-series discontinuities that are not splits', () => {
    function pricedBar(date: string, close: number, rawClose: number): V2Bar {
      return { date, open: close, high: close, low: close, close, volume: 1, rawClose };
    }

    function stepBars(adjustedGap: number, rawGap: number): V2Bar[] {
      return [
        pricedBar('2026-09-10', 100, 100),
        pricedBar('2026-09-11', 100 / adjustedGap, 100 / rawGap),
      ];
    }

    it('rejects a CNX-shaped step: adjusted close jumps 9.6x while raw moves 1.2x', () => {
      const reading = splitRatioAcross(stepBars(9.6, 1.2));
      expect(reading.ratio).toBe(1);
      expect(reading.rejected).toEqual([
        { date: '2026-09-11', step: expect.closeTo(0.125, 9), adjustedGap: expect.closeTo(9.6, 9) },
      ]);
    });

    it('keeps the band between the largest genuine reverse split gap and the smallest restatement', () => {
      expect(SPLIT_ADJUSTED_GAP_BAND).toBeGreaterThan(1.6);
      expect(SPLIT_ADJUSTED_GAP_BAND).toBeLessThan(2.33);
    });

    it('rescales just inside the band and rejects at it, on either side', () => {
      const inside = SPLIT_ADJUSTED_GAP_BAND * 0.999;
      expect(ratioOf(stepBars(inside, inside * 4))).toBeCloseTo(4, 9);
      expect(ratioOf(stepBars(1 / inside, 0.25 / inside))).toBeCloseTo(0.25, 9);
      expect(ratioOf(stepBars(SPLIT_ADJUSTED_GAP_BAND, SPLIT_ADJUSTED_GAP_BAND * 4))).toBe(1);
      expect(ratioOf(stepBars(1 / SPLIT_ADJUSTED_GAP_BAND, 0.25 / SPLIT_ADJUSTED_GAP_BAND))).toBe(
        1,
      );
    });

    it('rescales a CHK-shaped 1:200 reverse split with an adjusted gap of 1.6 either way', () => {
      expect(ratioOf(stepBars(1.6, 1.6 / 200))).toBeCloseTo(1 / 200, 12);
      expect(ratioOf(stepBars(1 / 1.6, 1 / 1.6 / 200))).toBeCloseTo(1 / 200, 12);
    });

    it('rescales a spin-off where raw and adjusted agree', () => {
      expect(ratioOf(stepBars(1, 1.5))).toBe(1.5);
    });

    it('applies a genuine split in the same window as a rejected restatement', () => {
      const bars = [
        pricedBar('2026-09-10', 100, 100),
        pricedBar('2026-09-11', 100 / 9.6, 100 / 1.2),
        pricedBar('2026-09-12', 100 / 9.6, 100 / 12),
      ];
      const reading = splitRatioAcross(bars);
      expect(reading.ratio).toBe(10);
      expect(reading.rejected).toHaveLength(1);
    });
  });
});

describe('rounding tolerance at the split threshold', () => {
  const rounded = (close: number, rawClose: number, date: string): V2Bar => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    rawClose,
  });

  it('reads a 6:5 split whose 4 dp closes land under 1.2 as the split it is', () => {
    const bars = [
      rounded(6.6667, 8, '2026-09-10'),
      rounded(6.6667, 8, '2026-09-11'),
      rounded(6.7, 6.7, '2026-09-14'),
    ];
    expect(8 / 6.6667).toBeLessThan(SPLIT_STEP_THRESHOLD);
    expect(splitRatioAcross(bars).ratio).toBe(1.2);
  });

  it('reads the reverse 5:6 step the same way', () => {
    const bars = [rounded(8, 6.6667, '2026-09-10'), rounded(8.1, 8.1, '2026-09-11')];
    expect(splitRatioAcross(bars).ratio).toBeCloseTo(5 / 6, 12);
  });

  it('still rejects a step below the epsilon band', () => {
    const below = SPLIT_STEP_THRESHOLD * (1 - 2 * SPLIT_STEP_EPSILON);
    expect(isSplitStep(below)).toBe(false);
    expect(isSplitStep(1 / below)).toBe(false);
    expect(isSplitStep(1.198)).toBe(false);
    expect(ratioOf(series(1.198, 1))).toBe(1);
  });

  it('accepts the threshold and a step inside the band', () => {
    expect(isSplitStep(SPLIT_STEP_THRESHOLD)).toBe(true);
    expect(isSplitStep(SPLIT_STEP_THRESHOLD * (1 - SPLIT_STEP_EPSILON / 2))).toBe(true);
  });
});
