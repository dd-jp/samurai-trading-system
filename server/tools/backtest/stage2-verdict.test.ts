import type { EvalReport } from './eval-types.js';
import { KILL_LINE, killLineChecks, renderStage2Verdict } from './stage2-verdict.js';
import type { TrialGridResult } from './trial-execution.js';
import type { DateRange } from './universe.js';
import type { MetricsSuite } from './validation-types.js';

const FIVE_YEAR_WINDOW: DateRange = {
  start: new Date('2021-01-01T00:00:00.000Z'),
  end: new Date('2026-01-01T00:00:00.000Z'),
};

function metrics(sharpe: number, overrides: Partial<MetricsSuite> = {}): MetricsSuite {
  return {
    sharpe,
    sortino: sharpe,
    calmar: sharpe,
    max_drawdown: 0.1,
    profit_factor: 1.5,
    expectancy: 10,
    skew: 0,
    kurtosis: 0,
    turnover: 1,
    exposure: 0.5,
    // The DSR inputs (#406). `per_period_sharpe` is deliberately not derived
    // from `sharpe`: DSR reads the per-period statistic, and a helper that tied
    // them together would hide a caller reaching for the annualized one.
    per_period_sharpe: 0.1,
    annualization_factor: 15.87,
    observations: 1000,
    ...overrides,
  };
}

/** One config's fake EvalReport, with 5 walk-forward folds — matching the spec's fixed fold count. */
function fakeReport(
  foldSharpes: number[],
  windowSharpe: number,
  windowOverrides: Partial<MetricsSuite> = {},
): EvalReport {
  return {
    window: metrics(windowSharpe, windowOverrides),
    splits: foldSharpes.map((sharpe) => ({
      split: { train: [FIVE_YEAR_WINDOW], test: [FIVE_YEAR_WINDOW] },
      metrics: metrics(sharpe),
    })),
  };
}

interface TrialOverrides {
  windowSharpe?: number;
  /** The CSCV pass's per-fold sharpes — omit entirely to model a grid run without it. */
  cscvFoldSharpes?: number[];
  /** Model a CSCV pass that threw (e.g. a barren fold). */
  cscvError?: string;
  window?: Partial<MetricsSuite>;
}

function trialResult(
  config_hash: string,
  asset_class: 'crypto' | 'stocks',
  foldSharpes: number[],
  overrides: TrialOverrides = {},
): TrialGridResult {
  const cscv =
    overrides.cscvError !== undefined
      ? { error: overrides.cscvError }
      : overrides.cscvFoldSharpes !== undefined
        ? { report: fakeReport(overrides.cscvFoldSharpes, 1) }
        : undefined;

  return {
    config_hash,
    config: {
      fastWindow: 10,
      slowWindow: 30,
      atrWindow: 14,
      atrStopMult: 2,
      atrTargetMult: 3,
      allowShort: true,
    },
    asset_class,
    report: fakeReport(foldSharpes, overrides.windowSharpe ?? 1, overrides.window ?? {}),
    ...(cscv === undefined ? {} : { cscv }),
  };
}

describe('killLineChecks', () => {
  it('computes OOS sharpe as the mean of the walk-forward test-fold sharpes, not the window sharpe', () => {
    const result = trialResult('hash-a', 'stocks', [0.4, 0.6, 0.5, 0.7, 0.3], {
      windowSharpe: 1.5,
    });

    const [check] = killLineChecks([result]);

    expect(check?.oos_sharpe).toBeCloseTo(0.5, 10);
    expect(check?.window_sharpe).toBe(1.5);
    expect(check?.fold_sharpes).toEqual([0.4, 0.6, 0.5, 0.7, 0.3]);
  });

  it('flags passes_oos_sharpe_line = false when OOS sharpe is below the 0.5 kill line', () => {
    const result = trialResult('hash-a', 'stocks', [0.1, 0.2, 0.3, 0.1, 0.2]);

    const [check] = killLineChecks([result]);

    expect(check?.passes_oos_sharpe_line).toBe(false);
  });

  it('flags passes_oos_sharpe_line = true when OOS sharpe is at or above the 0.5 kill line', () => {
    const result = trialResult('hash-a', 'stocks', [0.5, 0.5, 0.5, 0.5, 0.5]);

    const [check] = killLineChecks([result]);

    expect(check?.passes_oos_sharpe_line).toBe(true);
  });

  it('reports one check per (config, asset class) pair, in input order', () => {
    const results = [
      trialResult('hash-a', 'stocks', [0.5, 0.5, 0.5, 0.5, 0.5]),
      trialResult('hash-b', 'crypto', [0.6, 0.6, 0.6, 0.6, 0.6]),
    ];

    const checks = killLineChecks(results);

    expect(checks.map((c) => [c.config_hash, c.asset_class])).toEqual([
      ['hash-a', 'stocks'],
      ['hash-b', 'crypto'],
    ]);
  });
});

