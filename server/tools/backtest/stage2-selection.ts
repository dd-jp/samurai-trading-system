/**
 * The Stage 2 SELECTED CONFIG record (#375, #384) — the artifact both of those
 * issues independently concluded was missing, and the reason four kill-lines
 * out of four could not fire.
 *
 * ## What was wrong
 *
 * `live_backtest_divergence_over_max` compares the live Sharpe against
 * `MetricsInput.backtest_reference_sharpe`, "the frozen selected config's
 * backtest Sharpe". Nothing in the repo persisted such a record: Stage 2's
 * runner used an in-memory trial log, so nothing survived the process that
 * computed it, and there was no selected-config artifact at all (#375).
 *
 * The other three — `pbo_over_max`, `oos_sharpe_under_min`, `dsr_insignificant`
 * — are computed only from `DailyMetricsSample.revalidation`, and **no
 * component produced one** (#384). #384 predicted the resolution exactly:
 * *"`revalidation` is populated from a persisted Stage 2 run, not from live
 * data"*. PBO, out-of-sample Sharpe and the deflated Sharpe are walk-forward /
 * CSCV outputs; a live paper run cannot compute them about itself.
 *
 * This module is that persistence, and it invents no statistic:
 * `renderStage2Verdict` already computes every number here.
 *
 * ## The selection rule is borrowed, not invented
 *
 * "Selected" means the config that class's search would have picked — highest
 * out-of-sample Sharpe. That is not a choice made here: it is the same rule
 * `computeDsr` already uses to decide which config the DSR deflates, and
 * reusing it is what stops the deflated Sharpe and the frozen reference from
 * describing two different configs.
 */
import type { ConfigKillLineCheck, Stage2Verdict } from './stage2-verdict.js';
import type { TrialGridResult } from './trial-execution.js';
import type { DateRange } from './universe.js';

/**
 * One asset class's frozen Stage 2 outcome.
 *
 * Every field is copied from the verdict, never recomputed — a second
 * derivation is a second thing to drift.
 */
export interface Stage2Selection {
  config_hash: string;
  asset_class: 'crypto' | 'stocks';
  /** When the Stage 2 run that produced this was rendered. */
  selected_at: Date;
  /** The sample the backtest ran over — what makes staleness checkable. */
  window: DateRange;
  /**
   * The selected config's WHOLE-SAMPLE annualized Sharpe: the number
   * `backtest_reference_sharpe` has always meant, and the one live performance
   * is compared against for divergence.
   */
  backtest_sharpe: number;
  /** Mean of the walk-forward test-fold Sharpes — the out-of-sample estimate. */
  oos_sharpe: number;
  /** The fold Sharpes themselves; `RevalidationSnapshot.walk_forward_sharpe_distribution`. */
  fold_sharpes: number[];
  /** Null where the verdict refused to compute it (a typed refusal, not a zero). */
  pbo: number | null;
  dsr: number | null;
  /** Distinct trials the search spanned — what DSR was deflated by. */
  n_trials: number;
  /** The verdict's own overall pass/fail, carried so a reader need not re-derive it. */
  overall_pass: boolean;
}

/**
 * Freezes one selection per asset class present in the verdict.
 *
 * Returns `[]` when there is nothing to freeze — an empty trial grid, or a
 * verdict whose PBO/DSR both refused. That is deliberate: a selection with no
 * numbers behind it would arm the kill-lines with nothing, and the whole point
 * of #375/#384 is that fabricating a baseline is worse than the silence.
 * `pbo`/`dsr` may individually be null (a typed refusal on one statistic still
 * leaves the others usable), but a config must at least have been evaluated.
 */
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
    // The verdict already throws on this divergence; skipping rather than
    // throwing again keeps a persistence step from being the thing that fails
    // a run whose statistics were fine.
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

/** The same rule `computeDsr` selects by — highest out-of-sample Sharpe. */
function bestByOosSharpe(checks: readonly ConfigKillLineCheck[]): ConfigKillLineCheck {
  let best = checks[0] as ConfigKillLineCheck;
  for (const check of checks) {
    if (check.oos_sharpe > best.oos_sharpe) best = check;
  }
  return best;
}

/** Null on a typed refusal — never a zero, which would read as a perfect PBO. */
function pboFor(verdict: Stage2Verdict, asset_class: 'crypto' | 'stocks'): number | null {
  for (const outcome of verdict.pbo) {
    if ('result' in outcome && outcome.asset_class === asset_class) {
      return outcome.result.pbo;
    }
  }
  return null;
}

/** Null on a typed refusal — never a zero, which would read as a certainly-insignificant DSR. */
function dsrFor(verdict: Stage2Verdict, asset_class: 'crypto' | 'stocks'): number | null {
  for (const outcome of verdict.dsr) {
    if ('result' in outcome && outcome.asset_class === asset_class) {
      return outcome.result.dsr;
    }
  }
  return null;
}
