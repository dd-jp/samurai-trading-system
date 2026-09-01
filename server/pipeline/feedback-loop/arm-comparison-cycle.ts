/**
 * The Feedback Loop's matched-control comparison (#971, under #636 and #913).
 *
 * #636 decided WHERE this lives: the falsifier-arm-2 comparison and the
 * risk-adjusted outside benchmarks are additional columns in FL's existing
 * daily/weekly Metrics & Revalidation suite, on FL's existing cadence — no new
 * scheduling primitive. #913 decided where the answer GOES: an alert on
 * divergence over the existing trade channel, and a dashboard panel. This module
 * is the computation half of both.
 *
 * It reimplements no math. `buildArmComparison` (control-arm/arm-comparison.ts)
 * already derives both arms' return and drawdown from ONE window query, and its
 * `max_drawdown_pct` is a required field so that no return-only view of an arm
 * can be built at all — `docs/research/12-edge-hypothesis-critique.md` D4 made
 * structural. What is new here is the decision: is this gap worth waking a human
 * for, and where is the answer written down.
 *
 * ## The one asymmetry every reader of these numbers needs
 *
 * The control arm has no debate rounds, so it is always treated as decided
 * (`converged: true`, axis-vote-decision.ts). On bars where the live debate did
 * NOT converge, the live arm takes its non-converged size haircut and refuses a
 * scale-in; the control takes neither. The arms therefore differ in SIZE on
 * those bars, not only in entry — which means a non-converging stretch can
 * itself PRODUCE a divergence reading. The caveat travels with the alert body
 * (`arm-divergence-alert-channel.ts`) and with the dashboard panel, not only
 * with the spec, because the alert is the surface most likely to be acted on
 * quickly.
 */
import { type ArmComparison, buildArmComparison } from '../control-arm/index.js';
import type {
  ArmComparisonCycleInput,
  ArmComparisonSample,
  ArmDivergenceThresholds,
  ArmDivergenceVerdict,
} from './types/arm-comparison.js';

