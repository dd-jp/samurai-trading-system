import type { V2Bar } from '../../../contracts/index.js';

// Large-cap splits start at 5:4 (1.25) and 6:5 (1.2). A special dividend above ~17% of price
// restates the factor by as much and would read as a split; a split smaller than 6:5 is missed
export const SPLIT_STEP_THRESHOLD = 1.2;

// Closes are stored to 4 dp, so a 6:5 step measured across four rounded closes lands up to
// ~4 x 0.00005 / close under 1.2: 1.199994 at a close near 8, ~2e-4 relative at a 1.00 close
// 5e-4 covers sub-1.00 closes and sits ~3x below the 0.17% a 1.198 non-split move shows
export const SPLIT_STEP_EPSILON = 5e-4;

export function isSplitStep(factor: number): boolean {
  return Math.max(factor, 1 / factor) >= SPLIT_STEP_THRESHOLD * (1 - SPLIT_STEP_EPSILON);
}

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

// Genuine splits leave the adjusted close continuous: real large-cap events, reverse splits
// included, show an adjusted gap of at most ~1.6. Adjusted-only discontinuities (spin-offs,
// vendor restatements) show 2.3x-9.6x while the raw close moved 1.07x-2.3x, and rescaling on
// them turns a barely moved raw mark into a phantom loss. A band above 1.6 keeps CHK/EXE-size
// reverse splits; below 2.3 it rejects every restatement seen
export const SPLIT_ADJUSTED_GAP_BAND = 2;

interface RejectedSplitStep {
  readonly date: string;
  readonly step: number;
  readonly adjustedGap: number;
}

interface SplitReading {
  readonly ratio: number;
  readonly rejected: readonly RejectedSplitStep[];
}

function magnitude(factor: number): number {
  return Math.max(factor, 1 / factor);
}

const NO_SPLIT: SplitReading = { ratio: 1, rejected: [] };

function judgeSplitStep(previous: V2Bar, bar: V2Bar, step: number): SplitReading {
  const adjustedGap = previous.close / bar.close;
  if (magnitude(adjustedGap) < SPLIT_ADJUSTED_GAP_BAND) {
    return { ratio: snapToSplitRatio(step), rejected: [] };
  }
  return { ratio: 1, rejected: [{ date: bar.date, step, adjustedGap }] };
}

function readSplitStep(previous: V2Bar, bar: V2Bar): SplitReading {
  const step = adjustmentFactor(previous) / adjustmentFactor(bar);
  return isSplitStep(step) ? judgeSplitStep(previous, bar, step) : NO_SPLIT;
}

// rawClose/close is the cumulative adjustment for every corporate action after that bar, so it
// steps at a split and stays put through a crash. The step sits on the split day both in a
// snapshot series and in a refreshed one, where the latest bar's factor is always 1
export function splitRatioAcross(bars: readonly V2Bar[]): SplitReading {
  let ratio = 1;
  const rejected: RejectedSplitStep[] = [];
  let previous: V2Bar | undefined;
  for (const bar of bars) {
    if (previous !== undefined) {
      const reading = readSplitStep(previous, bar);
      ratio *= reading.ratio;
      rejected.push(...reading.rejected);
    }
    previous = bar;
  }
  return { ratio, rejected };
}

// Ratio between the units a bar is quoted in and the units of `decisionBar`: entry orders keep
// the units they were priced in, so each bar a resting entry could fill on is compared in them
export function cumulativeSplitRatios(
  decisionBar: V2Bar | undefined,
  bars: readonly V2Bar[],
): readonly number[] {
  const ratios: number[] = [];
  let previous = decisionBar;
  let cumulative = 1;
  for (const bar of bars) {
    if (previous !== undefined) cumulative *= splitRatioAcross([previous, bar]).ratio;
    ratios.push(cumulative);
    previous = bar;
  }
  return ratios;
}

const WHOLE_SHARE_EPSILON = 1e-9;

// Whole shares are taken toward zero, so a short's fraction is negative and buys back
export function fractionalShares(qty: number): number {
  const whole = Math.sign(qty) * Math.floor(Math.abs(qty) + WHOLE_SHARE_EPSILON);
  const fraction = qty - whole;
  return Math.abs(fraction) < WHOLE_SHARE_EPSILON ? 0 : fraction;
}
