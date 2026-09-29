import type { V2Bar } from '../../../contracts/index.js';

// Large-cap splits start at 5:4 (1.25) and 6:5 (1.2). A special dividend above ~17% of price
// restates the factor by as much and would read as a split; a split smaller than 6:5 is missed
export const SPLIT_STEP_THRESHOLD = 1.2;

const SNAP_MAX_DENOMINATOR = 5;
const SNAP_TOLERANCE = 0.005;

function snapAbove(step: number): number {
  for (let denominator = 1; denominator <= SNAP_MAX_DENOMINATOR; denominator += 1) {
    const numerator = Math.round(step * denominator);
    if (Math.abs(numerator / denominator - step) / step <= SNAP_TOLERANCE) {
      return numerator / denominator;
    }
  }
  return step;
}

// A dividend restated across the same bar pair contaminates the measured step by a few tenths
// of a percent; qty must follow the broker's whole-ratio share count, not that noise
export function snapToSplitRatio(step: number): number {
  return step >= 1 ? snapAbove(step) : 1 / snapAbove(1 / step);
}

function adjustmentFactor(bar: V2Bar): number {
  return bar.rawClose / bar.close;
}

// rawClose/close is the cumulative adjustment for every corporate action after that bar, so it
// steps at a split and stays put through a crash. The step sits on the split day both in a
// snapshot series and in a refreshed one, where the latest bar's factor is always 1
export function splitRatioAcross(bars: readonly V2Bar[]): number {
  let ratio = 1;
  let previous: V2Bar | undefined;
  for (const bar of bars) {
    if (previous !== undefined) {
      const step = adjustmentFactor(previous) / adjustmentFactor(bar);
      if (Math.max(step, 1 / step) >= SPLIT_STEP_THRESHOLD) ratio *= snapToSplitRatio(step);
    }
    previous = bar;
  }
  return ratio;
}
