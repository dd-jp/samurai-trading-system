import { describe, expect, it } from 'vitest';
import { generateSplits } from './splits.js';
import type { DateRange } from './universe.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A 600-day window: divides evenly by both scheme's fold counts. */
const WINDOW: DateRange = {
  start: new Date('2024-01-01T00:00:00Z'),
  end: new Date('2025-08-23T00:00:00Z'),
};

const NO_EMBARGO = { embargo: 0, barMs: DAY_MS };

function overlaps(a: DateRange, b: DateRange): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

describe('generateSplits', () => {
  describe('walk_forward', () => {
    it('produces a distribution of folds, not a single train/test path', () => {
      const splits = generateSplits(WINDOW, 'walk_forward', NO_EMBARGO);

      // User story 14: the whole point is a distribution of OOS results.
      expect(splits.length).toBeGreaterThan(1);
    });

    it('never trains on data at or after the test slice', () => {
      for (const split of generateSplits(WINDOW, 'walk_forward', NO_EMBARGO)) {
        for (const test of split.test) {
          for (const train of split.train) {
            expect(train.end.getTime()).toBeLessThanOrEqual(test.start.getTime());
          }
        }
      }
    });

    it('walks the test slice forward in time across folds', () => {
      const splits = generateSplits(WINDOW, 'walk_forward', NO_EMBARGO);

      for (let index = 1; index < splits.length; index++) {
        expect(splits[index].test[0].start.getTime()).toBeGreaterThan(
          splits[index - 1].test[0].start.getTime(),
        );
      }
    });

    it('purges the embargoed run-up to the test slice out of the train set', () => {
      const embargo = 10;
      const [split] = generateSplits(WINDOW, 'walk_forward', { embargo, barMs: DAY_MS });
      const [unpurged] = generateSplits(WINDOW, 'walk_forward', NO_EMBARGO);

      const gap = split.test[0].start.getTime() - split.train[0].end.getTime();
      expect(gap).toBe(embargo * DAY_MS);
      expect(split.train[0].end.getTime()).toBeLessThan(unpurged.train[0].end.getTime());
    });
  });

  describe('cpcv', () => {
    it('produces every symmetric combination of held-out groups', () => {
      // 6 groups choose 2 = 15 paths.
      expect(generateSplits(WINDOW, 'cpcv', NO_EMBARGO)).toHaveLength(15);
    });

    it('holds out two disjoint test groups per split', () => {
      for (const split of generateSplits(WINDOW, 'cpcv', NO_EMBARGO)) {
        expect(split.test).toHaveLength(2);
        expect(overlaps(split.test[0], split.test[1])).toBe(false);
      }
    });

    it('never leaves a train range overlapping a test range', () => {
      for (const split of generateSplits(WINDOW, 'cpcv', NO_EMBARGO)) {
        for (const test of split.test) {
          for (const train of split.train) {
            expect(overlaps(train, test)).toBe(false);
          }
        }
      }
    });

    it('purges and embargoes the train set on both sides of each test group', () => {
      const embargo = 5;
      const embargoMs = embargo * DAY_MS;

      for (const split of generateSplits(WINDOW, 'cpcv', { embargo, barMs: DAY_MS })) {
        for (const test of split.test) {
          for (const train of split.train) {
            // Train must sit wholly outside [test.start - embargo, test.end + embargo]:
            // adjacent bars share label information with the test set, so
            // leaving them in leaks it into training.
            const clearBefore = train.end.getTime() <= test.start.getTime() - embargoMs;
            const clearAfter = train.start.getTime() >= test.end.getTime() + embargoMs;
            expect(clearBefore || clearAfter).toBe(true);
          }
        }
      }
    });

    it('splits a train group into two ranges when a test group sits inside it', () => {
      // Groups 0 and 5 held out leaves 1-4 contiguous; groups 1 and 4 held out
      // leaves 0, 2-3, 5 — a discontiguous train set. Some split must therefore
      // carry more ranges than a single contiguous block.
      const splits = generateSplits(WINDOW, 'cpcv', NO_EMBARGO);

      expect(splits.some((split) => split.train.length > 1)).toBe(true);
    });
  });

  describe('rejects unusable inputs rather than emitting a silently-degraded split', () => {
    it('throws when the window is inverted', () => {
      expect(() =>
        generateSplits({ start: WINDOW.end, end: WINDOW.start }, 'cpcv', NO_EMBARGO),
      ).toThrow(/end > start/);
    });

    it('throws when the embargo would purge the entire training set', () => {
      expect(() => generateSplits(WINDOW, 'walk_forward', { embargo: 500, barMs: DAY_MS })).toThrow(
        /purges the entire training set/,
      );
    });

    it('throws on a negative embargo', () => {
      expect(() => generateSplits(WINDOW, 'cpcv', { embargo: -1, barMs: DAY_MS })).toThrow(
        /embargo must be >= 0/,
      );
    });

    it('throws on a non-positive bar duration', () => {
      expect(() => generateSplits(WINDOW, 'cpcv', { embargo: 1, barMs: 0 })).toThrow(
        /barMs must be > 0/,
      );
    });
  });
});