describe('renderStage2Verdict', () => {
  it('computes a real MinBTL limit from the window and N even with zero trial results', () => {
    const verdict = renderStage2Verdict({
      results: [],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    // 5 years of data supports ~45 independent trials per overfitting.ts's own calibration note.
    expect(verdict.min_btl.limit).toBeGreaterThanOrEqual(40);
    expect(verdict.min_btl.limit).toBeLessThanOrEqual(50);
    expect(verdict.min_btl.distinct_configs).toBe(12);
    expect(verdict.min_btl.exceeded).toBe(false);
  });

  it('forwards an explicit expectedAnnualSharpe to the MinBTL check (#637)', () => {
    // At the default E[SR]=1.0, 12 trials over 5 years is comfortably under
    // the ~45-trial cap. At the measured 0.71, the cap for the same window is
    // 10 — so the same N now exceeds it.
    const atDefault = renderStage2Verdict({
      results: [],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });
    const atMeasured = renderStage2Verdict({
      results: [],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
      expectedAnnualSharpe: 0.71,
    });

    expect(atDefault.min_btl.exceeded).toBe(false);
    expect(atMeasured.min_btl.limit).toBe(10);
    expect(atMeasured.min_btl.exceeded).toBe(true);
  });

  it('reports no_real_trial_data for PBO when results is empty', () => {
    const verdict = renderStage2Verdict({
      results: [],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toEqual([
      {
        error: 'no_real_trial_data',
        detail: expect.stringContaining('No TrialGridResult entries'),
      },
    ]);
  });

  it('reports cscv_pass_not_run when the grid was run without the CSCV pass', () => {
    // The spec-shaped 5-fold walk-forward result on its own: real trial data,
    // but nothing PBO can rank across. Before #406 this was the permanent
    // state of every run.
    const results = [
      trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5]),
      trialResult('hash-b', 'stocks', [0.3, 0.2, 0.4, 0.1, 0.3]),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toEqual([
      {
        error: 'cscv_pass_not_run',
        asset_class: 'stocks',
        detail: expect.stringContaining('2 of 2 configs'),
      },
    ]);
  });

  it('computes PBO from the CSCV pass, not from the walk-forward folds', () => {
    // Walk-forward stays at the spec's 5 folds — an odd count `pbo()` rejects.
    // Only the 6-fold CSCV pass makes PBO computable, which is the whole seam.
    const results = [
      trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5], {
        cscvFoldSharpes: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
      }),
      trialResult('hash-b', 'stocks', [0.3, 0.2, 0.4, 0.1, 0.3], {
        cscvFoldSharpes: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      }),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toHaveLength(1);
    const outcome = verdict.pbo[0];
    expect(outcome && 'result' in outcome).toBe(true);
    if (outcome && 'result' in outcome) {
      expect(outcome.result.pbo).toBeGreaterThanOrEqual(0);
      expect(outcome.result.pbo).toBeLessThanOrEqual(1);
      // hash-a dominates hash-b on every fold, so the IS-best config is also
      // the OOS-best on every partition — PBO is 0, the "no selection noise"
      // extreme. Asserted to prove the matrix reached `pbo()` in fold order
      // rather than being reduced to a number somewhere on the way.
      expect(outcome.result.pbo).toBe(0);
      expect(outcome.result.verdict).toBe('accept');
    }
  });

  it('reports pbo_requires_even_fold_count if a CSCV pass ever yields an odd fold count', () => {
    const results = [
      trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5], {
        cscvFoldSharpes: [0.9, 0.9, 0.9],
      }),
      trialResult('hash-b', 'stocks', [0.3, 0.2, 0.4, 0.1, 0.3], {
        cscvFoldSharpes: [0.1, 0.1, 0.1],
      }),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toEqual([
      {
        error: 'pbo_requires_even_fold_count',
        asset_class: 'stocks',
        detail: expect.stringContaining('3 folds'),
      },
    ]);
  });

  it('refuses PBO for the whole asset class when one config CSCV pass failed', () => {
    // A partial matrix is not a smaller matrix: PBO ranks configs against each
    // other fold by fold, so a missing row would silently change the ranking.
    const results = [
      trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5], {
        cscvFoldSharpes: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
      }),
      trialResult('hash-b', 'stocks', [0.3, 0.2, 0.4, 0.1, 0.3], {
        cscvError: 'computeMetrics: return series has zero variance',
      }),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toEqual([
      {
        error: 'cscv_pass_failed',
        asset_class: 'stocks',
        detail: expect.stringContaining('zero variance'),
      },
    ]);
  });

  it('computes PBO independently per asset class instead of dropping all but the first', () => {
    // Stocks carries a CSCV pass (computable); crypto does not. Both must be
    // reported — neither should silently overwrite or hide the other.
    const results = [
      trialResult('hash-a', 'stocks', [0.9, 0.9, 0.9, 0.9, 0.9], {
        cscvFoldSharpes: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
      }),
      trialResult('hash-b', 'stocks', [0.1, 0.1, 0.1, 0.1, 0.1], {
        cscvFoldSharpes: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      }),
      trialResult('hash-c', 'crypto', [0.5, 0.6, 0.4, 0.7, 0.5]),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toHaveLength(2);
    const stocksOutcome = verdict.pbo.find((o) => o.asset_class === 'stocks');
    const cryptoOutcome = verdict.pbo.find((o) => o.asset_class === 'crypto');
    expect(stocksOutcome && 'result' in stocksOutcome).toBe(true);
    expect(cryptoOutcome && 'error' in cryptoOutcome).toBe(true);
    expect(verdict.overall_pass).toBe(false);
  });

  it('computes a real DSR from the per-period Sharpe the metrics suite now carries', () => {
    const verdict = renderStage2Verdict({
      results: [trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5])],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.dsr).toHaveLength(1);
    const outcome = verdict.dsr[0];
    expect(outcome && 'result' in outcome).toBe(true);
    if (outcome && 'result' in outcome) {
      expect(outcome.result.dsr).toBeGreaterThan(0);
      expect(outcome.result.dsr).toBeLessThan(1);
      expect(outcome.result.per_period_sharpe).toBe(0.1);
      expect(outcome.result.observations).toBe(1000);
      expect(outcome.result.n_distinct_trials).toBe(12);
    }
  });

  it('deflates harder as N rises — the entire point of the statistic', () => {
    const results = [trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5])];

    const dsrAt = (distinctTrialCount: number): number => {
      const outcome = renderStage2Verdict({
        results,
        distinctTrialCount,
        window: FIVE_YEAR_WINDOW,
      }).dsr[0];

      if (outcome === undefined || !('result' in outcome)) {
        throw new Error('expected a computed DSR');
      }
      return outcome.result.dsr;
    };

    expect(dsrAt(100)).toBeLessThan(dsrAt(12));
    expect(dsrAt(12)).toBeLessThan(dsrAt(2));
  });

  it('deflates the config the search would have selected — highest OOS Sharpe, not first or best-window', () => {
    const results = [
      // Best whole-window Sharpe, worst OOS — the cherry-pick to avoid.
      trialResult('hash-a', 'stocks', [0.1, 0.1, 0.1, 0.1, 0.1], { windowSharpe: 9 }),
      trialResult('hash-b', 'stocks', [0.9, 0.9, 0.9, 0.9, 0.9], { windowSharpe: 1 }),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    const outcome = verdict.dsr[0];
    expect(outcome && 'result' in outcome && outcome.result.config_hash).toBe('hash-b');
  });

  it('refuses DSR rather than fabricating one when the variance term is non-positive', () => {
    // A high Sharpe with strong positive skew drives 1 - skew*SR + ... below 0,
    // which deflatedSharpe() rejects. Real samples can produce this.
    const results = [
      trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5], {
        window: { per_period_sharpe: 1, skew: 3 },
      }),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.dsr).toEqual([
      {
        error: 'dsr_variance_term_non_positive',
        asset_class: 'stocks',
        detail: expect.stringContaining('hash-a'),
      },
    ]);
    expect(verdict.overall_pass).toBe(false);
  });

  it('never reports overall_pass = true when the DSR line fails, even with PBO and OOS Sharpe clear', () => {
    const results = [
      trialResult('hash-a', 'stocks', [0.9, 0.9, 0.9, 0.9, 0.9], {
        cscvFoldSharpes: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
        // 0.1 per-period over 1000 observations deflates to ~0.93 at N=12 —
        // below the 0.95 line.
        window: { per_period_sharpe: 0.1 },
      }),
      trialResult('hash-b', 'stocks', [0.9, 0.9, 0.9, 0.9, 0.9], {
        cscvFoldSharpes: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      }),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.kill_line_checks.every((c) => c.passes_oos_sharpe_line)).toBe(true);
    expect(verdict.pbo.every((o) => 'result' in o && o.result.verdict === 'accept')).toBe(true);
    const outcome = verdict.dsr[0];
    expect(outcome && 'result' in outcome && outcome.result.passes_dsr_line).toBe(false);
    expect(verdict.overall_pass).toBe(false);
  });

  it('reports overall_pass = true only when MinBTL, OOS Sharpe, PBO and DSR all clear', () => {
    // The one configuration in which the gate passes — asserted so the pass
    // path is exercised, not just the many ways it fails.
    const results = [
      trialResult('hash-a', 'stocks', [0.9, 0.9, 0.9, 0.9, 0.9], {
        cscvFoldSharpes: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
        window: { per_period_sharpe: 0.2 },
      }),
      trialResult('hash-b', 'stocks', [0.8, 0.8, 0.8, 0.8, 0.8], {
        cscvFoldSharpes: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      }),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.min_btl.exceeded).toBe(false);
    expect(verdict.overall_pass).toBe(true);
  });

  it('reports no_real_trial_data for DSR when results is empty', () => {
    const verdict = renderStage2Verdict({
      results: [],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.dsr).toEqual([
      { error: 'no_real_trial_data', detail: expect.stringContaining('No TrialGridResult') },
    ]);
  });

  it('never reports overall_pass = true when results is empty', () => {
    const verdict = renderStage2Verdict({
      results: [],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.overall_pass).toBe(false);
  });

  it('never reports overall_pass = true when PBO could not be computed, even if the OOS-sharpe checks pass', () => {
    const results = [
      trialResult('hash-a', 'stocks', [0.9, 0.9, 0.9, 0.9, 0.9]),
      trialResult('hash-b', 'stocks', [0.9, 0.9, 0.9, 0.9, 0.9]),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.kill_line_checks.every((c) => c.passes_oos_sharpe_line)).toBe(true);
    expect(verdict.pbo.every((o) => 'error' in o)).toBe(true);
    expect(verdict.overall_pass).toBe(false);
  });

  it('exposes the same KILL_LINE.minOosSharpe used by killLineChecks', () => {
    expect(KILL_LINE.minOosSharpe).toBe(0.5);
    expect(KILL_LINE.maxPbo).toBe(0.05);
    // Not a spec value — see the constant's comment. Pinned so a change to the
    // DSR confidence level is a deliberate edit, not a drift.
    expect(KILL_LINE.minDsr).toBe(0.95);
  });
});
