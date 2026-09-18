import { type ArmComparison, buildArmComparison } from '../control-arm/index.js';
import type {
  ArmComparisonCycleInput,
  ArmComparisonSample,
  ArmDivergenceThresholds,
  ArmDivergenceVerdict,
} from './types/arm-comparison.js';

export const DEFAULT_ARM_COMPARISON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const ARM_DIVERGENCE_RETURN_GAP_PCT = 0.005;

export const MIN_TRADES_PER_ARM_FOR_DIVERGENCE = 5;

export const DEFAULT_ARM_DIVERGENCE_THRESHOLDS: ArmDivergenceThresholds = {
  min_return_gap_pct: ARM_DIVERGENCE_RETURN_GAP_PCT,
  min_trades_per_arm: MIN_TRADES_PER_ARM_FOR_DIVERGENCE,
};

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function evaluateArmDivergence(
  comparison: ArmComparison,
  thresholds: ArmDivergenceThresholds,
): ArmDivergenceVerdict {
  const { live, control } = comparison;

  if (
    live.trade_count < thresholds.min_trades_per_arm ||
    control.trade_count < thresholds.min_trades_per_arm
  ) {
    return { diverged: false, reason: null, min_trades_per_arm: thresholds.min_trades_per_arm };
  }

  const returnGap = control.return_pct - live.return_pct;
  const controlNoWorseOnDrawdown = control.max_drawdown_pct <= live.max_drawdown_pct;

  if (returnGap <= thresholds.min_return_gap_pct || !controlNoWorseOnDrawdown) {
    return { diverged: false, reason: null, min_trades_per_arm: thresholds.min_trades_per_arm };
  }

  return {
    diverged: true,
    reason:
      `the control arm is ahead by ${pct(returnGap)} of the book over this window ` +
      `(control ${pct(control.return_pct)} vs live ${pct(live.return_pct)}) ` +
      `and took no more drawdown doing it ` +
      `(control ${pct(control.max_drawdown_pct)} vs live ${pct(live.max_drawdown_pct)})`,
    min_trades_per_arm: thresholds.min_trades_per_arm,
  };
}

export function runArmComparisonCycle(input: ArmComparisonCycleInput): ArmComparisonSample {
  const now = input.clock.now();
  const from = new Date(now.getTime() - input.window_ms);

  const window = input.trades.getClosedTradeWindowBetween(from, now);

  const comparison = buildArmComparison({
    trades: window.trades,
    cost_basis_drops: window.cost_basis_drops,
    refused_passes: input.trades.getRefusedPassCountsBetween(from, now),
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
