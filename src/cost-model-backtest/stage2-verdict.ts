/**
 * Stage 2 overfitting verdict (ticket #245) — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Verdict") and
 * wayfinder map #154. Computes DSR/PBO/MinBTL over the trial grid's logged
 * configs and checks the result against `docs/research/02-staged-deployment-
 * plan.md`'s Stage 2 kill line (OOS Sharpe < 0.5, PBO > 0.05, insignificant
 * DSR).
 *
 * **Consumer, not new math.** Every statistic is computed by `overfitting.ts`
 * (#89, 117/117 tested, independently reviewed) — this module only assembles
 * `TrialGridResult[]` (#244) into the shapes those functions expect and
 * applies the kill-line thresholds. See this module's doc comments below for
 * two structural gaps discovered while wiring this up (not new math, but real
 * blockers on computing DSR/PBO honestly today) — recorded in
 * docs/research/06-stage2-overfitting-verdict.md, not glossed over here.
 */

import { minbtl, minbtlGuard, pbo } from './overfitting.js';
import type { TrialGridResult } from './trial-execution.js';
import type { DateRange } from './universe.js';
import type { MinBtlVerdict, PboVerdict } from './validation-types.js';

/** The spec's kill line (docs/research/02-staged-deployment-plan.md). */
export const KILL_LINE = {
  /** Reject if the out-of-sample (mean across walk-forward test folds) Sharpe is below this. */
  minOosSharpe: 0.5,
  /** Reject if PBO exceeds this — mirrors `overfitting.ts`'s own `PBO_REJECT_THRESHOLD`. */
  maxPbo: 0.05,
} as const;

/** One config's OOS-Sharpe kill-line check, per asset class. */
export interface ConfigKillLineCheck {
  config_hash: string;
  asset_class: 'crypto' | 'stocks';
  /** Mean Sharpe across the walk-forward test folds — the OOS estimate the kill line reads. */
  oos_sharpe: number;
  /** Whole-window (in-sample) Sharpe, reported alongside per the spec's "no cherry-picked number". */
  window_sharpe: number;
  fold_sharpes: number[];
  passes_oos_sharpe_line: boolean;
}

/**
 * Why DSR/PBO could not be rendered for a config/asset-class group — a typed
 * refusal rather than a fabricated number. See the module doc comment.
 */
export type NotComputableReason =
  | 'no_real_trial_data'
  | 'pbo_requires_even_fold_count'
  | 'dsr_requires_per_period_sharpe_not_exposed_by_metrics_suite';

/** PBO outcome for one asset class (or a global refusal when there's nothing to group). */
export type PboOutcome =
  | { result: PboVerdict; asset_class: 'crypto' | 'stocks' }
  | { error: NotComputableReason; detail: string; asset_class?: 'crypto' | 'stocks' };

export interface Stage2Verdict {
  n_distinct_trials: number;
  min_btl: MinBtlVerdict;
  kill_line_checks: ConfigKillLineCheck[];
  /** One entry per asset class present in `results` — PBO must be checked separately per class. */
  pbo: PboOutcome[];
  dsr_note: { error: NotComputableReason; detail: string };
  /** `true` only if every computable check passed AND nothing was left uncomputed. */
  overall_pass: boolean;
}

/**
 * Assembles the OOS-Sharpe kill-line check per (config, asset class) — fully
 * computable from `EvalReport` alone, no gaps. `oos_sharpe` is the mean of
 * the walk-forward test-fold Sharpes (the out-of-sample estimate); `window`
 * is the whole-sample (in-sample) Sharpe, reported alongside, never instead.
 */
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

/**
 * Renders the full Stage 2 verdict: MinBTL (always computable — depends only
 * on the window and N), the OOS-Sharpe kill-line check per config (computable
 * whenever real `TrialGridResult`s exist), and typed refusals for PBO/DSR
 * where a structural gap blocks them (see module doc).
 *
 * `results` may be empty — MinBTL still renders (it needs no trial data), and
 * the kill-line/PBO/DSR sections report `no_real_trial_data` accordingly. This
 * is deliberate: as of this ticket, no Polygon ingestion has ever run in this
 * repo (no API key provisioned, no ingestion entrypoint exists beyond
 * `Stage2HistoricalStore`, which requires an injected `PolygonClient`), so
 * `results` is empty in the one real invocation this ticket can make.
 */
