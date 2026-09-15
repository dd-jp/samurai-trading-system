import {
  deflatedSharpe,
  MINBTL_TARGET_ANNUAL_SHARPE,
  minbtl,
  minbtlGuard,
  pbo,
} from './overfitting.js';
import type { DateRange } from './universe.js';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function yearsWindow(years: number): DateRange {
  const start = new Date('2020-01-01T00:00:00Z');
  return { start, end: new Date(start.getTime() + years * MS_PER_YEAR) };
}

describe('deflatedSharpe', () => {
  it('falls as the distinct-config count rises for a fixed Sharpe', () => {
    // The core property (user story 15): the same backtest is worth less when
    // you had to try a hundred configs to find it
    const one = deflatedSharpe(0.15, 1, 250, 0, 0);
    const ten = deflatedSharpe(0.15, 10, 250, 0, 0);
    const hundred = deflatedSharpe(0.15, 100, 250, 0, 0);
    const thousand = deflatedSharpe(0.15, 1000, 250, 0, 0);

    expect(ten).toBeLessThan(one);
    expect(hundred).toBeLessThan(ten);
    expect(thousand).toBeLessThan(hundred);
  });

  it('turns a Sharpe that survives one trial into one that fails a thousand', () => {
    const sharpe = 0.12;

    expect(deflatedSharpe(sharpe, 1, 250, 0, 0)).toBeGreaterThan(0.95);
    expect(deflatedSharpe(sharpe, 1000, 250, 0, 0)).toBeLessThan(0.95);
  });

  it('returns a probability in (0, 1)', () => {
    const dsr = deflatedSharpe(0.1, 20, 500, -0.3, 2);

    expect(dsr).toBeGreaterThan(0);
    expect(dsr).toBeLessThan(1);
  });

  describe('consumes the non-normality inputs', () => {
    it('penalises negative skew relative to a symmetric sample', () => {
      // Negative skew inflates the Sharpe estimator's variance, so the same
      // Sharpe is less trustworthy. If skew is ignored, these are equal.
      const symmetric = deflatedSharpe(0.15, 50, 250, 0, 0);
      const negativelySkewed = deflatedSharpe(0.15, 50, 250, -1.5, 0);

      expect(negativelySkewed).toBeLessThan(symmetric);
    });

    it('penalises fat tails relative to a normal sample', () => {
      const normal = deflatedSharpe(0.15, 50, 250, 0, 0);
      const fatTailed = deflatedSharpe(0.15, 50, 250, 0, 8);

      expect(fatTailed).toBeLessThan(normal);
    });
  });

  describe('rejects unusable inputs', () => {
    it('throws on a non-integer or zero config count', () => {
      expect(() => deflatedSharpe(0.1, 0, 250, 0, 0)).toThrow(/integer >= 1/);
      expect(() => deflatedSharpe(0.1, 2.5, 250, 0, 0)).toThrow(/integer >= 1/);
    });

    it('throws on a sample too short to deflate', () => {
      expect(() => deflatedSharpe(0.1, 10, 1, 0, 0)).toThrow(/sampleLen must be >= 2/);
    });
  });
});

describe('pbo', () => {
  /**
   * The synthetic overfit case the spec names (Testing Decisions): every
   * config is pure noise, so whichever looks best in-sample is best by luck
   * and lands wherever chance puts it out-of-sample. PBO must be high.
   */
  it('flags a synthetic overfit case as > 0.05 and rejects it', () => {
    const noise = noiseMatrix(10, 8);

    const result = pbo(noise);

    expect(result.pbo).toBeGreaterThan(0.05);
    expect(result.verdict).toBe('reject');
  });

  it('accepts a config with genuine, persistent out-of-sample edge', () => {
    // Config 0 is better on every fold — its in-sample win is not luck, so it
    // stays on top out-of-sample and PBO collapses
    const performance = [
      [2.0, 2.1, 1.9, 2.0, 2.1, 1.95, 2.05, 2.0],
      [0.1, 0.2, 0.05, 0.15, 0.1, 0.2, 0.05, 0.1],
      [-0.1, 0.0, -0.2, 0.1, -0.05, 0.05, -0.1, 0.0],
      [0.3, 0.2, 0.4, 0.25, 0.35, 0.3, 0.2, 0.3],
    ];

    const result = pbo(performance);

    expect(result.pbo).toBeLessThanOrEqual(0.05);
    expect(result.verdict).toBe('accept');
  });

  it('puts the kill line at exactly 0.05 — above rejects, at or below accepts', () => {
    // 20 partitions (6 folds choose 3) means PBO lands on multiples of 0.05
    const result = pbo(noiseMatrix(6, 6));

    expect(result.verdict).toBe(result.pbo > 0.05 ? 'reject' : 'accept');
  });

  it('returns a probability in [0, 1]', () => {
    const result = pbo(noiseMatrix(8, 8));

    expect(result.pbo).toBeGreaterThanOrEqual(0);
    expect(result.pbo).toBeLessThanOrEqual(1);
  });

  describe('rejects inputs it cannot rank', () => {
    it('throws on fewer than two configs — a ranking of one is vacuous', () => {
      expect(() => pbo([[1, 2, 3, 4]])).toThrow(/>= 2 configs/);
    });

    it('throws on an odd fold count — CSCV partitions folds into halves', () => {
      expect(() =>
        pbo([
          [1, 2, 3, 4, 5],
          [2, 3, 4, 5, 6],
        ]),
      ).toThrow(/even fold count/);
    });

    it('throws on a ragged matrix', () => {
      expect(() =>
        pbo([
          [1, 2, 3, 4],
          [1, 2, 3],
        ]),
      ).toThrow(/same 4 folds/);
    });
  });
});

