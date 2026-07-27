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
export { computeIndicator } from './indicators.js';
export type { NormalizeContext, RawCandle } from './ingestion.js';
export { completedBars, deriveBacktestMark, normalizeBars } from './ingestion.js';
export { MarketDataServiceImpl } from './service.js';
export type { DataSourceConfig } from './source-factory.js';
export { createDataSource } from './source-factory.js';
export type {
  AlpacaBar,
  AlpacaClient,
  AlpacaQuote,
  AlpacaSourceOptions,
} from './sources/alpaca-source.js';
export { AlpacaDataSource } from './sources/alpaca-source.js';
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
export { NormalizingDataSource } from './sources/normalizing-data-source.js';
export { SqliteMarketDataStore } from './sqlite-market-data-store.js';
export { closeTimeOf, isDailyTimeframe, timeframeToMs } from './timeframe.js';
export type { TradingCalendar } from './trading-calendar.js';
export { AlwaysOpenCalendar, UsEquityRegularHoursCalendar } from './trading-calendar.js';
export type {
  Bar,
  BarWindow,
  DataSource,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarketDataStore,
  Quote,
} from './types.js';
