import { describe, expect, it } from 'vitest';
import type { MetricsSuite } from '../cost-model-backtest/validation-types.js';
import type { Clock } from '../shared/clock.js';
import { InMemoryBreachAlertChannel } from './fixture-stores.js';
import { computeMetrics } from './metrics.js';
import type { SqliteAdjustmentLog } from './sqlite-adjustment-log.js';
import { openAdjustmentLog, openTuningStore } from './sqlite-store-harness.js';
import type { SqliteTuningStore } from './sqlite-tuning-store.js';
import type { FeedbackConfig, MetricsInput, RevalidationSnapshot, TunableDial } from './types.js';

const NOW = new Date('2026-07-19T00:00:00Z');

function makeClock(at: Date = NOW): Clock {
  return { now: () => at };
}

function makeSuite(overrides: Partial<MetricsSuite> = {}): MetricsSuite {
  return {
    sharpe: 1.5,
    sortino: 1.8,
    calmar: 1.2,
    max_drawdown: 0.15,
    profit_factor: 1.8,
    expectancy: 0.2,
    skew: 0.1,
    kurtosis: 0.5,
    turnover: 0.3,
    exposure: 0.4,
    ...overrides,
  };
}

function makeRevalidation(overrides: Partial<RevalidationSnapshot> = {}): RevalidationSnapshot {
  return {
    walk_forward_sharpe_distribution: [0.8, 0.9, 1.0, 0.85, 0.95],
    deflated_sharpe: 0.97,
    pbo: 0.02,
    ...overrides,
  };
}

function makeDial(overrides: Partial<TunableDial> = {}): TunableDial {
  return { max_step: 0.05, floor: 0.1, ceiling: 0.9, tighten_is: 'decrease', ...overrides };
}

