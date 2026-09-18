import { deflatedSharpe, minbtlGuard, pbo } from './overfitting.js';
import type { TrialGridResult } from './trial-execution.js';
import type { DateRange } from './universe.js';
import type { MinBtlVerdict, PboVerdict } from './validation-types.js';

export const KILL_LINE = {
  minOosSharpe: 0.5,
  maxPbo: 0.05,
  minDsr: 0.95,
} as const;

export interface ConfigKillLineCheck {
  config_hash: string;
  asset_class: 'crypto' | 'stocks';
  oos_sharpe: number;
  window_sharpe: number;
  fold_sharpes: number[];
  passes_oos_sharpe_line: boolean;
}

type NotComputableReason =
  | 'no_real_trial_data'
  | 'cscv_pass_not_run'
  | 'cscv_pass_failed'
  | 'pbo_requires_even_fold_count'
  | 'dsr_variance_term_non_positive';

type PboOutcome =
  | { result: PboVerdict; asset_class: 'crypto' | 'stocks' }
  | { error: NotComputableReason; detail: string; asset_class?: 'crypto' | 'stocks' };

interface DsrResult {
  config_hash: string;
  n_distinct_trials: number;
  per_period_sharpe: number;
  observations: number;
  dsr: number;
  passes_dsr_line: boolean;
}

type DsrOutcome =
  | { result: DsrResult; asset_class: 'crypto' | 'stocks' }
  | { error: NotComputableReason; detail: string; asset_class?: 'crypto' | 'stocks' };

export interface Stage2Verdict {
  n_distinct_trials: number;
  min_btl: MinBtlVerdict;
  kill_line_checks: ConfigKillLineCheck[];
  pbo: PboOutcome[];
  dsr: DsrOutcome[];
  overall_pass: boolean;
}

export function killLineChecks(results: readonly TrialGridResult[]): ConfigKillLineCheck[] {
  return results.map((result) => {
    const fold_sharpes = result.report.splits.map((split) => split.metrics.sharpe);
    const oos_sharpe = mean(fold_sharpes);

    return {
      config_hash: result.config_hash,
      asset_class: result.asset_class,
      oos_sharpe,
      window_sharpe: result.report.window.sharpe,
      fold_sharpes,
      passes_oos_sharpe_line: oos_sharpe >= KILL_LINE.minOosSharpe,
    };
  });
}

export function renderStage2Verdict(deps: {
  results: readonly TrialGridResult[];
  distinctTrialCount: number;
  window: DateRange;
  expectedAnnualSharpe?: number;
}): Stage2Verdict {
  const min_btl = minbtlGuard(deps.window, deps.distinctTrialCount, deps.expectedAnnualSharpe);
  const kill_line_checks = killLineChecks(deps.results);

  const pboOutcomes = computePboFromCscvFolds(deps.results);
  const dsrOutcomes = computeDsr(deps.results, kill_line_checks, deps.distinctTrialCount);

  const overall_pass =
    deps.results.length > 0 &&
    !min_btl.exceeded &&
    kill_line_checks.every((c) => c.passes_oos_sharpe_line) &&
    pboOutcomes.length > 0 &&
    pboOutcomes.every((outcome) => 'result' in outcome && outcome.result.verdict === 'accept') &&
    dsrOutcomes.length > 0 &&
    dsrOutcomes.every((outcome) => 'result' in outcome && outcome.result.passes_dsr_line);

  return {
    n_distinct_trials: deps.distinctTrialCount,
    min_btl,
    kill_line_checks,
    pbo: pboOutcomes,
    dsr: dsrOutcomes,
    overall_pass,
  };
}

