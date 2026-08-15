/**
 * The GDELT GKG theme watchlist, per asset class (#556, map #552).
 *
 * ## Why a watchlist at all
 *
 * One 15-minute GKG batch is ~10MB of TSV across ~800 documents covering
 * everything GDELT saw worldwide — shootings, sport, weather. Archiving all of
 * it would be ~1GB across a 14-day soak to carry a macro tone signal that lives
 * in a few dozen themes. The watchlist is the filter that makes the archive
 * proportionate to the signal.
 *
 * The cost of filtering at fetch is that the choice is baked into what we
 * store, so widening the list later does not retroactively widen history. That
 * is survivable here and nowhere else in the archive: GDELT's batch files stay
 * permanently retrievable at their timestamped URL, which
 * `GdeltGkgRecord.payload` records, so a wider re-derivation can always
 * re-fetch. Alpaca has no such property, which is why nothing is filtered there.
 *
 * ## Why these themes
 *
 * Every name below was verified present in a live GKG batch
 * (`20260815153000.gkg.csv.zip`) rather than taken from the GDELT codebook —
 * the codebook lists themes that no longer appear on the wire, and a watchlist
 * entry that never matches is indistinguishable from a broken filter.
 *
 * The split is by what actually moves each leg. The equity leg trades LSE
 * leveraged index ETPs ([ADR-0016](../../../../docs/adr/0016-universe-leveraged-etps-ungated.md)),
 * which have no company news of their own — a 3x FTSE ETP moves on rates,
 * inflation and policy, which is precisely the gap `alpaca-news-client.ts`
 * documents itself as unable to fill. Crypto gets the monetary and currency
 * themes plus `ECON_BITCOIN`, because the same macro backdrop prices it and
 * there is no equity-specific theme to add.
 */

import type { AssetClass } from '../../../shared/index.js';

/**
 * Shared macro backdrop — rates, inflation, policy uncertainty, growth.
 *
 * Both legs get these. A rate decision moves a 3x FTSE ETP and BTC on the same
 * day, and splitting them by leg would encode a decoupling the intraday horizon
 * has no evidence for.
 */
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

/** Equity-specific: the market itself, and the corporate-credit tail. */
const STOCK_THEMES = [
  'ECON_STOCKMARKET',
  'ECON_BANKRUPTCY',
  'ECON_IPO',
  'WB_332_CAPITAL_MARKETS',
  'WB_1920_FINANCIAL_SECTOR_DEVELOPMENT',
  'WB_318_FINANCIAL_ARCHITECTURE_AND_BANKING',
] as const;

/**
 * Crypto-specific. `ECON_BITCOIN` is the only crypto theme GDELT carries — it
 * has no ETH or altcoin equivalent, so an ETH-USD instrument reads the same
 * macro-plus-bitcoin stream. Documented rather than papered over: this stream
 * is a market-wide backdrop, not per-instrument news, and #557's aggregation
 * treats it as such.
 */
const CRYPTO_THEMES = [
  'ECON_BITCOIN',
  'WB_328_FINANCIAL_INTEGRITY',
  'WB_336_NON_BANK_FINANCIAL_INSTITUTIONS',
] as const;

const WATCHLIST: Record<AssetClass, readonly string[]> = {
  stocks: [...MACRO_THEMES, ...STOCK_THEMES],
  crypto: [...MACRO_THEMES, ...CRYPTO_THEMES],
};

/** The themes worth archiving for one asset class. */
export function themesFor(asset_class: AssetClass): readonly string[] {
  return WATCHLIST[asset_class];
}

/**
 * Every watched theme across every asset class.
 *
 * The fetcher filters ONCE per batch against this union rather than per asset
 * class, because a batch is downloaded once and a row matching either leg has
 * to survive the filter. Which leg a row then belongs to is decided at read,
 * where `themesFor` is the authority.
 */
export function allWatchedThemes(): readonly string[] {
  return [...new Set([...WATCHLIST.stocks, ...WATCHLIST.crypto])];
}