/** Same 30-day default window `yarn report:arms` uses (`DEFAULT_WINDOW_DAYS`). */
export const DEFAULT_ARM_COMPARISON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How far ahead the control must be, in return over the window, before the gap
 * counts as divergence: **0.5 percentage points of the book over 30 days.**
 *
 * The anchor is what the debate layer COSTS. CLAUDE.md's restated cadence
 * economics (#840) put the equities-only LLM bill at ~£58/yr, and ADR-0015's
 * 2026-08-18 amendment puts the book at £1,000 — so running the debate layer
 * costs ~5.8% of the book per year, which pro-rates over this module's 30-day
 * window to £58 × 30/365 = £4.77, or **0.48 pp of the £1,000 basis**. Rounded to
 * 0.5 pp, which is the line: a control arm that is ahead by less than what the
 * debate layer costs to run has not yet shown the layer is not worth its bill,
 * and a control ahead by more has.
 *
 * Note what this is NOT anchored to. CLAUDE.md's "~0.55 pp" is percentage points
 * of *signal accuracy* at £1,000 of position notional — a different quantity in
 * different units, which also appears as 1.58 pp / 0.75 pp against the ADR-0018
 * D5 position sizes. The number here is a return hurdle on the book over a
 * window, and the arithmetic above is the whole of its derivation.
 */
export const ARM_DIVERGENCE_RETURN_GAP_PCT = 0.005;

/**
 * Closed trades EACH arm must have before divergence can fire at all.
 *
 * Chosen, not derived: five is small enough that a real month of intraday
 * trading clears it and large enough that a single round trip — or a control arm
 * that has produced one lucky trade — cannot page anyone. It is explicitly NOT a
 * power calculation; treating five trades as statistical evidence would be the
 * mistake `docs/research/13-stage2-proxy-verdict.md` and the PBO/DSR work exist
 * to prevent. Its job is to keep the alert honest about the zero- and one-trade
 * cases that `formatArmComparison`'s own NOTE already calls out.
 */
export const MIN_TRADES_PER_ARM_FOR_DIVERGENCE = 5;

export const DEFAULT_ARM_DIVERGENCE_THRESHOLDS: ArmDivergenceThresholds = {
  min_return_gap_pct: ARM_DIVERGENCE_RETURN_GAP_PCT,
  min_trades_per_arm: MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
};

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Divergence is DOMINANCE, on both columns at once: the control is ahead on
 * return by more than the gap AND took no more drawdown doing it.
 *
 * Both halves are load-bearing.
 *
 * - Return alone would be the return-only comparison against a risk-targeted
 *   stream that doc 12 D4 rules out — a control that bought its lead with a
 *   deeper drawdown has not beaten the live arm, it has taken more risk.
 * - The drawdown column alone says nothing about whether the debate layer earned
 *   its bill, which is the question `ARM_DIVERGENCE_RETURN_GAP_PCT` is anchored
 *   to.
 *
 * It fires in ONE direction only: the control beating the live arm is the
 * falsifying result an operator must be told about. The live arm winning is
 * confirmation, and belongs on the dashboard trend rather than in a push
 * notification (#342's alert-fatigue posture).
 */
export function evaluateArmDivergence(
  comparison: ArmComparison,
  thresholds: ArmDivergenceThresholds,
): ArmDivergenceVerdict {
  const { live, control } = comparison;

  // Under the floor the comparison is not asked the question at all — an
  // absent answer, not a passing one.
  if (
    live.trade_count < thresholds.min_trades_per_arm ||
    control.trade_count < thresholds.min_trades_per_arm
  ) {
    return { diverged: false, reason: null };
  }

  const returnGap = control.return_pct - live.return_pct;
  const controlNoWorseOnDrawdown = control.max_drawdown_pct <= live.max_drawdown_pct;

  if (returnGap <= thresholds.min_return_gap_pct || !controlNoWorseOnDrawdown) {
    return { diverged: false, reason: null };
  }

  return {
    diverged: true,
    reason:
      `the control arm is ahead by ${pct(returnGap)} of the book over this window ` +
      `(control ${pct(control.return_pct)} vs live ${pct(live.return_pct)}) ` +
      `and took no more drawdown doing it ` +
      `(control ${pct(control.max_drawdown_pct)} vs live ${pct(live.max_drawdown_pct)})`,
  };
}

/**
 * One cycle: read the window, build the comparison, evaluate it, persist it,
 * and alert if it diverged.
 *
 * Called from the composition root's existing daily feedback timer, beside
 * `runDailyCycle` and INDEPENDENTLY of `runMetricsCheck` — the comparison is
 * derived from `closed_trades`, so it is computable on the many days the
 * equity-derived `MetricsSuite` is not, and gating it behind that source's
 * `undefined` would leave this whole mechanism silently un-run for exactly the
 * runs it exists to measure.
 *
 * The sample is persisted on EVERY cycle, including the zero-trade one: an
 * absent row means "FL never computed a comparison", a present row with no
 * trades means "FL looked and the window was empty", and the dashboard must be
 * able to tell those apart.
 */
export function runArmComparisonCycle(input: ArmComparisonCycleInput): ArmComparisonSample {
  const now = input.clock.now();
  const from = new Date(now.getTime() - input.window_ms);

  const comparison = buildArmComparison({
    // ONE call, both arms — see `ArmComparisonSource`.
    trades: input.trades.getClosedTradesBetween(from, now),
    from,
    to: now,
    basis: input.basis,
  });

  const divergence = evaluateArmDivergence(comparison, input.thresholds);
  const sample: ArmComparisonSample = { computed_at: now, comparison, divergence };

  input.samples.append(sample);

  if (divergence.diverged && divergence.reason !== null) {
    input.alerts.postArmDivergenceAlert({
      comparison,
      reason: divergence.reason,
      reported_at: now,
    });
  }

  return sample;
}
