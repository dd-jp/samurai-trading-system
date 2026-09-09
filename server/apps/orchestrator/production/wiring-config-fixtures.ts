/**
 * Real, cast-free values for the five `ProductionConfig` fields every
 * composition-root wiring test under this directory needs to construct but
 * none of them exercises (#1456): `riskConfig`, `executionConfig`,
 * `correlationConfig`, `costConfig`, `ciiConsumerConfig`. Before this file,
 * each wiring test stubbed them as `{} as ProductionConfig['X']` — a cast
 * the coding standard bans (docs/coding-standards.md, "Test stubs must
 * type-check without casts") because it hides a wrong-shaped value from
 * `tsc` the same way `as unknown as` does. `ciiConsumerConfig: {}` was the
 * concrete case: `CiiConsumerConfig.pollIntervalMs` is required and
 * non-optional, so the cast fed `new CiiConsumer(...)` (production.ts)
 * `pollIntervalMs: undefined` in all 8 files.
 *
 * Values mirror `production.test.ts`'s `REAL_CONFIGS` (same shapes
 * `direct-bind.test.ts` pins), extended with `whole_share_sizing` — required
 * on `RiskConfig` but omitted there because that fixture is cast via
 * `as unknown as Pick<...>`, which does not check it.
 */
import type { ExecutionConfig } from '../../../pipeline/execution/index.js';
import type { CorrelationConfig, RiskConfig } from '../../../pipeline/risk-manager/index.js';
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
      // Matches `DEFAULT_VOLATILITY_INDICATOR` (production.ts): ATR(14) on
      // 1h bars, lookback 15 because `atr()` spends the first bar seeding
      // `previousClose`.
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
    // Matches WorldMonitor's own decoupled poll cadence (ADR-0002 §2, 5-15 min).
    pollIntervalMs: 300_000,
    ...overrides,
  };
}
