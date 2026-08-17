/**
 * Market Data Service — see docs/specs/market-data-service-spec.md, epic #51.
 * Implemented ticket-by-ticket starting with #64.
 *
 * Ticket #194 adds the `bars`/`latest_mark` persistence port
 * (`MarketDataStore`) and its real `SqliteMarketDataStore` implementation
 * over the shared store's tables (#193), wired into `MarketDataServiceImpl`
 * as the Tier-2 bulk cache and the live mark table.
 */

export type { FixtureLiveMark } from './fixture-data-source.js';
export { FixtureDataSource } from './fixture-data-source.js';
export { buildIndicatorCacheKey, IndicatorCache } from './indicator-cache.js';
export {
  computeIndicator,
  InsufficientBarsError,
  minimumBarsFor,
  recommendedWarmupFor,
} from './indicators.js';
export type { NormalizeContext, RawCandle } from './ingestion.js';
export { completedBars, deriveBacktestMark, normalizeBars } from './ingestion.js';
export { isMarkStale, markAgeMs } from './mark-freshness.js';
export { MarketDataServiceImpl } from './service.js';
export type { SessionVwap } from './session-features.js';
export { computeSessionVwap } from './session-features.js';
export type { DataSourceConfig } from './source-factory.js';
export { createDataSource } from './source-factory.js';
export {
  AlpacaDataProviderError,
  AlpacaDataRateLimitError,
  AlpacaDataTimeoutError,
  AlpacaDataUnderfetchError,
} from './sources/alpaca-data-errors.js';
export type { AlpacaDataFeed, AlpacaHttpDataClientOptions } from './sources/alpaca-http-client.js';
export {
  ALPACA_DATA_FEED_ENV_VAR,
  AlpacaHttpDataClient,
  DEFAULT_ALPACA_DATA_FEED,
  resolveAlpacaDataFeed,
} from './sources/alpaca-http-client.js';
export type {
  AlpacaBar,
  AlpacaMarketDataClient,
  AlpacaQuote,
  AlpacaSourceOptions,
} from './sources/alpaca-source.js';
export { AlpacaDataSource } from './sources/alpaca-source.js';
export type { AssetClassRoutingSourceConfig } from './sources/asset-class-routing-source.js';
export { AssetClassRoutingDataSource } from './sources/asset-class-routing-source.js';
export type {
  CcxtClient,
  CcxtOhlcv,
  CcxtSourceOptions,
  CcxtTicker,
} from './sources/ccxt-source.js';
export { CcxtDataSource } from './sources/ccxt-source.js';
export type {
  IbkrClient,
  IbkrHistoricalBar,
  IbkrLastTrade,
  IbkrSourceOptions,
} from './sources/ibkr-source.js';
export { IbkrDataSource } from './sources/ibkr-source.js';
export type { LiveObservation, SourceConfig } from './sources/normalizing-data-source.js';
export {
  InSessionUnderfetchError,
  NormalizingDataSource,
} from './sources/normalizing-data-source.js';
export { SqliteMarketDataStore } from './sqlite-market-data-store.js';
export { closeTimeOf, isDailyTimeframe, timeframeToMs } from './timeframe.js';
export type { TradingCalendar } from './trading-calendar.js';
export {
  AlwaysOpenCalendar,
  // #668 — the live equity leg's venue (#659: T212 ISA, GBP LSE-listed ETFs).
  LseRegularHoursCalendar,
  // #706 — policy, not venue: narrows WHEN equities may be entered inside a
  // session the calendar has already opened.
  londonEntryWindow,
  OVERLAP_WINDOW_LAST_ENTRY_MINUTES,
  OVERLAP_WINDOW_OPEN_MINUTES,
  UsEquityRegularHoursCalendar,
} from './trading-calendar.js';
export type {
  Bar,
  BarWindow,
  DataSource,
  IndicatorKind,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarketDataStore,
  Quote,
} from './types.js';
export { INDICATOR_KINDS } from './types.js';
