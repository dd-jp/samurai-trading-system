import { describe, expect, it } from 'vitest';
import type { EvalReport } from './eval-types.js';
import { KILL_LINE, killLineChecks, renderStage2Verdict } from './stage2-verdict.js';
import type { TrialGridResult } from './trial-execution.js';
import type { DateRange } from './universe.js';
import type { MetricsSuite } from './validation-types.js';

const FIVE_YEAR_WINDOW: DateRange = {
  start: new Date('2021-01-01T00:00:00.000Z'),
  end: new Date('2026-01-01T00:00:00.000Z'),
};

function metrics(sharpe: number): MetricsSuite {
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
  };
}

/** One config's fake EvalReport, with 5 walk-forward folds — matching the spec's fixed fold count. */
function fakeReport(foldSharpes: number[], windowSharpe: number): EvalReport {
  return {
    window: metrics(windowSharpe),
    splits: foldSharpes.map((sharpe) => ({
      split: { train: [FIVE_YEAR_WINDOW], test: [FIVE_YEAR_WINDOW] },
      metrics: metrics(sharpe),
    })),
  };
}

function trialResult(
  config_hash: string,
  asset_class: 'crypto' | 'stocks',
  foldSharpes: number[],
  windowSharpe = 1,
): TrialGridResult {
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
    report: fakeReport(foldSharpes, windowSharpe),
  };
}

describe('killLineChecks', () => {
  it('computes OOS sharpe as the mean of the walk-forward test-fold sharpes, not the window sharpe', () => {
    const result = trialResult('hash-a', 'stocks', [0.4, 0.6, 0.5, 0.7, 0.3], 1.5);

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

  it('reports no_real_trial_data for PBO when results is empty', () => {
    const verdict = renderStage2Verdict({
      results: [],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toEqual({
      error: 'no_real_trial_data',
      detail: expect.stringContaining('No TrialGridResult entries'),
    });
  });

  it('reports pbo_requires_even_fold_count for the spec-shaped 5-fold walk-forward grid', () => {
    // Two configs, 5 folds each (the spec's fixed fold count) — real trial
    // shape, but PBO's CSCV precondition needs an even fold count >= 4.
    const results = [
      trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5]),
      trialResult('hash-b', 'stocks', [0.3, 0.2, 0.4, 0.1, 0.3]),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toEqual({
      error: 'pbo_requires_even_fold_count',
      detail: expect.stringContaining('5 folds'),
    });
  });

  it('computes PBO when a config x fold matrix happens to have an even fold count >= 4', () => {
    const results = [
      trialResult('hash-a', 'stocks', [0.9, 0.9, 0.9, 0.9]),
      trialResult('hash-b', 'stocks', [0.1, 0.1, 0.1, 0.1]),
    ];

    const verdict = renderStage2Verdict({
      results,
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.pbo).toMatchObject({ asset_class: 'stocks' });
    if ('result' in verdict.pbo) {
      expect(verdict.pbo.result.pbo).toBeGreaterThanOrEqual(0);
      expect(verdict.pbo.result.pbo).toBeLessThanOrEqual(1);
    }
  });

  it('always reports the DSR gap as not computable, with a reason distinct from the PBO gap', () => {
    const verdict = renderStage2Verdict({
      results: [trialResult('hash-a', 'stocks', [0.5, 0.6, 0.4, 0.7, 0.5])],
      distinctTrialCount: 12,
      window: FIVE_YEAR_WINDOW,
    });

    expect(verdict.dsr_note.error).toBe(
      'dsr_requires_per_period_sharpe_not_exposed_by_metrics_suite',
    );
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
    expect('error' in verdict.pbo).toBe(true);
    expect(verdict.overall_pass).toBe(false);
  });

  it('exposes the same KILL_LINE.minOosSharpe used by killLineChecks', () => {
    expect(KILL_LINE.minOosSharpe).toBe(0.5);
    expect(KILL_LINE.maxPbo).toBe(0.05);
  });
});
