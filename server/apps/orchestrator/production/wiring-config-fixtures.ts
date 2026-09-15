/**
 * Real, cast-free values for the six `ProductionConfig` fields every
 * composition-root wiring test under this directory needs to construct but
 * none of them exercises (#1456): `riskConfig`, `executionConfig`,
 * `correlationConfig`, `costConfig`, `ciiConsumerConfig`, and — since #1389 —
 * `verdictConfig`. A cast to the
 * field's type here (`{} as ProductionConfig['X']` or `as unknown as`)
 * would hide a wrong-shaped value from `tsc` — docs/coding-standards.md,
 * "Test stubs must type-check without casts". `CiiConsumerConfig`'s
 * `pollIntervalMs` is the concrete case: required and non-optional, so an
 * unchecked `{}` here reaches `new CiiConsumer(...)` (production.ts) as
 * `pollIntervalMs: undefined`.
 *
 * Values mirror `production.test.ts`'s `REAL_CONFIGS` (same shapes
 * `direct-bind.test.ts` pins), extended with `whole_share_sizing` — required
 * on `RiskConfig` but omitted there because that fixture is cast via
 * `as unknown as Pick<...>`, which does not check it.
 */
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
      // `lookback: 15` is `REAL_CONFIGS`'s value (production.test.ts), the
      // `atr` arity floor (`minimumBars`, indicators.ts) — NOT
      // `DEFAULT_VOLATILITY_INDICATOR`'s (production/defaults.ts), which
      // sizes to the converged warm-up (`recommendedWarmupFor` = 4*period+1
      // = 57), a different dial for a different purpose (#757)
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
    // Matches `REAL_CONFIGS.ciiConsumerConfig` (production.test.ts) and the
    // shipped `paperStartingProfile` value (paper-profile.ts) — 10 min,
    // within WorldMonitor's own decoupled poll cadence (ADR-0002 §2, 5-15 min)
    pollIntervalMs: 600_000,
    ...overrides,
  };
}

/**
 * The sixth (#1389). Every wiring test under this directory used to declare
 * `verdictConfig` as `{ automation_level: ... } as ProductionConfig['verdictConfig']`
 * — a cast that type-checks while omitting five required fields, so
 * `buildProductionComponents` read `config.verdictConfig.max_mark_age` as
 * `undefined` the moment a boot assertion started consulting it, and eleven
 * files failed at once on a shape `tsc` had already been told was fine. That is
 * the exact hazard this module's header is about, so the fixture is real rather
 * than the assertion made tolerant of a missing field.
 *
 * Values mirror `production.test.ts`'s `REAL_CONFIGS`. `max_mark_age` matches
 * `makeWiringRiskConfig`'s: the two are separate dials on separate configs and
 * only equal by coincidence, but a wiring fixture has no reason to make them
 * disagree.
 */
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
