/**
 * Walk-forward / CPCV split generation (ticket #89). See
 * docs/specs/cost-model-backtest-spec.md ("Module: Validation Library") and
 * user story 14: the point of both schemes is a *distribution* of
 * out-of-sample Sharpe ratios rather than the single lucky path a one-shot
 * train/test cut produces.
 *
 * CPCV follows López de Prado, *Advances in Financial Machine Learning*, ch.
 * 7 & 12: partition the window into N groups, take every combination of k of
 * them as the test set, and purge + embargo the train side around each test
 * group. Purging matters because financial labels overlap in time — a train
 * bar adjacent to a test bar shares information with it, so leaving it in
 * leaks the test set into training and manufactures exactly the out-of-sample
 * edge these splits exist to measure honestly.
 */

import type { DateRange } from './universe.js';
import type { Split } from './validation-types.js';

/**
 * Number of CPCV groups and how many are held out per split. Fixed rather
 * than configurable: the spec's `generateSplits(window, scheme, embargo)`
 * signature carries no group count, and 6-choose-2 gives 15 paths — enough
 * for a PBO distribution without inventing knobs the issue does not ask for.
 */
const CPCV_GROUPS = 6;
const CPCV_TEST_GROUPS = 2;

/** Walk-forward folds: each fold tests the next slice and trains on all prior ones */
const WALK_FORWARD_FOLDS = 5;

/**
 * Purged k-fold groups for the CSCV pass (#406). Six, matching `CPCV_GROUPS`
 * — the same partition of the window, held out one group at a time instead of
 * `CPCV_TEST_GROUPS` at a time.
 *
 * Even and >= 4 by construction, which is exactly `pbo()`'s precondition: CSCV
 * partitions the *folds* into symmetric train/test halves itself (C(6,3) = 20
 * partitions), so what it needs from here is a fold set it can halve, not a
 * pre-combined one. Feeding it `cpcv`'s 15 two-group splits instead would
 * combine the groups twice over.
 */
const CSCV_FOLDS = 6;

/**
 * `embargo` is in **bars**, per the spec's `BacktestConfig.validation.embargo`.
 * Bars are not dates, and this generator is handed a `DateRange` with no
 * timeline to resolve them against, so the caller states the bar duration.
 * Defaulting it would silently pick a cadence and mis-size every purge.
 */
export interface SplitOptions {
  /** Bars purged/embargoed around each test fold */
  embargo: number;
  /** Duration of one bar, in milliseconds — how `embargo` becomes a span */
  barMs: number;
}

/** The partitioning schemes. `cscv` is the PBO input — see `cscvSplits`. */
export type SplitScheme = 'walk_forward' | 'cpcv' | 'cscv';

export function generateSplits(
  window: DateRange,
  scheme: SplitScheme,
  options: SplitOptions,
): Split[] {
  assertUsableWindow(window, options);

  // Exhaustive switch rather than a ternary: a ternary silently routes every
  // scheme it does not name to the else branch, so widening the union would
  // have quietly scored `cscv` as CPCV
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

/**
 * Anchored walk-forward: train always starts at the window start and grows,
 * test is the next contiguous slice forward in time. Never trains on data
 * after the test slice — that ordering is the whole point of the scheme.
 */
function walkForwardSplits(window: DateRange, options: SplitOptions): Split[] {
  const groups = partition(window, WALK_FORWARD_FOLDS + 1);
  const embargoMs = options.embargo * options.barMs;
  const splits: Split[] = [];

  for (let fold = 1; fold <= WALK_FORWARD_FOLDS; fold++) {
    const test = at(groups, fold);
    // Purge the run-up to the test slice: the bars immediately before it
    // overlap the test labels, so training on them leaks forward
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

/**
 * Combinatorial Purged CV: every C(6,2) = 15 choice of test groups, with the
 * remaining groups as train, purged and embargoed around each test group
 */
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

/**
 * Purged k-fold (López de Prado, AFML ch. 7) — the partition CSCV, and so
 * `pbo()`, is defined over. Six contiguous groups; fold `f` tests group `f` and
 * trains on the other five, purged and embargoed around the held-out group.
 *
 * **One contiguous test range per fold, deliberately.** That is what separates
 * this from the `cpcv` scheme, whose *k*-group test side `eval-executor.ts`
 * still refuses to score: `MetricsSuite.exposure` takes its denominator from a
 * single `TradeSeries.window`, so a test side spanning a gap under-reports
 * exposure. Holding out one group at a time sidesteps that entirely — the
 * sample *is* the range — rather than working around it. This is why the
 * stage-2 spec's "CPCV scoring — out of scope" note does not bar this pass;
 * the reason behind that note does not apply here.
 *
 * Every fold is scored out-of-sample against the same window as every other,
 * which is what makes the configs x folds matrix `pbo()` ranks over a genuine
 * comparison rather than an artifact of unequal samples.
 */
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

/**
 * Remove the embargo zone around every test group from one train group. The
 * zone is symmetric — bars just *before* a test group share labels with it
 * (purge) and bars just *after* are still correlated with it (embargo) — so a
 * test group sandwiched inside a train group can split it into two ranges,
 * which is why `Split.train` is a list.
 */
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

/** Split the window into `count` contiguous, equal-duration groups */
function partition(window: DateRange, count: number): DateRange[] {
  const startMs = window.start.getTime();
  const groupMs = (window.end.getTime() - startMs) / count;

  return Array.from({ length: count }, (_, index) => ({
    start: new Date(startMs + index * groupMs),
    end: index === count - 1 ? window.end : new Date(startMs + (index + 1) * groupMs),
  }));
}

/**
 * Indexed read that states the invariant instead of assuming it. `partition`
 * has already produced every group the callers index into, so a miss is a bug
 * in this module rather than bad input — but a silently-dropped group would
 * emit a split with a quietly smaller train set, which is precisely the kind
 * of undetectable degradation these splits exist to rule out.
 */
function at(groups: readonly DateRange[], index: number): DateRange {
  const group = groups[index];

  if (group === undefined) {
    throw new Error(`generateSplits: no group at index ${index} of ${groups.length}.`);
  }

  return group;
}

/** All ascending index combinations of `choose` out of `n` */
function combinations(n: number, choose: number): number[][] {
  const result: number[][] = [];

  const walk = (start: number, picked: number[]): void => {
    if (picked.length === choose) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index < n; index++) {
      walk(index + 1, [...picked, index]);
    }
  };

  walk(0, []);
  return result;
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
