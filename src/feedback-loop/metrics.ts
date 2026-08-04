/**
 * Metrics recomposition + kill-threshold breach alerting (#93). See
 * docs/specs/feedback-loop-spec.md ("Module: Metrics & Revalidation") and
 * user story 13.
 *
 * `computeMetrics` recomposes the validation library's `MetricsSuite` and
 * periodic DSR/PBO/walk-forward output into `MetricsReport` — it reimplements
 * none of that math (acceptance criterion #1). Its own job is narrow: decide
 * whether any of the four kill-line conditions breached, and if so, alert the
 * human via the trade channel and defensively auto-tighten every risk
 * threshold. Kill/rework is a human decision this module never takes — there
 * is no kill primitive here by design.
 */
import { applyGuardrail } from './guardrails.js';
import type { Adjustment, BreachAlert, MetricsInput, MetricsReport } from './types.js';

export const PBO_OVER_MAX = 'pbo_over_max';
export const OOS_SHARPE_UNDER_MIN = 'oos_sharpe_under_min';
export const DSR_INSIGNIFICANT = 'dsr_insignificant';
export const LIVE_BACKTEST_DIVERGENCE_OVER_MAX = 'live_backtest_divergence_over_max';

/**
 * The three lines that need a `RevalidationSnapshot`. Absent one — every
 * non-revalidation day — none of them can be evaluated, which is reported in
 * `MetricsReport.not_evaluated` rather than passing silently (#327).
 */
export const REVALIDATION_GATED_KILL_LINES: readonly string[] = [
  PBO_OVER_MAX,
  OOS_SHARPE_UNDER_MIN,
  DSR_INSIGNIFICANT,
];

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/**
 * Relative drop of live Sharpe below the backtest reference, floored at 0: a
 * live Sharpe AT OR ABOVE the reference is not divergence, whatever its sign.
 * `backtest_reference_sharpe <= 0` has no meaningful relative drop, so it
 * never breaches on this check alone — a broken reference should not manufacture
 * a false breach.
 */
function liveBacktestDivergence(liveSharpe: number, backtestReferenceSharpe: number): number {
  if (backtestReferenceSharpe <= 0) {
    return 0;
  }
  return Math.max(0, (backtestReferenceSharpe - liveSharpe) / backtestReferenceSharpe);
}

function detectBreaches(input: MetricsInput): string[] {
  const breaches: string[] = [];
  const { daily, revalidation, backtest_reference_sharpe, config } = input;

  if (revalidation !== undefined) {
    if (revalidation.pbo > config.kill_thresholds.max_pbo) {
      breaches.push(PBO_OVER_MAX);
    }
    if (
      mean(revalidation.walk_forward_sharpe_distribution) < config.kill_thresholds.min_oos_sharpe
    ) {
      breaches.push(OOS_SHARPE_UNDER_MIN);
    }
    if (revalidation.deflated_sharpe < config.kill_thresholds.min_deflated_sharpe) {
      breaches.push(DSR_INSIGNIFICANT);
    }
  }

  if (
    liveBacktestDivergence(daily.sharpe, backtest_reference_sharpe) >
    config.kill_thresholds.max_live_backtest_divergence
  ) {
    breaches.push(LIVE_BACKTEST_DIVERGENCE_OVER_MAX);
  }

  return breaches;
}

/**
 * Step every declared risk threshold toward its safe extreme by at most
 * `max_step` — never gated, since tightening is always free (spec: "auto-
 * tighten risk thresholds freely"). Reuses `applyGuardrail` with the target
 * pinned at the tighten-direction bound, so a threshold already at its
 * extreme is a no-op rather than an out-of-band write.
 */
function autoTighten(input: MetricsInput, now: Date): void {
  const { tuning, adjustments, config } = input;
  const thresholds = tuning.getRiskThresholds();

  for (const [name, dial] of Object.entries(config.risk_thresholds)) {
    const current = thresholds[name];
    if (current === undefined) {
      continue;
    }

    const target = dial.tighten_is === 'increase' ? dial.ceiling : dial.floor;
    const { to, direction } = applyGuardrail(current, target, dial, false);
    if (to === current) {
      continue;
    }

    tuning.setRiskThreshold(name, to);
    const entry: Adjustment = {
      dial: 'risk_threshold',
      name,
      from: current,
      to,
      direction,
      applied_at: now,
      reason: 'breach_auto_tighten',
    };
    adjustments.append(entry);
  }
}

/**
 * Which kill-lines this input cannot answer at all. Computed from the same
 * two conditions `detectBreaches` skips on, so the report can never claim a
 * line passed when it was never run (#327).
 */
function notEvaluated(input: MetricsInput): string[] {
  const lines: string[] = [];

  if (input.revalidation === undefined) {
    lines.push(...REVALIDATION_GATED_KILL_LINES);
  }
  // Mirrors `liveBacktestDivergence`'s guard exactly. The `0` return stays —
  // a broken reference must not manufacture a breach — but the resulting
  // "no breach" is not evidence of health, so it is recorded as un-run.
  if (input.backtest_reference_sharpe <= 0) {
    lines.push(LIVE_BACKTEST_DIVERGENCE_OVER_MAX);
  }

  return lines;
}

export function computeMetrics(input: MetricsInput): MetricsReport {
  const now = input.clock.now();
  const breaches = detectBreaches(input);
  const not_evaluated = notEvaluated(input);

  if (breaches.length > 0) {
    const alert: BreachAlert = { breaches, reported_at: now };
    input.alerts.postBreachAlert(alert);
    autoTighten(input, now);
  }

  return input.revalidation === undefined
    ? { daily: input.daily, breaches, not_evaluated }
    : { daily: input.daily, revalidation: input.revalidation, breaches, not_evaluated };
}
