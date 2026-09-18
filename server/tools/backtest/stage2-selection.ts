import type { ConfigKillLineCheck, Stage2Verdict } from './stage2-verdict.js';
import type { TrialGridResult } from './trial-execution.js';
import type { DateRange } from './universe.js';

export interface Stage2Selection {
  config_hash: string;
  asset_class: 'crypto' | 'stocks';
  selected_at: Date;
  window: DateRange;
  backtest_sharpe: number;
  oos_sharpe: number;
  fold_sharpes: number[];
  pbo: number | null;
  dsr: number | null;
  n_trials: number;
  overall_pass: boolean;
}

export function selectionsFrom(deps: {
  verdict: Stage2Verdict;
  results: readonly TrialGridResult[];
  window: DateRange;
  selectedAt: Date;
}): Stage2Selection[] {
  const { verdict, results, window, selectedAt } = deps;
  if (results.length === 0) return [];

  const selections: Stage2Selection[] = [];

  for (const asset_class of ['crypto', 'stocks'] as const) {
    const checks = verdict.kill_line_checks.filter((check) => check.asset_class === asset_class);
    if (checks.length === 0) continue;

    const selected = bestByOosSharpe(checks);
    const result = results.find(
      (candidate) =>
        candidate.asset_class === asset_class && candidate.config_hash === selected.config_hash,
    );
    if (result === undefined) continue;

    selections.push({
      config_hash: selected.config_hash,
      asset_class,
      selected_at: selectedAt,
      window,
      backtest_sharpe: result.report.window.sharpe,
      oos_sharpe: selected.oos_sharpe,
      fold_sharpes: selected.fold_sharpes,
      pbo: pboFor(verdict, asset_class),
      dsr: dsrFor(verdict, asset_class),
      n_trials: verdict.n_distinct_trials,
      overall_pass: verdict.overall_pass,
    });
  }

  return selections;
}

function bestByOosSharpe(checks: readonly ConfigKillLineCheck[]): ConfigKillLineCheck {
  let best = checks[0] as ConfigKillLineCheck;
  for (const check of checks) {
    if (check.oos_sharpe > best.oos_sharpe) best = check;
  }
  return best;
}

function pboFor(verdict: Stage2Verdict, asset_class: 'crypto' | 'stocks'): number | null {
  for (const outcome of verdict.pbo) {
    if ('result' in outcome && outcome.asset_class === asset_class) {
      return outcome.result.pbo;
    }
  }
  return null;
}

function dsrFor(verdict: Stage2Verdict, asset_class: 'crypto' | 'stocks'): number | null {
  for (const outcome of verdict.dsr) {
    if ('result' in outcome && outcome.asset_class === asset_class) {
      return outcome.result.dsr;
    }
  }
  return null;
}
