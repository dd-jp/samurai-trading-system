import { combinations } from './combinatorics.js';
import type { DateRange } from './universe.js';
import type { Split } from './validation-types.js';

const CPCV_GROUPS = 6;
const CPCV_TEST_GROUPS = 2;

const WALK_FORWARD_FOLDS = 5;

const CSCV_FOLDS = 6;

export interface SplitOptions {
  embargo: number;
  barMs: number;
}

export type SplitScheme = 'walk_forward' | 'cpcv' | 'cscv';

export function generateSplits(
  window: DateRange,
  scheme: SplitScheme,
  options: SplitOptions,
): Split[] {
  assertUsableWindow(window, options);

  switch (scheme) {
    case 'walk_forward':
      return walkForwardSplits(window, options);
    case 'cpcv':
      return cpcvSplits(window, options);
    case 'cscv':
      return cscvSplits(window, options);
    default: {
      const unreachable: never = scheme;
      throw new Error(`generateSplits: unknown scheme ${String(unreachable)}.`);
    }
  }
}

function walkForwardSplits(window: DateRange, options: SplitOptions): Split[] {
  const groups = partition(window, WALK_FORWARD_FOLDS + 1);
  const embargoMs = options.embargo * options.barMs;
  const splits: Split[] = [];

  for (let fold = 1; fold <= WALK_FORWARD_FOLDS; fold++) {
    const test = at(groups, fold);
    const trainEnd = new Date(test.start.getTime() - embargoMs);

    if (trainEnd.getTime() <= window.start.getTime()) {
      throw new Error(
        `generateSplits: embargo of ${options.embargo} bars purges the entire training set of ` +
          `walk-forward fold ${fold}. Use a longer window or a smaller embargo.`,
      );
    }

    splits.push({ train: [{ start: window.start, end: trainEnd }], test: [test] });
  }

  return splits;
}

function cpcvSplits(window: DateRange, options: SplitOptions): Split[] {
  const groups = partition(window, CPCV_GROUPS);
  const embargoMs = options.embargo * options.barMs;
  const splits: Split[] = [];

  for (const testIndices of combinations(CPCV_GROUPS, CPCV_TEST_GROUPS)) {
    const test = testIndices.map((index) => at(groups, index));
    const train = groups
      .filter((_, index) => !testIndices.includes(index))
      .flatMap((group) => purge(group, test, embargoMs));

    if (train.length === 0) {
      throw new Error(
        `generateSplits: embargo of ${options.embargo} bars purges the entire training set of a ` +
          'CPCV split. Use a longer window or a smaller embargo.',
      );
    }

    splits.push({ train, test });
  }

  return splits;
}

function cscvSplits(window: DateRange, options: SplitOptions): Split[] {
  const groups = partition(window, CSCV_FOLDS);
  const embargoMs = options.embargo * options.barMs;
  const splits: Split[] = [];

  for (let fold = 0; fold < CSCV_FOLDS; fold++) {
    const test = at(groups, fold);
    const train = groups
      .filter((_, index) => index !== fold)
      .flatMap((group) => purge(group, [test], embargoMs));

    if (train.length === 0) {
      throw new Error(
        `generateSplits: embargo of ${options.embargo} bars purges the entire training set of ` +
          `CSCV fold ${fold}. Use a longer window or a smaller embargo.`,
      );
    }

    splits.push({ train, test: [test] });
  }

  return splits;
}

function purge(group: DateRange, test: DateRange[], embargoMs: number): DateRange[] {
  let remaining: DateRange[] = [group];

  for (const testGroup of test) {
    const blockedStart = testGroup.start.getTime() - embargoMs;
    const blockedEnd = testGroup.end.getTime() + embargoMs;

    remaining = remaining.flatMap((range) => {
      const kept: DateRange[] = [];

      if (range.start.getTime() < blockedStart) {
        kept.push({
          start: range.start,
          end: new Date(Math.min(range.end.getTime(), blockedStart)),
        });
      }
      if (range.end.getTime() > blockedEnd) {
        kept.push({ start: new Date(Math.max(range.start.getTime(), blockedEnd)), end: range.end });
      }

      return kept;
    });
  }

  return remaining;
}

function partition(window: DateRange, count: number): DateRange[] {
  const startMs = window.start.getTime();
  const groupMs = (window.end.getTime() - startMs) / count;

  return Array.from({ length: count }, (_, index) => ({
    start: new Date(startMs + index * groupMs),
    end: index === count - 1 ? window.end : new Date(startMs + (index + 1) * groupMs),
  }));
}

function at(groups: readonly DateRange[], index: number): DateRange {
  const group = groups[index];

  if (group === undefined) {
    throw new Error(`generateSplits: no group at index ${index} of ${groups.length}.`);
  }

  return group;
}

function assertUsableWindow(window: DateRange, options: SplitOptions): void {
  if (window.end.getTime() <= window.start.getTime()) {
    throw new Error('generateSplits: window must have end > start.');
  }
  if (options.embargo < 0) {
    throw new Error(`generateSplits: embargo must be >= 0 bars (got ${options.embargo}).`);
  }
  if (options.barMs <= 0) {
    throw new Error(`generateSplits: barMs must be > 0 (got ${options.barMs}).`);
  }
}
