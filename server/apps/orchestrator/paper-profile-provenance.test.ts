import {
  PAPER_PROFILE_PROVENANCE,
  paperStartingProfile,
  type ValueProvenance,
} from './paper-profile.js';

function collectLeafPaths(value: unknown, prefix: string): string[] {
  if (typeof value === 'function') return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, member]) => typeof member !== 'function',
  );
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([key, member]) =>
    collectLeafPaths(member, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function profileLeafPaths(): string[] {
  const { mode: _mode, ...configs } = paperStartingProfile('paper');
  return collectLeafPaths(configs, '').sort();
}

describe('PAPER_PROFILE_PROVENANCE', () => {
  it('classifies every leaf the profile ships, and nothing that it does not', () => {
    const leaves = profileLeafPaths();

    expect(leaves.length).toBeGreaterThan(100);

    expect(leaves).toEqual(Object.keys(PAPER_PROFILE_PROVENANCE).sort());
  });

  it('uses all three labels — a taxonomy one label short has collapsed', () => {
    const labels = new Set<ValueProvenance>(Object.values(PAPER_PROFILE_PROVENANCE));

    expect(labels.has('SPEC')).toBe(true);
    expect(labels.has('DERIVED')).toBe(true);
    expect(labels.has('UNSOURCED')).toBe(true);
  });

  it('admits a new UNSOURCED value only through a conscious edit here', () => {
    const UNSOURCED_VALUES = Object.entries(PAPER_PROFILE_PROVENANCE)
      .filter(([, label]) => label === 'UNSOURCED')
      .map(([path]) => path)
      .sort();

    expect(UNSOURCED_VALUES).toEqual([
      'breakerConfig.daily_loss_pct',
      'breakerConfig.daily_loss_pct_by_class.crypto',
      'breakerConfig.daily_loss_pct_by_class.stocks',
      'breakerConfig.max_consecutive_losses',
      'breakerConfig.volatility.baseline.crypto',
      'breakerConfig.volatility.baseline.stocks',
      'breakerConfig.volatility.multiplier',
      'correlationConfig.min_bars',
      'correlationConfig.window.lookback',
      'correlationConfig.window.timeframe',
      'costConfig.crypto.impactK',
      'costConfig.crypto.slippageCoefficient',
      'costConfig.crypto.spreadVolatilityCoefficient',
      'costConfig.stocks.impactK',
      'costConfig.stocks.slippageCoefficient',
      'costConfig.stocks.spreadVolatilityCoefficient',
      'executionConfig.simulated.adv_window.lookback',
      'executionConfig.simulated.adv_window.timeframe',
      'feedback.config.kill_thresholds.max_live_backtest_divergence',
      'riskConfig.cii_threshold',
      'riskConfig.concentration.threshold',
      'riskConfig.max_mark_age.crypto',
      'riskConfig.max_mark_age.stocks',
      'riskConfig.max_position_size_fraction_of_equity',
      'riskConfig.per_asset_cap_fraction_of_equity',
      'riskConfig.per_asset_class_cap_fraction_of_equity.crypto',
      'riskConfig.per_asset_class_cap_fraction_of_equity.stocks',
      'traderConfig.flatten_after_close_ms',
      'verdictConfig.drift_tolerance_pct.crypto',
      'verdictConfig.drift_tolerance_pct.stocks',
      'verdictConfig.human_timeout',
      'verdictConfig.max_mark_age.crypto',
      'verdictConfig.max_mark_age.stocks',
      'verdictConfig.max_signal_age.crypto',
      'verdictConfig.max_signal_age.stocks',
    ]);
  });
});
