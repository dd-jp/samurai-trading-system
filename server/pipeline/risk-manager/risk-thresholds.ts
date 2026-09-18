import { assertThresholdsWithinBounds } from '../../shared/index.js';
import type { RiskConfig } from './types.js';

export const RISK_THRESHOLD_KEYS = [
  'max_position_size_fraction_of_equity',
  'per_asset_cap_fraction_of_equity',
  'per_asset_class_cap_fraction_of_equity_crypto',
  'per_asset_class_cap_fraction_of_equity_stocks',
  'portfolio_gross_cap_fraction_of_equity',
  'concentration_cap_fraction_of_equity',
] as const;

export type RiskThresholdKey = (typeof RISK_THRESHOLD_KEYS)[number];

export function riskThresholdsFrom(config: RiskConfig): Partial<Record<RiskThresholdKey, number>> {
  const candidates: Record<RiskThresholdKey, number | undefined> = {
    max_position_size_fraction_of_equity: config.max_position_size_fraction_of_equity,
    per_asset_cap_fraction_of_equity: config.per_asset_cap_fraction_of_equity,
    per_asset_class_cap_fraction_of_equity_crypto:
      config.per_asset_class_cap_fraction_of_equity?.crypto,
    per_asset_class_cap_fraction_of_equity_stocks:
      config.per_asset_class_cap_fraction_of_equity?.stocks,
    portfolio_gross_cap_fraction_of_equity: config.portfolio_gross_cap_fraction_of_equity,
    concentration_cap_fraction_of_equity: config.concentration?.cap_fraction_of_equity,
  };

  return Object.fromEntries(
    Object.entries(candidates).filter(
      ([, value]) => value !== undefined && Number.isFinite(value) && value > 0,
    ),
  ) as Partial<Record<RiskThresholdKey, number>>;
}

export interface RiskThresholdSource {
  getRiskThresholds(): Record<string, number>;
}

export function resolveRiskConfig(
  base: RiskConfig,
  live: Record<string, number>,
): { config: RiskConfig; applied: Partial<Record<RiskThresholdKey, number>> } {
  assertThresholdsWithinBounds(live, 'RiskManager live threshold read (risk_thresholds table)');

  const applied: Partial<Record<RiskThresholdKey, number>> = {};
  for (const key of RISK_THRESHOLD_KEYS) {
    const value = live[key];
    if (value === undefined || !Number.isFinite(value) || value <= 0) continue;
    applied[key] = value;
  }

  if (Object.keys(applied).length === 0) return { config: base, applied };

  return {
    config: {
      ...base,
      max_position_size_fraction_of_equity:
        applied.max_position_size_fraction_of_equity ?? base.max_position_size_fraction_of_equity,
      per_asset_cap_fraction_of_equity:
        applied.per_asset_cap_fraction_of_equity ?? base.per_asset_cap_fraction_of_equity,
      per_asset_class_cap_fraction_of_equity: {
        crypto:
          applied.per_asset_class_cap_fraction_of_equity_crypto ??
          base.per_asset_class_cap_fraction_of_equity.crypto,
        stocks:
          applied.per_asset_class_cap_fraction_of_equity_stocks ??
          base.per_asset_class_cap_fraction_of_equity.stocks,
      },
      portfolio_gross_cap_fraction_of_equity:
        applied.portfolio_gross_cap_fraction_of_equity ??
        base.portfolio_gross_cap_fraction_of_equity,
      concentration: {
        ...base.concentration,
        cap_fraction_of_equity:
          applied.concentration_cap_fraction_of_equity ?? base.concentration.cap_fraction_of_equity,
      },
    },
    applied,
  };
}
