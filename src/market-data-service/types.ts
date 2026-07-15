/**
 * Domain types & contracts for the Market Data Service (Stage 0).
 * See docs/specs/market-data-service-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md (§3 MarketDataService).
 * Bar/mark serving landed in ticket #64. `getIndicator` / `IndicatorSpec` /
 * `IndicatorValue` are ticket #65's scope.
 */

/**
 * A single OHLCV candle. Sources (ccxt/IBKR/Alpaca) timestamp candles at
 * their open; ingestion computes and stores `close_time`, which is the
 * point-in-time key every read is filtered on.
 */
export interface Bar {
  instrument: string;
  timeframe: string;
  /** Source-native candle timestamp (period start). */
  open_time: Date;
  /** open_time + timeframe — the point-in-time key. */
  close_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 'kraken' | 'ibkr' | 'alpaca' ... — audit only; consumers ignore. */
  source: string;
}

/** Requested bar range: a timeframe and a lookback count ending at asOf. */
export interface BarWindow {
  /** '1m' | '5m' | '1h' | '1d' ... */
  timeframe: string;
  /** Count of bars (or duration) ending at asOf. */
  lookback: number;
}

/**
 * The current price for an instrument, scoped to when it was observed
 * rather than when it was requested.
 */
export interface Mark {
  price: number;
  /**
   * When the price was OBSERVED (not the request time): last trade/quote
   * time live; last completed bar's close_time in backtest.
   */
  observed_at: Date;
  source: string;
  asset_class: 'crypto' | 'stocks';
}

/**
 * A request for a service-computed technical indicator. The `lookback` is
 * the PINNED warm-up length: how many bars a recursive indicator (EMA, RSI,
 * ATR) is seeded over before producing `asOf`'s value. It is part of the
 * cache key (see `buildIndicatorCacheKey`) because the same `asOf` seeded
 * from a different history length is a different value under one key.
 */
export interface IndicatorSpec {
  /** 'sma' | 'ema' | 'rsi' | 'atr' ... */
  indicator: string;
  params: Record<string, number>;
  lookback: number;
}

/** A computed indicator value, pinned to the bar it was last updated from. */
export interface IndicatorValue {
  indicator: string;
  value: number;
  /** close_time of the last bar used to compute this value. */
  as_of_bar_close: Date;
}

/**
 * Source abstraction — the ONLY place that knows ccxt/IBKR/Alpaca specifics,
 * and the ONLY place that branches live vs backtest for marks. The serving
 * layer and all consumers stay source-blind; #66 supplies the real
 * ccxt/IBKR/Alpaca implementations of this port.
 */
export interface DataSource {
  fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark>;
}

/**
 * The single test seam consumers inject. Deterministic given inputs +
 * clock; source is injected.
 *
 * `asOf` is explicit here (the deterministic wiring/test form); the
 * implementation resolves it from the injected Clock in normal use so
 * callers stay clock-blind.
 */
export interface MarketDataService {
  getBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  getIndicator(instrument: string, spec: IndicatorSpec, asOf: Date): Promise<IndicatorValue>;
  getMark(instrument: string, asOf: Date): Promise<Mark>;
}
