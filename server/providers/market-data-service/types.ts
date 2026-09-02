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
 * The indicator kinds `computeIndicator` can serve (#703 step B2).
 *
 * A `const` array rather than a bare union so the set can be ITERATED as well
 * as type-checked — `indicator-golden.test.ts` walks it to assert every kind
 * has a baseline, which is what stops a new kind arriving unmeasured. Every
 * member has a row in `indicators.ts`'s `INDICATORS` registry, and TypeScript
 * enforces that: the registry is a `Record` over this union.
 */
export const INDICATOR_KINDS = [
  'sma',
  'ema',
  'rsi',
  'atr',
  // #744 additions. `atr_pct` and `bb_kc_squeeze` are SCALE-DEPENDENT (they
  // carry price/volatility units, not just a normalized oscillator reading):
  // on a leveraged ETP these scale with the leverage factor versus the
  // liquid US underlying, so a spec comparing the two across instruments
  // must target one consistently (docs/adr/0016, the volume-caveat
  // reasoning extended to leverage). None of the five reads `bar.volume` —
  // the volume-derived-targets-the-underlying criterion has no work under
  // this ticket; it stays live for whichever future kind (RVOL, MFI) first
  // consumes volume.
  'atr_pct',
  'macd_histogram',
  'adx',
  'donchian_pos',
  'bb_kc_squeeze',
] as const;

export type IndicatorKind = (typeof INDICATOR_KINDS)[number];

/**
 * A request for a service-computed technical indicator. The `lookback` is
 * the PINNED warm-up length: how many bars a recursive indicator (EMA, RSI,
 * ATR) is seeded over before producing `asOf`'s value. It is part of the
 * cache key (see `buildIndicatorCacheKey`) because the same `asOf` seeded
 * from a different history length is a different value under one key.
 */
export interface IndicatorSpec {
  /**
   * The union rather than `string` (#703 step B2). Verified absent from
   * `contracts/` before narrowing, so this costs nothing on the wire — it is
   * not a persisted or transmitted shape, only an in-process request.
   *
   * As `string` this accepted `'RSI'`, `'rsi14'` or a typo, and every one of
   * them reached `computeIndicator`'s `default` and threw at TICK time, on a
   * value the composition root could have rejected at boot.
   */
  indicator: IndicatorKind;
  params: Record<string, number>;
  lookback: number;
  /**
   * The bar timeframe the indicator is computed over (#315).
   *
   * REQUIRED, not optional-with-a-1h-default. `getIndicator` used to hardcode
   * `'1h'`, so any non-1h consumer had to bypass the serving layer — and worse,
   * routing one through anyway would have silently pinned it to 1h with no
   * error, which for the Trader means silently changing every stop distance.
   * An optional field defaulting to 1h reproduces exactly that trap for every
   * caller who forgets it; a required one turns each into a compile error.
   *
   * Part of the cache key: the same indicator and lookback on a different
   * timeframe is a different value and must not collide.
   */
  timeframe: string;
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
 * One instrument's outcome in a batch mark read (#289 H8) — a mark, or the
 * reason there isn't one.
 *
 * A discriminated union rather than `Mark | undefined` so a caller cannot
 * reach the price without first deciding what to do about the failures, and so
 * the ORIGINAL throw survives to the caller's report instead of being
 * flattened into "missing". `error` is `unknown` for the reason every catch in
 * this repo keeps it `unknown`: it is whatever the source threw, re-thrown or
 * aggregated by the caller, never inspected here.
 */
export type MarkRead =
  | { readonly ok: true; readonly mark: Mark }
  | { readonly ok: false; readonly error: unknown };

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
   * Every requested instrument's mark at one `asOf`, keyed by instrument
   * (#289 H8).
   *
   * Result-typed per instrument rather than `Promise<Map<string, Mark>>`,
   * because the caller this exists for values a whole book: a rejecting
   * `Promise.all` over N `getMark` calls reports whichever lookup lost the
   * race and DISCARDS the rest, and a Map that simply omits the failures is
   * worse still — `PortfolioView.exposure_by_instrument`'s consumers all read
   * an absent key as zero exposure, so a silently-partial answer widens every
   * risk cap that reads it. `MarkRead` makes "we did not get this one" a value
   * the caller must handle rather than a hole it can miss.
   *
   * Staleness is NOT judged here. The freshness bound is per asset class and
   * per consumer (`PortfolioAccountingInput.max_mark_age` vs
   * `VerdictConfig.max_mark_age`), and MDS holds neither — see
   * `computePortfolioView`, which applies its own bound to what this returns.
   *
   * Duplicates in `instruments` are read once; the returned Map has one entry
   * per DISTINCT instrument.
   */
  getMarks(instruments: readonly string[], asOf: Date): Promise<Map<string, MarkRead>>;
  /**
   * Best-effort bid/ask spread (ask - bid) where the source provides a
   * quote; `null` otherwise. MDS never fabricates a spread it can't
   * observe — the cost model owns the fallback (cross-spec OPEN-GAP-A).
   */
  getSpreadEstimate(instrument: string, asOf: Date): Promise<number | null>;
  /**
   * The genuine bid/ask observation behind `getSpreadEstimate` — added for
   * #1001 (persisting the quote at order submit), which needs the two SIDES,
   * not their scalar difference. `null` under exactly the conditions
   * `getSpreadEstimate` returns `null` for: the source doesn't implement
   * `DataSource.fetchQuote` (e.g. Alpaca's own `AlpacaDataSource`), it has no
   * quote for this instrument/asOf, or a returned quote is timestamped after
   * `asOf` (PIT re-check). MDS never fabricates a side it can't observe — a
   * caller wanting bid/ask MUST use this, never derive them from
   * `getSpreadEstimate`'s scalar plus a separately-fetched mid.
   */
  getQuote(instrument: string, asOf: Date): Promise<Quote | null>;
  /**
   * Average bars volume over the point-in-time window — the liquidity
   * proxy for the cost model's √-law market impact term. Reuses `getBars`,
   * so it is no-lookahead by construction.
   */
  getADV(instrument: string, window: BarWindow, asOf: Date): Promise<number>;
}
