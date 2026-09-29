import type { V2Bar } from '../../../contracts/index.js';

// The smallest corporate-action ratios in a large-cap universe are 5:4 (1.25) and 6:5 (1.2).
// Special dividends restate the factor too, so a dividend above ~17% of price would read as a
// split; below this, a split of 6:5 or smaller is missed.
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

// A dividend restated across the same bar pair contaminates the measured step by a few
// tenths of a percent; qty must follow the broker's whole-ratio share count, not the noise
export function snapToSplitRatio(step: number): number {
  return step >= 1 ? snapAbove(step) : 1 / snapAbove(1 / step);
}

function adjustmentFactor(bar: V2Bar): number {
  return bar.rawClose / bar.close;
}

// rawClose/close is the cumulative adjustment for every corporate action after that bar, so
// it steps at a split and stays put through a crash. Reading the step between adjacent bars
// works on a snapshot series (the step sits on the split day) and on a refreshed one (the
// same step sits on the split day of the re-adjusted history)
export function splitRatioAcross(bars: readonly V2Bar[]): number {
  let ratio = 1;
  for (let index = 1; index < bars.length; index += 1) {
    const step = adjustmentFactor(bars[index - 1] as V2Bar) / adjustmentFactor(bars[index] as V2Bar);
    if (Math.max(step, 1 / step) >= SPLIT_STEP_THRESHOLD) ratio *= snapToSplitRatio(step);
  }
  return ratio;
}