export function renderStage2Verdict(deps: {
  results: readonly TrialGridResult[];
  distinctTrialCount: number;
  window: DateRange;
}): Stage2Verdict {
  const min_btl = minbtlGuard(deps.window, deps.distinctTrialCount);
  const kill_line_checks = killLineChecks(deps.results);

  const dsr_note = {
    error: 'dsr_requires_per_period_sharpe_not_exposed_by_metrics_suite' as const,
    detail:
      'deflatedSharpe() requires the non-annualized per-period Sharpe (mean/stdev of the raw ' +
      'periodic returns). MetricsSuite.sharpe is Lo (2002)-adjusted annualized Sharpe ' +
      '(metrics.ts: `sharpe: (mean / stdev) * annualization`, where `annualization` folds in ' +
      'sample autocorrelation) — it is not a naive x sqrt(periodsPerYear) away from the raw ' +
      'per-period statistic, and EvalReport/MetricsSuite exposes neither the raw return series ' +
      'nor the Lo annualization factor needed to invert it correctly. Computing DSR honestly ' +
      'needs a new seam (e.g. a raw per-period Sharpe field, or the annualization factor, on ' +
      "MetricsSuite/EvalReport) — out of this ticket's 'no new math, consumer only' scope.",
  };

  const groupedByAssetClass = groupByAssetClass(deps.results);
  const pboOutcomes = computePboFromWalkForwardFolds(groupedByAssetClass);

  const overall_pass =
    deps.results.length > 0 &&
    !min_btl.exceeded &&
    kill_line_checks.every((c) => c.passes_oos_sharpe_line) &&
    pboOutcomes.length > 0 &&
    pboOutcomes.every((outcome) => 'result' in outcome && outcome.result.verdict === 'accept');

  return {
    n_distinct_trials: deps.distinctTrialCount,
    min_btl,
    kill_line_checks,
    pbo: pboOutcomes,
    dsr_note,
    overall_pass,
  };
}

/**
 * Attempts PBO over each asset class's configs x walk-forward-fold OOS-Sharpe
 * matrix, independently per asset class — a stock+crypto grid run yields two
 * separate matrices (different annualization bases, see `trial-execution.ts`),
 * so PBO must be checked (and can fail) separately for each. The trial design
 * (docs/specs/stage2-validation-execution-spec.md) fixes 5 walk-forward folds
 * — an odd count, and `overfitting.ts`'s `pbo()` requires an even fold count
 * >= 4 (its CSCV combinatorics partition the folds into symmetric train/test
 * halves). Walk-forward folds are also not a CSCV-style symmetric partition
 * to begin with (each fold's train side grows anchored from the window
 * start, not a held-out half) — so even padding to an even count would not
 * give `pbo()` the partition structure its formula assumes. This is a
 * genuine spec/implementation conflict, not a data gap: the spec explicitly
 * deferred CPCV scoring in `eval-executor.ts` ("Out of Scope"), and PBO as
 * implemented needs exactly what was deferred.
 */
function computePboFromWalkForwardFolds(
  groupedByAssetClass: Map<'crypto' | 'stocks', Map<string, number[]>>,
): PboOutcome[] {
  if (groupedByAssetClass.size === 0) {
    return [
      {
        error: 'no_real_trial_data',
        detail:
          'No TrialGridResult entries were supplied — no replay/eval run has ever produced real trial data (see module doc).',
      },
    ];
  }

  const outcomes: PboOutcome[] = [];

  for (const [asset_class, configs] of groupedByAssetClass) {
    const matrix = [...configs.values()];
    const foldCount = matrix[0]?.length ?? 0;

    if (foldCount % 2 !== 0 || foldCount < 4) {
      outcomes.push({
        error: 'pbo_requires_even_fold_count',
        asset_class,
        detail:
          `pbo() requires an even fold count >= 4 (CSCV symmetric train/test partitioning); ` +
          `the spec's walk-forward split produces ${foldCount} folds per config for asset ` +
          `class '${asset_class}'. Walk-forward folds are also not a symmetric CSCV partition ` +
          `(anchored, growing train side), so this is a structural conflict between the trial ` +
          `design and overfitting.ts's PBO precondition, not merely an odd number to round up.`,
      });
      continue;
    }

    outcomes.push({ result: pbo(matrix), asset_class });
  }

  return outcomes;
}

function groupByAssetClass(
  results: readonly TrialGridResult[],
): Map<'crypto' | 'stocks', Map<string, number[]>> {
  const grouped = new Map<'crypto' | 'stocks', Map<string, number[]>>();

  for (const result of results) {
    const byConfig = grouped.get(result.asset_class) ?? new Map<string, number[]>();
    byConfig.set(
      result.config_hash,
      result.report.splits.map((split) => split.metrics.sharpe),
    );
    grouped.set(result.asset_class, byConfig);
  }

  return grouped;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Re-exported for callers that only need the MinBTL number (no trial data required). */
export { minbtl };
