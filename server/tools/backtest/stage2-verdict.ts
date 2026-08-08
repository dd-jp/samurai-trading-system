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
 * applies the kill-line thresholds.
 *
 * **The two structural gaps are closed (#406).** Wiring this up originally
 * found that neither DSR nor PBO could be computed at all — not from missing
 * data, but from a mismatch between the trial design and what the statistics
 * are defined over. `MetricsSuite` exposed only the Lo (2002)-annualized
 * Sharpe, which `deflatedSharpe()` cannot consume and cannot be inverted; and
 * the 5 anchored walk-forward folds are not the symmetric partition `pbo()`
 * requires. Both are now supplied at the source — `MetricsSuite` carries
 * `per_period_sharpe`/`annualization_factor`/`observations`, and
 * `generateSplits`'s `cscv` scheme produces the 6 purged held-out folds PBO
 * ranks configs across. Recorded in
 * docs/research/06-stage2-overfitting-verdict.md and P7 of
 * docs/research/11-pitfalls-and-improvements-2026-08-05.md.
 *
 * The refusals that remain are honest ones — no trial data, a CSCV pass that
 * was not requested or that failed on a fold, a variance term the DSR formula
 * rejects. None of them is a fabricated number.
 */

import { deflatedSharpe, minbtl, minbtlGuard, pbo } from './overfitting.js';
import type { TrialGridResult } from './trial-execution.js';
import type { DateRange } from './universe.js';
import type { MinBtlVerdict, PboVerdict } from './validation-types.js';

/** The spec's kill line (docs/research/02-staged-deployment-plan.md). */
export const KILL_LINE = {
  /** Reject if the out-of-sample (mean across walk-forward test folds) Sharpe is below this. */
  minOosSharpe: 0.5,
  /** Reject if PBO exceeds this — mirrors `overfitting.ts`'s own `PBO_REJECT_THRESHOLD`. */
  maxPbo: 0.05,
  /**
   * Reject if the Deflated Sharpe Ratio falls below this.
   *
   * **An assumption, not a spec value.** The staged-deployment plan's kill line
   * says "insignificant DSR" without fixing a level. DSR is the probability
   * that the observed Sharpe beats what the luckiest of N trials would produce
   * by chance, so "significant" is a confidence level; 0.95 is Bailey & López
   * de Prado's conventional choice and is the same 5% tolerance `maxPbo`
   * already uses, which keeps the two statistical gates on one standard rather
   * than two. Stated here so a reader can disagree with the number without
   * having to reverse-engineer where it came from.
   */
  minDsr: 0.95,
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
  | 'cscv_pass_not_run'
  | 'cscv_pass_failed'
  | 'pbo_requires_even_fold_count'
  | 'dsr_variance_term_non_positive';

/** PBO outcome for one asset class (or a global refusal when there's nothing to group). */
export type PboOutcome =
  | { result: PboVerdict; asset_class: 'crypto' | 'stocks' }
  | { error: NotComputableReason; detail: string; asset_class?: 'crypto' | 'stocks' };

/**
 * The deflated Sharpe of the config a researcher would actually have picked,
 * and the trial count it was deflated by.
 */
export interface DsrResult {
  /** The selected config — highest OOS Sharpe in its asset class. */
  config_hash: string;
  /** N the Sharpe was deflated by — `ConfigTrialLog.distinctTrialCount()`. */
  n_distinct_trials: number;
  /** The non-annualized whole-window Sharpe that was deflated. */
  per_period_sharpe: number;
  /** Return observations in the whole-window sample — DSR's `sampleLen`. */
  observations: number;
  /** P(the observed Sharpe is not the luckiest of N trials). */
  dsr: number;
  passes_dsr_line: boolean;
}

/** DSR outcome for one asset class (or a global refusal when there's nothing to group). */
export type DsrOutcome =
  | { result: DsrResult; asset_class: 'crypto' | 'stocks' }
  | { error: NotComputableReason; detail: string; asset_class?: 'crypto' | 'stocks' };

export interface Stage2Verdict {
  n_distinct_trials: number;
  min_btl: MinBtlVerdict;
  kill_line_checks: ConfigKillLineCheck[];
  /** One entry per asset class present in `results` — PBO must be checked separately per class. */
  pbo: PboOutcome[];
  /** One entry per asset class — DSR deflates the config that class's search would have selected. */
  dsr: DsrOutcome[];
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

/**
 * DSR per asset class, for the config that class's search would have selected.
 *
 * **Selection is by OOS Sharpe; deflation is of the whole-window statistic.**
 * Not a sample mix-up — the two serve different jobs. The config a researcher
 * picks is the one with the best out-of-sample result, so that is what gets
 * selected here; but an OOS Sharpe is the *mean of five fold Sharpes*, which
 * has no per-period counterpart, no observation count and no skew/kurtosis, so
 * there is nothing for `deflatedSharpe()` to consume. The whole-window suite
 * has all four, and the whole-window Sharpe is the number such a config would
 * be reported with. Deflating that by N is exactly the question DSR asks: how
 * much of this headline is an artifact of having searched N configs?
 */
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
      // deflatedSharpe() rejects a non-positive variance term, which real
      // samples can produce (a large Sharpe with strong negative skew). A
      // refusal is the honest report; a fabricated probability is not.
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

/** The config this asset class's search would have picked — highest OOS Sharpe. */
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

/**
 * PBO over each asset class's configs x CSCV-fold matrix, independently per
 * asset class — a stock+crypto grid run yields two separate matrices
 * (different annualization bases, see `trial-execution.ts`), so PBO must be
 * checked, and can fail, separately for each.
 *
 * **Reads the CSCV pass, not the walk-forward one (#406).** The walk-forward
 * folds cannot serve: the trial design fixes 5 of them, and `pbo()` requires an
 * even count >= 4 because its CSCV combinatorics partition the folds into
 * symmetric train/test halves. Padding to an even number would not have helped
 * either — anchored walk-forward folds have a growing train side, so they are
 * not a symmetric partition in the first place, and ranking configs across them
 * would answer a different question than the one PBO asks. `generateSplits`'s
 * `cscv` scheme supplies the partition the formula is defined over: 6 held-out
 * groups, purged and embargoed, each scored out-of-sample.
 */
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

/** One config's per-fold OOS Sharpes from its CSCV pass. */
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

/** The asset classes present in `results`, in first-seen order. */
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

/** Re-exported for callers that only need the MinBTL number (no trial data required). */
export { minbtl };
