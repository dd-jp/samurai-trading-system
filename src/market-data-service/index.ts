/**
 * Market Data Service — see docs/specs/market-data-service-spec.md, epic #51.
 * Implemented ticket-by-ticket starting with #64.
 */

export type { FixtureLiveMark } from './fixture-data-source.js';
export { FixtureDataSource } from './fixture-data-source.js';
export { buildIndicatorCacheKey, IndicatorCache } from './indicator-cache.js';
export { computeIndicator } from './indicators.js';
export { MarketDataServiceImpl } from './service.js';
export type {
  Bar,
  BarWindow,
  DataSource,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
  Quote,
} from './types.js';