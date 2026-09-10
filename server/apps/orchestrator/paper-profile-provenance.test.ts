/**
 * Pins `PAPER_PROFILE_PROVENANCE` (review 2026-08-06 D4) to the profile it
 * indexes, in both directions: every config leaf the profile actually ships
 * carries a classification, and every classification names a leaf that still
 * exists. The per-value comments in paper-profile.ts keep the WHY; the map
 * keeps the CLASSIFICATION; this file keeps the two from drifting apart.
 */
import {
  PAPER_PROFILE_PROVENANCE,
  paperStartingProfile,
  type ValueProvenance,
} from './paper-profile.js';

/**
 * The map's documented walk semantics, mirrored exactly:
 *
 * - Functions are not config leaves (`feedback.metrics.source` is a factory
 *   the composition root calls — its provenance lives with the class it
 *   names, not here).
 * - Arrays are single leaves (`universe` is labeled as a whole; its members
 *   are one SPEC-cited set, not six independently sourced values).
 * - Empty plain objects are single leaves (`feedback.config.strategy_params`
 *   is empty ON PURPOSE, and that emptiness is the labeled decision).
 */
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
  // `mode` is the caller's own argument echoed back through the profile — a
  // routing fact, not a tuning value, so it carries no provenance label.
  const { mode: _mode, ...configs } = paperStartingProfile('paper');
  return collectLeafPaths(configs, '').sort();
}

describe('PAPER_PROFILE_PROVENANCE', () => {
  it('classifies every leaf the profile ships, and nothing that it does not', () => {
    const leaves = profileLeafPaths();

    // Not vacuous: the profile is nine config blocks deep, so an accidentally
    // shallow walk (or a profile builder that returned `{}`) must fail loudly
    // rather than trivially satisfying an empty-vs-empty comparison.
    expect(leaves.length).toBeGreaterThan(100);

    // One sorted-array equality carries both directions — completeness (a new
    // or renamed leaf with no entry) and drift (an entry whose leaf is gone)
    // — and its failure diff names the exact paths on the wrong side.
    expect(leaves).toEqual(Object.keys(PAPER_PROFILE_PROVENANCE).sort());
  });

  it('uses all three labels — a taxonomy one label short has collapsed', () => {
    const labels = new Set<ValueProvenance>(Object.values(PAPER_PROFILE_PROVENANCE));

    expect(labels.has('SPEC')).toBe(true);
    expect(labels.has('DERIVED')).toBe(true);
    expect(labels.has('UNSOURCED')).toBe(true);
  });

  it('admits a new UNSOURCED value only through a conscious edit here', () => {
    // The header calls every UNSOURCED value "an open question" and "first in
    // line to be replaced by real paper observations". This is the explicit
    // roll of those questions: adding one silently is exactly what a
    // conservative-guess taxonomy must not allow, so a new UNSOURCED entry —
    // or a reclassification away from one — has to edit this list too.
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
      // #640/#641: two feed-staleness bounds, four values, all guesses. No
      // measurement in this repo bounds inter-print gaps on the live universe
      // — the soak is what produces that distribution, and these are the
      // first entries here that have a named experiment behind them.
      'riskConfig.max_mark_age.crypto',
      'riskConfig.max_mark_age.stocks',
      'riskConfig.max_position_size_fraction_of_equity',
      'riskConfig.per_asset_cap_fraction_of_equity',
      'riskConfig.per_asset_class_cap_fraction_of_equity.crypto',
      'riskConfig.per_asset_class_cap_fraction_of_equity.stocks',
      // #1389: how long the flatten may keep trying after the bell. No doc
      // states it — 5 minutes is a choice bounded below by the tick interval
      // and above by `verdictConfig.max_mark_age.stocks`, and the soak's real
      // post-bell fills are what would replace it.
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
