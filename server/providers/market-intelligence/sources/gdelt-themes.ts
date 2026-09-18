import type { AssetClass } from '../../../shared/index.js';

const MACRO_THEMES = [
  'ECON_INTEREST_RATES',
  'ECON_INFLATION',
  'WB_442_INFLATION',
  'ECON_DEBT',
  'ECON_COST_OF_LIVING',
  'ECON_OILPRICE',
  'ECON_WORLDCURRENCIES',
  'ECON_WORLDCURRENCIES_DOLLAR',
  'EPU_ECONOMY',
  'EPU_POLICY_FEDERAL_RESERVE',
  'EPU_POLICY_INTEREST_RATE',
  'EPU_POLICY_INTEREST_RATES',
  'WB_439_MACROECONOMIC_AND_STRUCTURAL_POLICIES',
  'WB_1104_MACROECONOMIC_VULNERABILITY_AND_DEBT',
  'WB_471_ECONOMIC_GROWTH',
] as const;

const STOCK_THEMES = [
  'ECON_STOCKMARKET',
  'ECON_BANKRUPTCY',
  'ECON_IPO',
  'WB_332_CAPITAL_MARKETS',
  'WB_1920_FINANCIAL_SECTOR_DEVELOPMENT',
  'WB_318_FINANCIAL_ARCHITECTURE_AND_BANKING',
] as const;

const CRYPTO_THEMES = [
  'ECON_BITCOIN',
  'WB_328_FINANCIAL_INTEGRITY',
  'WB_336_NON_BANK_FINANCIAL_INSTITUTIONS',
] as const;

const WATCHLIST: Record<AssetClass, readonly string[]> = {
  stocks: [...MACRO_THEMES, ...STOCK_THEMES],
  crypto: [...MACRO_THEMES, ...CRYPTO_THEMES],
};

export function themesFor(asset_class: AssetClass): readonly string[] {
  return WATCHLIST[asset_class];
}

export function allWatchedThemes(): readonly string[] {
  return [...new Set([...WATCHLIST.stocks, ...WATCHLIST.crypto])];
}
