/**
 * Market Data Service — bar/mark serving (ticket #64) + deterministic
 * indicator computation and two-tier caching (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Point-in-Time
 * Enforcement, Module: Marks, Module: Indicators, Module: Caching) and
 * docs/specs/cross-spec-contracts.md §3.
 */
import type { Clock } from '../shared/clock.js';
import { buildIndicatorCacheKey, IndicatorCache } from './indicator-cache.js';
import { computeIndicator } from './indicators.js';
import type {
  Bar,
  BarWindow,
  DataSource,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarketDataStore,
} from './types.js';

/**
 * `IndicatorSpec` (per spec) pins `indicator`/`params`/`lookback` but not a
 * timeframe — timeframes are explicitly config, tuned in paper trading (spec
 * "Out of Scope: Exact parameters"). One default is used until that config
 * lands.
 */
const DEFAULT_INDICATOR_TIMEFRAME = '1h';

export class MarketDataServiceImpl implements MarketDataService {
  private readonly indicatorCache = new IndicatorCache();

  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: Clock,
    private readonly mode: 'live' | 'backtest',
    private readonly store: MarketDataStore,
  ) {}

  /**
   * The Tier-2 bulk tier (#194): fetches from the source, persists into the
   * `bars` table (idempotent — a re-fetched bar is a no-op), then serves the
   * response from the persisted store rather than the source's own return
   * value. Every caller (direct, `getIndicator`, `getADV`) is therefore
   * reading the real bulk cache, not an in-memory structure.
   *
   * Still calls `dataSource.fetchBars` once per call rather than serving
   * straight from `store.readBars` on a row-count match: a persisted cache
   * that already holds >= `lookback` bars for an *older* `asOf` would satisfy
   * that count check while missing every bar ingested since — a stepping
   * backtest replay (same lookback, advancing `asOf` tick by tick) would
   * silently serve stale data with no way to detect the gap short of asking
   * the source. Skipping the fetch needs the store to track "freshest bar
   * ingested" per (instrument, timeframe), which #194 does not add; until it
   * does, this trades the "not re-fetched per call" half of the Tier-2 spec
   * intent (Module: Caching) for correctness. `store.readBars` still serves
   * every response, and `appendBars`'s idempotency makes the redundant fetch
   * cheap to persist.
   *
   * Filtering to `close_time <= asOf` happens twice by construction: once
   * before the write (so a source that leaks a forming candle never persists
   * it) and once implicitly in the read (`readBars`'s own `close_time <= ?`).
   * The forming candle is never returned as complete either way.
   */
  async getBars(
    instrument: string,
    window: BarWindow,
    asOf: Date = this.clock.now(),
  ): Promise<Bar[]> {
    const fetched = await this.dataSource.fetchBars(instrument, window, asOf);
    const completed = fetched.filter((bar) => bar.close_time.getTime() <= asOf.getTime());
    this.store.appendBars(completed);
    return this.store.readBars(instrument, window.timeframe, asOf, window.lookback);
  }

  /**
   * Live vs backtest derivation lives inside `DataSource.fetchMark(mode)`;
   * this method forwards `mode` without branching on it, staying mode-blind
   * — except for the persistence write, which must never touch `latest_mark`
   * in backtest (spec Module: Marks: reading it in replay would inject a
   * future price into a historical decision). Live upserts into the real
   * table and reads the row back, so both the write and the read sides
   * exercise the real store, not just the freshly fetched value.
   */
  async getMark(instrument: string, asOf: Date = this.clock.now()): Promise<Mark> {
    const mark = await this.dataSource.fetchMark(instrument, asOf, this.mode);
    if (this.mode === 'backtest') {
      return mark;
    }

    this.store.upsertLatestMark(instrument, mark);
    const stored = this.store.readLatestMark(instrument);
    if (!stored) {
      throw new Error(
        `MarketDataServiceImpl.getMark: latest_mark write for '${instrument}' did not persist.`,
      );
    }
    return stored;
  }

  /**
   * Deterministic pure function of (instrument, indicator+params, lookback,
   * asOf). `spec.lookback` is pinned into the Tier-1 cache key so a
   * recursive indicator (EMA/RSI/ATR) seeded from a different history
   * length can never collide with another value under the same key.
   * Tier-1 (this cache) is what makes a call "free" on a repeat hit; the
   * Tier-2 bulk read underneath it is `getBars` — see its doc comment for
   * why that still calls the source once per miss rather than trusting the
   * persisted cache's row count alone.
   */
  async getIndicator(
    instrument: string,
    spec: IndicatorSpec,
    asOf: Date = this.clock.now(),
  ): Promise<IndicatorValue> {
    const cacheKey = buildIndicatorCacheKey(instrument, spec, asOf);
    const cached = this.indicatorCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const window: BarWindow = { timeframe: DEFAULT_INDICATOR_TIMEFRAME, lookback: spec.lookback };
    const bars = await this.getBars(instrument, window, asOf);

    const lastBar = bars.at(-1);
    if (!lastBar) {
      throw new Error(`No bars for ${instrument} at or before ${asOf.toISOString()}`);
    }

    const value: IndicatorValue = {
      indicator: spec.indicator,
      value: computeIndicator(bars, spec),
      as_of_bar_close: lastBar.close_time,
    };

    this.indicatorCache.set(cacheKey, value);
    return value;
  }

  /**
   * `null` when the source doesn't quote bid/ask at all (`fetchQuote` is
   * unimplemented), when it has no quote for this instrument/asOf, or when
   * a returned quote is timestamped after `asOf` (defensive PIT re-check,
   * mirroring `getBars`'s close-time re-filter) — never a fabricated value.
   */
  async getSpreadEstimate(
    instrument: string,
    asOf: Date = this.clock.now(),
  ): Promise<number | null> {
    const quote = await this.dataSource.fetchQuote?.(instrument, asOf);
    if (!quote || quote.observed_at.getTime() > asOf.getTime()) {
      return null;
    }
    return quote.ask - quote.bid;
  }

  /**
   * Average bars volume over the window, via the same PIT-filtered
   * `getBars` every other read uses. Throws when the window has no bars
   * (matching `FixtureDataSource.fetchMark`'s "no completed bar" behaviour)
   * rather than returning 0, which would divide-by-zero in the cost
   * model's √(size / adv) market-impact term.
   */
  async getADV(
    instrument: string,
    window: BarWindow,
    asOf: Date = this.clock.now(),
  ): Promise<number> {
    const bars = await this.getBars(instrument, window, asOf);
    if (bars.length === 0) {
      throw new Error(
        `No bars for ${instrument} in window ending ${asOf.toISOString()} to compute ADV`,
      );
    }
    const totalVolume = bars.reduce((sum, bar) => sum + bar.volume, 0);
    return totalVolume / bars.length;
  }
}
