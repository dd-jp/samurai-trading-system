/**
 * The `risk_thresholds` naming contract and overlay (#433).
 *
 * `autoTighten` has written this table since #93 and nothing read it, so the
 * system's defensive response to a detected dead edge changed no decision.
 * These pin the contract that closes it — and the guards that stop a corrupt
 * row from disabling a cap.
 */
import { RISK_THRESHOLD_KEYS, resolveRiskConfig, riskThresholdsFrom } from './risk-thresholds.js';
import type { RiskConfig } from './types.js';

function makeConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    max_position_size_fraction_of_equity: 5_000,
    per_asset_cap_fraction_of_equity: 10_000,
    per_asset_class_cap_fraction_of_equity: { crypto: 20_000, stocks: 40_000 },
    portfolio_gross_cap_fraction_of_equity: 50_000,
    concentration: { cap_fraction_of_equity: 20_000, threshold: 0.7 },
    min_viable_size: 100,
    whole_share_sizing: false,
    cii_threshold: 70,
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
    ...overrides,
  };
}

describe('riskThresholdsFrom', () => {
  it('reads every declared key out of a RiskConfig', () => {
    expect(riskThresholdsFrom(makeConfig())).toEqual({
      max_position_size_fraction_of_equity: 5_000,
      per_asset_cap_fraction_of_equity: 10_000,
      per_asset_class_cap_fraction_of_equity_crypto: 20_000,
      per_asset_class_cap_fraction_of_equity_stocks: 40_000,
      portfolio_gross_cap_fraction_of_equity: 50_000,
      concentration_cap_fraction_of_equity: 20_000,
    });
  });

  it('covers exactly the declared key set — the seeder and the reader cannot drift', () => {
    expect(Object.keys(riskThresholdsFrom(makeConfig())).sort()).toEqual(
      [...RISK_THRESHOLD_KEYS].sort(),
    );
  });

  it('skips what a partial config does not carry rather than throwing at startup', () => {
    // `RiskConfig` requires every field, so a gap means a cast-past-the-compiler
    // object — which is what a test fixture is, and startup must survive one
    const partial = { max_position_size_fraction_of_equity: 5_000 } as RiskConfig;

    expect(riskThresholdsFrom(partial)).toEqual({ max_position_size_fraction_of_equity: 5_000 });
  });
});

describe('resolveRiskConfig', () => {
  it('leaves the static config alone when the table is empty', () => {
    const base = makeConfig();

    const { config, applied } = resolveRiskConfig(base, {});

    expect(config).toBe(base);
    expect(applied).toEqual({});
  });

  it('binds a tightened threshold over the static config', () => {
    const { config, applied } = resolveRiskConfig(makeConfig(), {
      max_position_size_fraction_of_equity: 1_000,
    });

    expect(config.max_position_size_fraction_of_equity).toBe(1_000);
    expect(applied).toEqual({ max_position_size_fraction_of_equity: 1_000 });
    // Untouched dials keep their static values
    expect(config.per_asset_cap_fraction_of_equity).toBe(10_000);
  });

  it('reaches the two nested fields, not just the flat ones', () => {
    const { config } = resolveRiskConfig(makeConfig(), {
      per_asset_class_cap_fraction_of_equity_crypto: 1_000,
      concentration_cap_fraction_of_equity: 2_000,
    });

    expect(config.per_asset_class_cap_fraction_of_equity).toEqual({
      crypto: 1_000,
      stocks: 40_000,
    });
    expect(config.concentration).toEqual({ cap_fraction_of_equity: 2_000, threshold: 0.7 });
  });

  it('honours a LOOSENING — the bounds that produced it are the control, not this read', () => {
    // daily-cycle.ts applies a threshold loosening itself (#736, ADR-0013
    // Decision 2), so a loosened row in the table has already been through the
    // dial's [floor, ceiling] and the in-code clamp at the write door. What
    // guards this read is the clamp re-check below, not a second-guess
    const { config } = resolveRiskConfig(makeConfig(), {
      max_position_size_fraction_of_equity: 9_000,
    });

    expect(config.max_position_size_fraction_of_equity).toBe(9_000);
  });

  it('ignores a NaN rather than applying it', () => {
    // The one that matters most: every comparison against NaN is false, so a
    // NaN cap would silently disable the gate instead of tightening it
    const { config, applied } = resolveRiskConfig(makeConfig(), {
      max_position_size_fraction_of_equity: Number.NaN,
    });

    expect(config.max_position_size_fraction_of_equity).toBe(5_000);
    expect(applied).toEqual({});
  });

  it('ignores zero, negative and infinite values', () => {
    const { config } = resolveRiskConfig(makeConfig(), {
      max_position_size_fraction_of_equity: 0,
      per_asset_cap_fraction_of_equity: -1,
      portfolio_gross_cap_fraction_of_equity: Number.POSITIVE_INFINITY,
    });

    expect(config.max_position_size_fraction_of_equity).toBe(5_000);
    expect(config.per_asset_cap_fraction_of_equity).toBe(10_000);
    expect(config.portfolio_gross_cap_fraction_of_equity).toBe(50_000);
  });

  it('ignores a key that is not part of the contract', () => {
    const base = makeConfig();

    const { config, applied } = resolveRiskConfig(base, { max_position_pct: 0.5, nonsense: 1 });

    expect(config).toBe(base);
    expect(applied).toEqual({});
  });

  it('does not mutate the config it was given', () => {
    const base = makeConfig();

    resolveRiskConfig(base, {
      max_position_size_fraction_of_equity: 1,
      concentration_cap_fraction_of_equity: 1,
    });

    expect(base.max_position_size_fraction_of_equity).toBe(5_000);
    expect(base.concentration.cap_fraction_of_equity).toBe(20_000);
  });
});