function makeConfig(overrides: Partial<FeedbackConfig> = {}): FeedbackConfig {
  return {
    attribution_window_ms: 24 * 60 * 60 * 1000,
    weights: makeDial(),
    shadow_credit: 0.1,
    shadow_influence_ceiling: 0.2,
    strategy_params: {},
    risk_thresholds: { max_position_size: makeDial() },
    kill_thresholds: {
      max_pbo: 0.05,
      min_oos_sharpe: 0.5,
      min_deflated_sharpe: 0.95,
      max_live_backtest_divergence: 0.5,
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<MetricsInput> = {}): {
  input: MetricsInput;
  tuning: SqliteTuningStore;
  adjustments: SqliteAdjustmentLog;
  alerts: InMemoryBreachAlertChannel;
} {
  const tuning = openTuningStore({ thresholds: { max_position_size: 0.8 } });
  const adjustments = openAdjustmentLog();
  const alerts = new InMemoryBreachAlertChannel();

  const input: MetricsInput = {
    clock: makeClock(),
    daily: makeSuite(),
    backtest_reference_sharpe: 1.5,
    revalidation: makeRevalidation(),
    tuning,
    adjustments,
    config: makeConfig(),
    alerts,
    ...overrides,
  };

  return { input, tuning, adjustments, alerts };
}

describe('computeMetrics', () => {
  it('recomposes the daily suite and revalidation output verbatim, with no breaches when healthy', () => {
    const { input } = makeInput();
    const report = computeMetrics(input);

    expect(report.daily).toBe(input.daily);
    expect(report.revalidation).toBe(input.revalidation);
    expect(report.breaches).toEqual([]);
  });

  it('does not alert or tighten when nothing breaches', () => {
    const { input, tuning, adjustments, alerts } = makeInput();
    computeMetrics(input);

    expect(alerts.getAlerts()).toEqual([]);
    expect(adjustments.getEntries()).toEqual([]);
    expect(tuning.getRiskThresholds()).toEqual({ max_position_size: 0.8 });
  });

  it('breaches on PBO > max_pbo, alerts, and auto-tightens', () => {
    const { input, tuning, adjustments, alerts } = makeInput({
      revalidation: makeRevalidation({ pbo: 0.1 }),
    });
    const report = computeMetrics(input);

    expect(report.breaches).toEqual(['pbo_over_max']);
    expect(alerts.getAlerts()).toHaveLength(1);
    expect(alerts.getAlerts()[0]).toEqual({ breaches: ['pbo_over_max'], reported_at: NOW });
    expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.75);
    expect(adjustments.getEntries()).toHaveLength(1);
    expect(adjustments.getEntries()[0]).toMatchObject({
      dial: 'risk_threshold',
      name: 'max_position_size',
      reason: 'breach_auto_tighten',
      direction: 'tighten',
    });
  });

  it('breaches on mean OOS/paper Sharpe < min_oos_sharpe, alerts, and auto-tightens', () => {
    const { input, tuning, adjustments, alerts } = makeInput({
      revalidation: makeRevalidation({ walk_forward_sharpe_distribution: [0.2, 0.3, 0.1] }),
    });
    const report = computeMetrics(input);

    expect(report.breaches).toEqual(['oos_sharpe_under_min']);
    expect(alerts.getAlerts()).toHaveLength(1);
    expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.75);
    expect(adjustments.getEntries()).toHaveLength(1);
  });

  it('breaches on DSR insignificance (< min_deflated_sharpe), alerts, and auto-tightens', () => {
    const { input, tuning, adjustments, alerts } = makeInput({
      revalidation: makeRevalidation({ deflated_sharpe: 0.5 }),
    });
    const report = computeMetrics(input);

    expect(report.breaches).toEqual(['dsr_insignificant']);
    expect(alerts.getAlerts()).toHaveLength(1);
    expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.75);
    expect(adjustments.getEntries()).toHaveLength(1);
  });

  it('breaches on live-vs-backtest divergence, alerts, and auto-tightens (no revalidation needed)', () => {
    const { input, tuning, adjustments, alerts } = makeInput({
      revalidation: undefined,
      daily: makeSuite({ sharpe: 0.5 }),
      backtest_reference_sharpe: 1.5,
    });
    const report = computeMetrics(input);

    expect(report.breaches).toEqual(['live_backtest_divergence_over_max']);
    expect(alerts.getAlerts()).toHaveLength(1);
    expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.75);
    expect(adjustments.getEntries()).toHaveLength(1);
  });

  it('reports every breach simultaneously but posts exactly one alert', () => {
    const { input, alerts } = makeInput({
      revalidation: makeRevalidation({
        pbo: 0.1,
        deflated_sharpe: 0.5,
        walk_forward_sharpe_distribution: [0.1],
      }),
      daily: makeSuite({ sharpe: 0.5 }),
      backtest_reference_sharpe: 1.5,
    });
    const report = computeMetrics(input);

    expect(report.breaches).toEqual([
      'pbo_over_max',
      'oos_sharpe_under_min',
      'dsr_insignificant',
      'live_backtest_divergence_over_max',
    ]);
    expect(alerts.getAlerts()).toHaveLength(1);
  });

  it('never applies a kill: a breach only ever alerts and tightens, and moves stop before the floor', () => {
    const { input, tuning } = makeInput({
      revalidation: makeRevalidation({ pbo: 0.1 }),
      config: makeConfig({
        risk_thresholds: {
          max_position_size: makeDial({ max_step: 0.05, floor: 0.1, ceiling: 0.9 }),
        },
      }),
    });
    tuning.setRiskThreshold('max_position_size', 0.12);

    computeMetrics(input);

    // Tightened by at most max_step, never crossing the floor.
    expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.1);
  });

  it('is a no-op tighten when the threshold already sits at its safe extreme', () => {
    const { input, tuning, adjustments } = makeInput({
      revalidation: makeRevalidation({ pbo: 0.1 }),
    });
    tuning.setRiskThreshold('max_position_size', 0.1);

    computeMetrics(input);

    expect(tuning.getRiskThresholds().max_position_size).toBe(0.1);
    expect(adjustments.getEntries()).toEqual([]);
  });
});
