import { selectionsFrom } from './stage2-selection.js';
import type { Stage2Verdict } from './stage2-verdict.js';
import type { TrialGridResult } from './trial-execution.js';

const WINDOW = { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') };
const SELECTED_AT = new Date('2026-08-06T09:00:00Z');

function check(config_hash: string, asset_class: 'crypto' | 'stocks', oos_sharpe: number) {
  return {
    config_hash,
    asset_class,
    oos_sharpe,
    window_sharpe: oos_sharpe + 0.5,
    fold_sharpes: [oos_sharpe - 0.1, oos_sharpe + 0.1],
    passes_oos_sharpe_line: oos_sharpe >= 0.5,
  };
}

function result(
  config_hash: string,
  asset_class: 'crypto' | 'stocks',
  windowSharpe: number,
): TrialGridResult {
  return {
    config_hash,
    asset_class,
    report: { window: { sharpe: windowSharpe } },
  } as unknown as TrialGridResult;
}

function verdict(overrides: Partial<Stage2Verdict> = {}): Stage2Verdict {
  return {
    n_distinct_trials: 24,
    min_btl: {} as Stage2Verdict['min_btl'],
    kill_line_checks: [check('cfg-a', 'crypto', 0.9), check('cfg-b', 'crypto', 0.4)],
    pbo: [{ result: { pbo: 0.2, verdict: 'reject' }, asset_class: 'crypto' }],
    dsr: [
      {
        result: {
          config_hash: 'cfg-a',
          n_distinct_trials: 24,
          per_period_sharpe: 0.08,
          observations: 500,
          dsr: 0.42,
          passes_dsr_line: false,
        },
        asset_class: 'crypto',
      },
    ],
    overall_pass: false,
    ...overrides,
  };
}

describe('selectionsFrom', () => {
  it('freezes the highest out-of-sample Sharpe — the same config the DSR deflates', () => {
    const selections = selectionsFrom({
      verdict: verdict(),
      results: [result('cfg-a', 'crypto', 1.4), result('cfg-b', 'crypto', 0.8)],
      window: WINDOW,
      selectedAt: SELECTED_AT,
    });

    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({
      config_hash: 'cfg-a',
      asset_class: 'crypto',
      backtest_sharpe: 1.4,
      oos_sharpe: 0.9,
      pbo: 0.2,
      dsr: 0.42,
      n_trials: 24,
      overall_pass: false,
    });
    expect(selections[0]?.window).toEqual(WINDOW);
  });

  it('carries the fold Sharpes — the walk-forward distribution the snapshot reports', () => {
    const selections = selectionsFrom({
      verdict: verdict(),
      results: [result('cfg-a', 'crypto', 1.4)],
      window: WINDOW,
      selectedAt: SELECTED_AT,
    });

    expect(selections[0]?.fold_sharpes).toEqual([0.8, 1.0]);
  });

  it('freezes one selection per asset class', () => {
    const selections = selectionsFrom({
      verdict: verdict({
        kill_line_checks: [check('cfg-a', 'crypto', 0.9), check('cfg-c', 'stocks', 0.7)],
        pbo: [
          { result: { pbo: 0.2, verdict: 'reject' }, asset_class: 'crypto' },
          { result: { pbo: 0.01, verdict: 'accept' }, asset_class: 'stocks' },
        ],
      }),
      results: [result('cfg-a', 'crypto', 1.4), result('cfg-c', 'stocks', 1.1)],
      window: WINDOW,
      selectedAt: SELECTED_AT,
    });

    expect(selections.map((selection) => selection.asset_class)).toEqual(['crypto', 'stocks']);
    expect(selections[1]?.pbo).toBe(0.01);
    expect(selections[1]?.dsr).toBeNull();
  });

  it('stores NULL for a refused PBO rather than a zero', () => {
    const selections = selectionsFrom({
      verdict: verdict({
        pbo: [{ error: 'no_real_trial_data', detail: 'nothing to rank' }],
      }),
      results: [result('cfg-a', 'crypto', 1.4)],
      window: WINDOW,
      selectedAt: SELECTED_AT,
    });

    expect(selections[0]?.pbo).toBeNull();
  });

  it('freezes nothing when the trial grid was empty', () => {
    expect(
      selectionsFrom({ verdict: verdict(), results: [], window: WINDOW, selectedAt: SELECTED_AT }),
    ).toEqual([]);
  });

  it('skips an asset class whose selected config has no matching result', () => {
    expect(
      selectionsFrom({
        verdict: verdict(),
        results: [result('cfg-other', 'crypto', 1.4)],
        window: WINDOW,
        selectedAt: SELECTED_AT,
      }),
    ).toEqual([]);
  });
});
