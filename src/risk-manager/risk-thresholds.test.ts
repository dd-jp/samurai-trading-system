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
    max_position_size: 5_000,
    per_asset_cap: 10_000,
    per_asset_class_cap: { crypto: 20_000, stocks: 40_000 },
    portfolio_gross_cap: 50_000,
    concentration: { cap: 20_000, threshold: 0.7 },
    min_viable_size: 100,
    cii_threshold: 70,
    ...overrides,
  };
}

describe('riskThresholdsFrom', () => {
  it('reads every declared key out of a RiskConfig', () => {
    expect(riskThresholdsFrom(makeConfig())).toEqual({
      max_position_size: 5_000,
      per_asset_cap: 10_000,
      per_asset_class_cap_crypto: 20_000,
      per_asset_class_cap_stocks: 40_000,
      portfolio_gross_cap: 50_000,
      concentration_cap: 20_000,
    });
  });

  it('covers exactly the declared key set — the seeder and the reader cannot drift', () => {
    expect(Object.keys(riskThresholdsFrom(makeConfig())).sort()).toEqual(
      [...RISK_THRESHOLD_KEYS].sort(),
    );
  });

  it('skips what a partial config does not carry rather than throwing at startup', () => {
    // `RiskConfig` requires every field, so a gap means a cast-past-the-compiler
    // object — which is what a test fixture is, and startup must survive one.
    const partial = { max_position_size: 5_000 } as RiskConfig;

    expect(riskThresholdsFrom(partial)).toEqual({ max_position_size: 5_000 });
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
    const { config, applied } = resolveRiskConfig(makeConfig(), { max_position_size: 1_000 });

    expect(config.max_position_size).toBe(1_000);
    expect(applied).toEqual({ max_position_size: 1_000 });
    // Untouched dials keep their static values.
    expect(config.per_asset_cap).toBe(10_000);
  });

  it('reaches the two nested fields, not just the flat ones', () => {
    const { config } = resolveRiskConfig(makeConfig(), {
      per_asset_class_cap_crypto: 1_000,
      concentration_cap: 2_000,
    });

    expect(config.per_asset_class_cap).toEqual({ crypto: 1_000, stocks: 40_000 });
    expect(config.concentration).toEqual({ cap: 2_000, threshold: 0.7 });
  });

  it('honours a LOOSENING — the human approval that produced it must mean something', () => {
    // daily-cycle.ts queues a threshold loosening into `loosen_pending_approval`
    // and never applies it unapproved, so a loosened row in the table has
    // already been through the guardrail bounds and a human.
    const { config } = resolveRiskConfig(makeConfig(), { max_position_size: 9_000 });

    expect(config.max_position_size).toBe(9_000);
  });

  it('ignores a NaN rather than applying it', () => {
    // The one that matters most: every comparison against NaN is false, so a
    // NaN cap would silently disable the gate instead of tightening it.
    const { config, applied } = resolveRiskConfig(makeConfig(), { max_position_size: Number.NaN });

    expect(config.max_position_size).toBe(5_000);
    expect(applied).toEqual({});
  });

  it('ignores zero, negative and infinite values', () => {
    const { config } = resolveRiskConfig(makeConfig(), {
      max_position_size: 0,
      per_asset_cap: -1,
      portfolio_gross_cap: Number.POSITIVE_INFINITY,
    });

    expect(config.max_position_size).toBe(5_000);
    expect(config.per_asset_cap).toBe(10_000);
    expect(config.portfolio_gross_cap).toBe(50_000);
  });

  it('ignores a key that is not part of the contract', () => {
    const base = makeConfig();

    const { config, applied } = resolveRiskConfig(base, { max_position_pct: 0.5, nonsense: 1 });

    expect(config).toBe(base);
    expect(applied).toEqual({});
  });

  it('does not mutate the config it was given', () => {
    const base = makeConfig();

    resolveRiskConfig(base, { max_position_size: 1, concentration_cap: 1 });

    expect(base.max_position_size).toBe(5_000);
    expect(base.concentration.cap).toBe(20_000);
  });
});
