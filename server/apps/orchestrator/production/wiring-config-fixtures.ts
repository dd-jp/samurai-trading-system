import type { ExecutionConfig } from '../../../pipeline/execution/index.js';
import type { CorrelationConfig, RiskConfig } from '../../../pipeline/risk-manager/index.js';
import type { VerdictConfig } from '../../../pipeline/verdict/index.js';
import type { CiiConsumerConfig } from '../../../providers/market-intelligence/index.js';
import type { CostConfig } from '../../../tools/backtest/index.js';

export function makeWiringRiskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    max_position_size_fraction_of_equity: 1,
    per_asset_cap_fraction_of_equity: 1,
    per_asset_class_cap_fraction_of_equity: { crypto: 1, stocks: 1 },
    portfolio_gross_cap_fraction_of_equity: 2,
    concentration: { cap_fraction_of_equity: 1, threshold: 0.9 },
    min_viable_size: 0.0001,
    whole_share_sizing: false,
    cii_threshold: 80,
    max_mark_age: { crypto: 3_600_000, stocks: 3_600_000 },
    ...overrides,
  };
}

export function makeWiringExecutionConfig(
  overrides: Partial<ExecutionConfig> = {},
): ExecutionConfig {
  return {
    simulated: {
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        timeframe: '1h',
        lookback: 15,
      },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
    ...overrides,
  };
}

export function makeWiringCorrelationConfig(
  overrides: Partial<CorrelationConfig> = {},
): CorrelationConfig {
  return {
    window: { timeframe: '1d', lookback: 30 },
    min_bars: 5,
    ...overrides,
  };
}

export function makeWiringCostConfig(overrides: Partial<CostConfig> = {}): CostConfig {
  return {
    crypto: {
      spreadVolatilityCoefficient: 0.1,
      commissionRate: 0.0026,
      slippageCoefficient: 0.05,
      impactK: 0.5,
    },
    stocks: {
      spreadVolatilityCoefficient: 0.05,
      commissionRate: 0.0005,
      slippageCoefficient: 0.02,
      impactK: 0.3,
    },
    ...overrides,
  };
}

export function makeWiringCiiConsumerConfig(
  overrides: Partial<CiiConsumerConfig> = {},
): CiiConsumerConfig {
  return {
    pollIntervalMs: 600_000,
    ...overrides,
  };
}

export function makeWiringVerdictConfig(overrides: Partial<VerdictConfig> = {}): VerdictConfig {
  return {
    automation_level: { crypto: 'auto', stocks: 'auto' },
    max_signal_age: { crypto: 3_600_000, stocks: 3_600_000 },
    max_mark_age: { crypto: 3_600_000, stocks: 3_600_000 },
    drift_tolerance_pct: { crypto: 0.05, stocks: 0.05 },
    human_timeout: 300_000,
    allow_extended_hours: false,
    flag_thresholds: { size_over: 1_000_000 },
    ...overrides,
  };
}
