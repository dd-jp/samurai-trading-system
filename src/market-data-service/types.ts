/**
 * Domain types & contracts for the Market Data Service (Stage 0).
 * See docs/specs/market-data-service-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md (§3 MarketDataService).
 * Bar/mark serving landed in ticket #64. `getIndicator` / `IndicatorSpec` /
 * `IndicatorValue` are ticket #65's scope. Ticket #67 adds the best-effort
 * spread estimate and ADV helper consumed by the cost model's `MarketState`.
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
  /**
   * What a source should do when the venue cannot produce `lookback` bars
   * (issue #292). Omitted means `'error'`: the safe behaviour is the default,
   * because almost every consumer of a short window is silently WRONG rather
   * than merely degraded — an SMA/RSI/ATR computed over 3 bars is presented
   * as an SMA/RSI/ATR over `lookback`, and a mispriced stop follows from it.
   *
   * `'allow'` is an explicit opt-in for the call sites that can actually
   * reason about a short window and already guard it (today: the Risk
   * Manager's correlation estimate, whose `min_bars` check omits an
   * under-covered pair by design). Only sources that can distinguish the two
   * cases honour it — `AlpacaHttpDataClient` does; the fixture/replay sources
   * serve fixed history and are unaffected.
   */
  partial?: 'error' | 'allow';
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
 * The `bars` / `latest_mark` persistence port (ticket #194) — the shared
 * SQLite store's Tier-2 bulk cache and the live mark table, behind the shared
 * store from #193. `appendBars` is idempotent per `(instrument, timeframe,
 * open_time)` (the `bars` PK): re-ingesting an already-stored bar is a no-op,
 * never a duplicate row or an error. `upsertLatestMark` overwrites the single
 * row per instrument — `latest_mark` holds only the current price, not
 * history.
 */
export interface MarketDataStore {
  appendBars(bars: readonly Bar[]): void;
  /** Ascending by close_time, filtered to `close_time <= asOf`, most recent `lookback`. */
  readBars(instrument: string, timeframe: string, asOf: Date, lookback: number): Bar[];
  upsertLatestMark(instrument: string, mark: Mark): void;
  readLatestMark(instrument: string): Mark | undefined;
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
 * `getMark`, `getIndicator` (#65), and the #67 spread/ADV helpers.
 *
 * `asOf` is explicit here (the deterministic wiring/test form); the
 * implementation resolves it from the injected Clock in normal use so
 * callers stay clock-blind.
 */
export interface MarketDataService {
  /**
   * Ascending by close_time, filtered to `close_time <= asOf`, most recent
   * `window.lookback` bars — the same ordering guarantee `MarketDataStore.readBars`
   * makes, restated here because this is the interface consumers are injected
   * with and `MarketDataStore` is an MDS-internal port they never see.
   *
   * The order is load-bearing, not incidental: `computeIndicator` requires
   * ascending bars, and `trader/decide.ts` feeds this result straight to it
   * without re-sorting. Implementations must honour it — but they are not
   * merely trusted to: `computeIndicator` asserts the order and throws, so a
   * source that served descending bars fails loudly instead of silently
   * repricing every ATR-derived stop.
   */
  getBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  getIndicator(instrument: string, spec: IndicatorSpec, asOf: Date): Promise<IndicatorValue>;
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