function computeDsr(
  results: readonly TrialGridResult[],
  checks: readonly ConfigKillLineCheck[],
  nDistinctTrials: number,
): DsrOutcome[] {
  if (results.length === 0) {
    return [{ error: 'no_real_trial_data', detail: NO_TRIAL_DATA_DETAIL }];
  }

  const outcomes: DsrOutcome[] = [];

  for (const asset_class of assetClassesOf(results)) {
    const selected = bestByOosSharpe(checks, asset_class);
    const result = results.find(
      (candidate) =>
        candidate.asset_class === asset_class && candidate.config_hash === selected.config_hash,
    );

    if (result === undefined) {
      throw new Error(
        `renderStage2Verdict: no TrialGridResult for the selected config ${selected.config_hash} ` +
          `of asset class '${asset_class}' — the kill-line checks and the results have diverged.`,
      );
    }

    const { per_period_sharpe, observations, skew, kurtosis } = result.report.window;

    let dsr: number;
    try {
      dsr = deflatedSharpe(per_period_sharpe, nDistinctTrials, observations, skew, kurtosis);
    } catch (cause) {
      outcomes.push({
        error: 'dsr_variance_term_non_positive',
        asset_class,
        detail:
          `deflatedSharpe() rejected the selected config ${selected.config_hash} of asset class ` +
          `'${asset_class}': ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      continue;
    }

    outcomes.push({
      result: {
        config_hash: selected.config_hash,
        n_distinct_trials: nDistinctTrials,
        per_period_sharpe,
        observations,
        dsr,
        passes_dsr_line: dsr >= KILL_LINE.minDsr,
      },
      asset_class,
    });
  }

  return outcomes;
}

function bestByOosSharpe(
  checks: readonly ConfigKillLineCheck[],
  asset_class: 'crypto' | 'stocks',
): ConfigKillLineCheck {
  let best: ConfigKillLineCheck | undefined;

  for (const check of checks) {
    if (check.asset_class !== asset_class) {
      continue;
    }
    if (best === undefined || check.oos_sharpe > best.oos_sharpe) {
      best = check;
    }
  }

  if (best === undefined) {
    throw new Error(
      `renderStage2Verdict: no kill-line check for asset class '${asset_class}', which the ` +
        'results say is present.',
    );
  }

  return best;
}

const NO_TRIAL_DATA_DETAIL =
  'No TrialGridResult entries were supplied — no replay/eval run produced trial data.';

function computePboFromCscvFolds(results: readonly TrialGridResult[]): PboOutcome[] {
  if (results.length === 0) {
    return [{ error: 'no_real_trial_data', detail: NO_TRIAL_DATA_DETAIL }];
  }

  const outcomes: PboOutcome[] = [];

  for (const asset_class of assetClassesOf(results)) {
    const rows = results.filter((result) => result.asset_class === asset_class);

    const missing = rows.filter((row) => row.cscv === undefined);
    if (missing.length > 0) {
      outcomes.push({
        error: 'cscv_pass_not_run',
        asset_class,
        detail:
          `${missing.length} of ${rows.length} configs in asset class '${asset_class}' carry no ` +
          'CSCV pass. PBO needs every config scored on the same folds, so a partial matrix is ' +
          'not a smaller matrix — it is no matrix. Set `includeCscvPass` on runTrialGrid.',
      });
      continue;
    }

    const failed = rows.flatMap((row) =>
      row.cscv !== undefined && 'error' in row.cscv
        ? [`${row.config_hash}: ${row.cscv.error}`]
        : [],
    );
    if (failed.length > 0) {
      outcomes.push({
        error: 'cscv_pass_failed',
        asset_class,
        detail:
          `The CSCV pass failed for ${failed.length} of ${rows.length} configs in asset class ` +
          `'${asset_class}', so the configs x folds matrix is incomplete and PBO cannot rank ` +
          `across it. First failures: ${failed.slice(0, 3).join(' | ')}`,
      });
      continue;
    }

    const matrix = rows.map((row) => cscvFoldSharpes(row));
    const foldCount = matrix[0]?.length ?? 0;

    if (foldCount % 2 !== 0 || foldCount < 4) {
      outcomes.push({
        error: 'pbo_requires_even_fold_count',
        asset_class,
        detail:
          `pbo() requires an even fold count >= 4 (CSCV partitions the folds into symmetric ` +
          `train/test halves); the CSCV pass produced ${foldCount} folds per config for asset ` +
          `class '${asset_class}'.`,
      });
      continue;
    }

    outcomes.push({ result: pbo(matrix), asset_class });
  }

  return outcomes;
}

function cscvFoldSharpes(row: TrialGridResult): number[] {
  const cscv = row.cscv;

  if (cscv === undefined || 'error' in cscv) {
    throw new Error(
      `renderStage2Verdict: config ${row.config_hash} has no usable CSCV report — the guards ` +
        'above should have refused this asset class before building its matrix.',
    );
  }

  return cscv.report.splits.map((split) => split.metrics.sharpe);
}

function assetClassesOf(results: readonly TrialGridResult[]): ('crypto' | 'stocks')[] {
  const seen: ('crypto' | 'stocks')[] = [];

  for (const result of results) {
    if (!seen.includes(result.asset_class)) {
      seen.push(result.asset_class);
    }
  }

  return seen;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