describe('minbtl', () => {
  it('reproduces the spec calibration: ~5 years of data supports ~45 trials', () => {
    const { limit } = minbtl(yearsWindow(5));

    expect(limit).toBeGreaterThanOrEqual(40);
    expect(limit).toBeLessThanOrEqual(50);
  });

  it('supports more trials as the window lengthens', () => {
    expect(minbtl(yearsWindow(10)).limit).toBeGreaterThan(minbtl(yearsWindow(5)).limit);
    expect(minbtl(yearsWindow(5)).limit).toBeGreaterThan(minbtl(yearsWindow(2)).limit);
  });

  it('throws on an inverted window', () => {
    expect(() => minbtl({ start: new Date('2025-01-01'), end: new Date('2024-01-01') })).toThrow(
      /end > start/,
    );
  });

  it('defaults expectedAnnualSharpe to the declared E[SR] = 1.0 constant', () => {
    // The default parameter and the exported constant must agree — a caller
    // that omits the argument gets exactly what MINBTL_TARGET_ANNUAL_SHARPE
    // says it should
    const window = yearsWindow(5);

    expect(minbtl(window).limit).toBe(minbtl(window, MINBTL_TARGET_ANNUAL_SHARPE).limit);
    expect(MINBTL_TARGET_ANNUAL_SHARPE).toBe(1);
  });

  it('throws on a non-positive expectedAnnualSharpe', () => {
    expect(() => minbtl(yearsWindow(5), 0)).toThrow(/expectedAnnualSharpe/);
    expect(() => minbtl(yearsWindow(5), -0.5)).toThrow(/expectedAnnualSharpe/);
  });

  /**
   * Issue #637 (spec-research-alignment F3): E[SR] = 1.0 is a hardcoded
   * judgement call, not a measurement, and `minimumBacktestLengthYears`
   * divides by it *squared* — so a lower E[SR] shrinks the trial-budget cap
   * fast. This pins the table the issue derived, comparing the default
   * (1.0, López de Prado's reference case) against the one Sharpe this
   * project has actually measured under the now-superseded doc 10
   * configuration (0.71, `docs/research/10-edge-hypothesis.md`). Every
   * number this project has quoted for MinBTL headroom (the 7 that #405
   * sized the grid to, the spec's "~45 / 5 yr", doc 13's ~812-at-10.2y) is
   * the E[SR] = 1.0 row — this test exists so that fact stays visible
   * instead of being rediscovered by accident.
   *
   * This does NOT change which E[SR] is operative (still 1.0, unchanged by
   * this ticket) — it only proves the sensitivity is real and pins its
   * magnitude so a future edit can't silently erase it.
   */
  it('E[SR] sensitivity: the trial-budget cap at the measured 0.71 vs the declared 1.0 default', () => {
    const cases: Array<{ years: number; capAt1: number; capAt071: number }> = [
      { years: 1.99, capAt1: 7, capAt071: 3 },
      { years: 5, capAt1: 45, capAt071: 10 },
      { years: 10.2, capAt1: 807, capAt071: 48 },
    ];

    for (const { years, capAt1, capAt071 } of cases) {
      const window = yearsWindow(years);

      expect(minbtl(window, 1.0).limit).toBe(capAt1);
      expect(minbtl(window, 0.71).limit).toBe(capAt071);
    }
  });
});

describe('minbtlGuard', () => {
  it('flags a trial count exceeding the cap for the data length', () => {
    const window = yearsWindow(5);
    const { limit } = minbtl(window);

    const verdict = minbtlGuard(window, limit + 1);

    expect(verdict.exceeded).toBe(true);
    expect(verdict.limit).toBe(limit);
    expect(verdict.distinct_configs).toBe(limit + 1);
  });

  it('does not flag a trial count within the cap', () => {
    const window = yearsWindow(5);
    const { limit } = minbtl(window);

    expect(minbtlGuard(window, limit).exceeded).toBe(false);
    expect(minbtlGuard(window, 1).exceeded).toBe(false);
  });

  it('flags a short window that a large search has out-searched', () => {
    // 1 year of data cannot support 45 configs, however good they look
    const verdict = minbtlGuard(yearsWindow(1), 45);

    expect(verdict.exceeded).toBe(true);
  });

  it('throws on a negative or non-integer config count', () => {
    expect(() => minbtlGuard(yearsWindow(5), -1)).toThrow(/integer >= 0/);
    expect(() => minbtlGuard(yearsWindow(5), 1.5)).toThrow(/integer >= 0/);
  });

  it('accepts an explicit expectedAnnualSharpe and flags against that cap, not the default', () => {
    // 11 configs is within the E[SR]=1.0 cap for 5y (45) but exceeds the
    // E[SR]=0.71 cap for the same window (10)
    const window = yearsWindow(5);

    expect(minbtlGuard(window, 11).exceeded).toBe(false);
    expect(minbtlGuard(window, 11, 0.71).exceeded).toBe(true);
  });
});

/**
 * Configs that are pure noise — no config has real edge, so in-sample rank
 * carries no information about out-of-sample rank. Deterministic (a fixed
 * trigonometric hash) so the assertion is reproducible.
 */
function noiseMatrix(configs: number, folds: number): number[][] {
  return Array.from({ length: configs }, (_, c) =>
    Array.from({ length: folds }, (_, f) => Math.sin((c + 1) * 12.9898 + (f + 1) * 78.233) * 2),
  );
}
