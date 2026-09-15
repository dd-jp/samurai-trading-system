/**
 * Market Data Service — see docs/specs/market-data-service-spec.md, epic #51.
 * Implemented ticket-by-ticket starting with #64.
 *
 * Ticket #194 adds the `bars`/`latest_mark` persistence port
 * (`MarketDataStore`) and its real `SqliteMarketDataStore` implementation
 * over the shared store's tables (#193), wired into `MarketDataServiceImpl`
 * as the Tier-2 bulk cache and the live mark table.
 */

export type {
  AlpacaCalendarClient,
  AlpacaCalendarClientOptions,
  AlpacaCalendarDay,
  AlpacaSessionRow,
} from './alpaca-session-calendar.js';
export {
  AlpacaCalendarFetchError,
  AlpacaEquitySessionCalendar,
  AlpacaHttpCalendarClient,
  buildAlpacaSessionTable,
  validateAlpacaCalendarDays,
} from './alpaca-session-calendar.js';
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
export type { MarkFreshness } from './mark-freshness.js';
export {
  classifyMarkFreshness,
  MARK_CLOCK_SKEW_TOLERANCE_MS,
  markAgeMs,
} from './mark-freshness.js';
export { collectMarks } from './marks-batch.js';
export type { RvolDegradedReason, RvolReading } from './rvol.js';
export { computeRvol, RVOL_SESSION_WINDOW } from './rvol.js';
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
  ALPACA_BARS_RETRY_CONFIG,
  ALPACA_BARS_TIMEOUT_MS,
  ALPACA_DATA_FEED_ENV_VAR,
  AlpacaHttpDataClient,
  DEFAULT_ALPACA_DATA_FEED,
  resolveAlpacaDataFeed,
  // #664: the Stage 2 backfill client (server/tools/backtest) now maps its
  // requested timeframe through this same converter rather than keeping a
  // second '1m' -> '1Min' table of its own.
  toAlpacaTimeframe,
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
// #562 — the live orchestrator's OHLCV failover. `withOhlcvFailover` itself
// stays off the barrel (the backfill script imports it directly, as it always
// has); what the composition root needs is the `DataSource`-shaped wrapper
// built on it, its per-leg config types, and the Polygon client that serves
// the equities fallback.
export type {
  DataSourceFallbackLeg,
  FailoverDataSourceConfig,
} from './sources/failover-data-source.js';
export {
  FAILOVER_CIRCUIT_COOLDOWN_MS,
  FAILOVER_CIRCUIT_FAILURE_THRESHOLD,
  FailoverDataSource,
  PrimaryCircuitOpenError,
} from './sources/failover-data-source.js';
// #734 — the LSE leveraged-ETP mark source, the producer that finally writes
// `latest_mark` rows keyed by `lse_ticker`. The VENDOR is not decided (see
// docs/research/34-lse-mark-source-options.md); the port, the GBP/pence
// normalisation and the no-substitution refusal are.
export type {
  LseMarkClient,
  LseMarkSourceOptions,
  LseVendorBars,
  LseVendorCandle,
  LseVendorQuote,
} from './sources/lse-mark-source.js';
export {
  BOOK_CURRENCY,
  isBookCurrency,
  LseMarkDataSource,
  MarkCurrencyError,
  NonTradeableInstrumentError,
  toBookCurrency,
} from './sources/lse-mark-source.js';
export type { LiveObservation, SourceConfig } from './sources/normalizing-data-source.js';
export {
  InSessionUnderfetchError,
  NormalizingDataSource,
  RawFetchLimitExceededError,
} from './sources/normalizing-data-source.js';
export type { BarFetcher, FailoverAlerter, FailoverEvent } from './sources/ohlcv-failover.js';
export type { PolygonBarsClientOptions } from './sources/polygon-bars-client.js';
export { PolygonBarsClient } from './sources/polygon-bars-client.js';
export type { SessionNormalizationConfig } from './sources/session-normalized-fetcher.js';
export { withSessionNormalization } from './sources/session-normalized-fetcher.js';
export { SqliteMarketDataStore } from './sqlite-market-data-store.js';
export { closeTimeOf, isDailyTimeframe, timeframeToMs } from './timeframe.js';
export type { TradingCalendar } from './trading-calendar.js';
export {
  AlwaysOpenCalendar,
  // #1378 — the hand-entered LSE tables' checked coverage cliff (the earlier
  // of the two tables' own checked-through dates); the boot guard in
  // production/lse-calendar-coverage-guard.ts enforces it.
  LSE_TABLE_COVERAGE_END,
  // #668 — the live equity leg's venue (#659: GBP LSE-listed ETFs, restriction
  // re-confirmed against the venue change, #946; venue itself is Saxo GIA per
  // ADR-0015's 2026-08-30 amendment, map #905 — not #659, which never named
  // a broker).
  LseRegularHoursCalendar,
  // #706 — policy, not venue: narrows WHEN equities may be entered inside a
  // session the calendar has already opened.
  londonEntryWindow,
  OVERLAP_WINDOW_LAST_ENTRY_MINUTES,
  OVERLAP_WINDOW_OPEN_MINUTES,
  // #684 — the hand-entered US table's checked coverage cliff; the calendar
  // fallback alert reports it so an operator knows how far to trust the
  // fallback.
  US_TABLE_COVERAGE_END,
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
  MarkRead,
  Quote,
} from './types.js';
export { INDICATOR_KINDS } from './types.js';
