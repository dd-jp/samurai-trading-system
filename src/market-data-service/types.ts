/**
 * Domain types & contracts for the Market Data Service (Stage 0).
 * See docs/specs/market-data-service-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md (§3 MarketDataService).
 * Implementation ticket #64 — bar/mark serving only. `getIndicator` /
 * `IndicatorSpec` / `IndicatorValue` are ticket #65's scope and are not
 * declared here yet. Ticket #67 adds the best-effort spread estimate and
 * ADV helper consumed by the cost model's `MarketState`.
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
 * A best-effort bid/ask observation. Only sources that quote a live order
 * book (e.g. crypto ccxt) can produce one; `DataSource.fetchQuote` is
 * therefore optional, and its absence (or a `null` return) is how MDS
 * signals "no bid/ask available" rather than fabricating a spread.
 */
export interface Quote {
  bid: number;
  ask: number;
  /** When the quote was observed — checked against `asOf` like `Mark.observed_at`. */
  observed_at: Date;
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
  /** Optional: only implemented by sources that quote bid/ask (e.g. crypto ccxt). */
  fetchQuote?(instrument: string, asOf: Date): Promise<Quote | null>;
}

/**
 * The single test seam consumers inject. Deterministic given inputs +
 * clock; source is injected. Subset of the full spec interface — `getBars`,
 * `getMark`, and the #67 spread/ADV helpers; `getIndicator` lands in #65.
 *
 * `asOf` is explicit here (the deterministic wiring/test form); the
 * implementation resolves it from the injected Clock in normal use so
 * callers stay clock-blind.
 */
export interface MarketDataService {
  getBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  getMark(instrument: string, asOf: Date): Promise<Mark>;
  /**
   * Best-effort bid/ask spread (ask - bid) where the source provides a
   * quote; `null` otherwise. MDS never fabricates a spread it can't
   * observe — the cost model owns the fallback (cross-spec OPEN-GAP-A).
   */
  getSpreadEstimate(instrument: string, asOf: Date): Promise<number | null>;
  /**
   * Average bars volume over the point-in-time window — the liquidity
   * proxy for the cost model's √-law market impact term. Reuses `getBars`,
   * so it is no-lookahead by construction.
   */
  getADV(instrument: string, window: BarWindow, asOf: Date): Promise<number>;
}
