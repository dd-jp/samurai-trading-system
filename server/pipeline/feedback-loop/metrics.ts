import { assertThresholdsWithinBounds } from '../../shared/index.js';
import { applyGuardrail } from './guardrails.js';
import type {
  Adjustment,
  BreachAlert,
  KillThresholds,
  MetricsInput,
  MetricsReport,
} from './types.js';

const PBO_OVER_MAX = 'pbo_over_max';
const OOS_SHARPE_UNDER_MIN = 'oos_sharpe_under_min';
const DSR_INSIGNIFICANT = 'dsr_insignificant';
const LIVE_BACKTEST_DIVERGENCE_OVER_MAX = 'live_backtest_divergence_over_max';

const REVALIDATION_GATED_KILL_LINES: readonly string[] = [
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

function liveBacktestDivergence(liveSharpe: number, backtestReferenceSharpe: number): number {
  if (backtestReferenceSharpe <= 0) {
    return 0;
  }
  return Math.max(0, (backtestReferenceSharpe - liveSharpe) / backtestReferenceSharpe);
}

export function assertKillThresholdsWithinBounds(
  kill: KillThresholds | undefined,
  where: string,
): void {
  if (kill === undefined) return;

  assertThresholdsWithinBounds(
    {
      max_pbo: kill.max_pbo,
      min_oos_sharpe: kill.min_oos_sharpe,
      min_deflated_sharpe: kill.min_deflated_sharpe,
    },
    where,
  );
}

function detectBreaches(input: MetricsInput): string[] {
  const breaches: string[] = [];
  const { daily, revalidation, backtest_reference_sharpe, config } = input;
  assertKillThresholdsWithinBounds(config.kill_thresholds, 'computeMetrics');

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

function autoTighten(input: MetricsInput, now: Date): void {
  const { tuning, adjustments, config } = input;
  const thresholds = tuning.getRiskThresholds();

  for (const [name, dial] of Object.entries(config.risk_thresholds)) {
    const current = thresholds[name];
    if (current === undefined) {
      continue;
    }

    const target = dial.tighten_is === 'increase' ? dial.ceiling : dial.floor;
    const { to, direction } = applyGuardrail(current, target, dial);
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

function notEvaluated(input: MetricsInput): string[] {
  const lines: string[] = [];

  if (input.revalidation === undefined) {
    lines.push(...REVALIDATION_GATED_KILL_LINES);
  }
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
