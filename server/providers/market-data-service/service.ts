/** Market data service: bar/mark serving, deterministic indicator computation, two-tier caching */
import { type Clock, currentTraceId, logCaughtFailure, safeLog } from '../../shared/index.js';
import type { Logger } from '../../shared/types/primitives.js';
import { buildIndicatorCacheKey, IndicatorCache } from './indicator-cache.js';
import { computeIndicator } from './indicators.js';
import { collectMarks } from './marks-batch.js';
import { timeframeToMs } from './timeframe.js';
import type {
  Bar,
  BarWindow,
  DataSource,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarketDataStore,
  MarkRead,
  Quote,
} from './types.js';

/** Optional venue-fetch telemetry. `undefined` is the fully backward-compatible default at every call site. */
export interface MarketDataFetchTelemetry {
  logger: Logger;
}

/** Chosen so a single cold-start miss stays `info`, and only a run REPEATING the same failing window warns */
export const MARKET_DATA_REPEATED_MISS_WARN_THRESHOLD = 3;

/** Timeframes are explicitly config, tuned in paper trading; one default is used until that config lands */
export class MarketDataServiceImpl implements MarketDataService {
  private readonly indicatorCache = new IndicatorCache();
  /** `instrument|timeframe` -> the bar interval its last fetch was made in. In-process and restart-clean: a fresh process refetches. */
  private readonly lastBarFetch = new Map<string, number>();
  /**
   * `instrument|timeframe|lookback|partial|barIndex` -> the fetch already in
   * flight for exactly that window — joins concurrent callers of the same
   * window onto one venue call instead of each spending its own rate-limit
   * token (measured: one window fetched seven times in a single tick under
   * fan-out before this existed). `barIndex` and `partial` are in the key
   * because a caller a bar apart, or one wanting a different partial-read
   * contract, must not join a promise answering a different question.
   * Entries are removed in a `finally` so a rejection cannot poison the key.
   */
  private readonly inFlightBarFetches = new Map<string, Promise<Bar[]>>();
  /**
   * instrument -> when its mark was last FETCHED (wall-clock of the request,
   * not the mark's own trade-time `observed_at`, which can lag on an illiquid
   * symbol while the quote is fresh). In-process and restart-clean.
   */
  private readonly lastMarkFetch = new Map<string, number>();
  /**
   * `instrument|timeframe|lookback` -> consecutive cache-miss count. A
   * different key shape than `barCacheKey` (which ignores lookback) on
   * purpose: one (instrument, timeframe) can have a shallow window that hits
   * every tick and a deep window that misses every tick, and reusing
   * `barCacheKey` would let the shallow hit mask the deep window's streak.
   * Bounded by (instrument x static analyst indicator window), not unbounded —
   * every `BarWindow` a caller passes is a module-level constant, and the
   * universe is a fixed compile-time array, for the life of the process.
   */
  private readonly consecutiveFetchMisses = new Map<string, number>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: Clock,
    private readonly mode: 'live' | 'backtest',
    private readonly store: MarketDataStore,
    /** How long a live mark serves repeat callers from the store before the next fetch. Zero disables the reuse window entirely. */
    private readonly markTtlMs: number = 5_000,
    /** See `MarketDataFetchTelemetry`. Optional, backward-compatible. */
    private readonly telemetry?: MarketDataFetchTelemetry,
  ) {}

  /**
   * The Tier-2 bulk tier: fetches from the source, persists into the `bars`
   * table (idempotent), then serves from the persisted store rather than the
   * source's own return value, so every caller reads the real bulk cache.
   * Skips the fetch when already fetched within `asOf`'s bar interval and the
   * store has enough rows — DISABLED in backtest, where point-in-time
   * determinism outweighs the saved call in a mode with no network requests.
   */
  async getBars(
    instrument: string,
    window: BarWindow,
    asOf: Date = this.clock.now(),
  ): Promise<Bar[]> {
    const cached = this.cachedBars(instrument, window, asOf);
    if (cached !== undefined) {
      // Clears this window's miss streak so the next miss counts only the current run of failures
      this.consecutiveFetchMisses.delete(this.missCounterKey(instrument, window));
      return cached;
    }

    // Backtest replays a single walk and never overlaps calls, so there is nothing to join
    if (this.mode !== 'backtest') {
      const key = this.inFlightKey(instrument, window, asOf);
      const inFlight = this.inFlightBarFetches.get(key);
      if (inFlight !== undefined) {
        return inFlight;
      }
      const started = this.fetchAndStoreBars(instrument, window, asOf).finally(() => {
        this.inFlightBarFetches.delete(key);
      });
      this.inFlightBarFetches.set(key, started);
      return started;
    }

    return this.fetchAndStoreBars(instrument, window, asOf);
  }

  /** `getBars`'s miss path, extracted so the in-flight map above wraps exactly one call */
  private async fetchAndStoreBars(
    instrument: string,
    window: BarWindow,
    asOf: Date,
  ): Promise<Bar[]> {
    // Backtest skips the bump: `cachedBars` disables itself there, so every replay step would otherwise land here unbounded
    const consecutiveMisses =
      this.mode === 'backtest' ? 0 : this.recordCacheMiss(instrument, window);
    const startedAt = Date.now();
    let fetched: Bar[];
    try {
      fetched = await this.dataSource.fetchBars(instrument, window, asOf);
    } catch (error) {
      // Log the failed attempt with elapsed time, then rethrow unchanged — this observes, it never changes fetch behaviour
      this.logFetch(instrument, window, 'error', consecutiveMisses, Date.now() - startedAt, error);
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    this.logFetch(
      instrument,
      window,
      'ok',
      consecutiveMisses,
      durationMs,
      undefined,
      fetched.length,
    );

    const completed = fetched.filter((bar) => bar.close_time.getTime() <= asOf.getTime());
    this.store.appendBars(completed);
    this.recordFetch(instrument, window, asOf);
    return this.store.readBars(instrument, window.timeframe, asOf, window.lookback);
  }

  /** `${instrument}|${timeframe}|${lookback}|${partial}|${barIndex}` — see `inFlightBarFetches` for why the last two are part of this key */
  private inFlightKey(instrument: string, window: BarWindow, asOf: Date): string {
    const partial = window.partial ?? 'error';
    return `${this.missCounterKey(instrument, window)}|${partial}|${this.barIndex(window.timeframe, asOf)}`;
  }

  /** `${instrument}|${timeframe}|${lookback}` — see `consecutiveFetchMisses`'s doc comment for why lookback is part of this key and `barCacheKey` is not reused */
  private missCounterKey(instrument: string, window: BarWindow): string {
    return `${instrument}|${window.timeframe}|${window.lookback}`;
  }

  /** Bumps and returns the new consecutive-miss count for this exact (instrument, timeframe, lookback) */
  private recordCacheMiss(instrument: string, window: BarWindow): number {
    const key = this.missCounterKey(instrument, window);
    const next = (this.consecutiveFetchMisses.get(key) ?? 0) + 1;
    this.consecutiveFetchMisses.set(key, next);
    return next;
  }

  /**
   * The single `market_data_fetch` emission point — every venue-reaching
   * fetch, success or failure, goes through here. `trace_id` comes from the
   * ambient tick context, falling back to `'market-data'` when there is no
   * tick, since no `MarketDataService` method accepts one directly.
   */
  private logFetch(
    instrument: string,
    window: BarWindow,
    outcome: 'ok' | 'error',
    consecutiveMisses: number,
    durationMs: number,
    error?: unknown,
    rows?: number,
  ): void {
    if (this.telemetry === undefined) return;
    // Backtest re-fetches on every call by design, so every replay step would otherwise be an uninformative "miss"
    if (this.mode === 'backtest') return;

    // Escalation applies to the `ok` branch only — a thrown fetch is itself the anomaly regardless of streak length
    const level =
      outcome === 'error'
        ? 'warn'
        : consecutiveMisses >= MARKET_DATA_REPEATED_MISS_WARN_THRESHOLD
          ? 'warn'
          : 'info';
    const payload = {
      instrument,
      timeframe: window.timeframe,
      lookback: window.lookback,
      cache: 'miss' as const,
      consecutive_misses: consecutiveMisses,
      outcome,
      rows,
      duration_ms: Math.round(durationMs),
    };

    if (outcome === 'error') {
      logCaughtFailure(
        this.telemetry.logger,
        {
          trace_id: currentTraceId() ?? 'market-data',
          stage: 'market_data',
          event: 'market_data_fetch',
          level,
          message: `market_data_fetch: ${instrument} ${window.timeframe} (lookback ${window.lookback}) failed after ${Math.round(durationMs)}ms.`,
          started_at: new Date(Date.now() - durationMs).toISOString(),
          duration_ms: Math.round(durationMs),
        },
        error,
        payload,
      );
      return;
    }

    safeLog(this.telemetry.logger, {
      trace_id: currentTraceId() ?? 'market-data',
      stage: 'market_data',
      event: 'market_data_fetch',
      level,
      message: `market_data_fetch: ${instrument} ${window.timeframe} (lookback ${window.lookback}) fetched ${rows} row(s) in ${Math.round(durationMs)}ms.`,
      payload,
      started_at: new Date(Date.now() - durationMs).toISOString(),
      duration_ms: Math.round(durationMs),
    });
  }

  /** The bar interval `asOf` falls in — the cache's unit of freshness */
  private barIndex(timeframe: string, asOf: Date): number {
    return Math.floor(asOf.getTime() / timeframeToMs(timeframe));
  }

  private barCacheKey(instrument: string, timeframe: string): string {
    return `${instrument}|${timeframe}`;
  }

  /**
   * The stored window, if the store can satisfy `lookback` AND is known
   * fresh for `asOf`'s bar interval, by either of two routes: (1) this
   * instance already fetched it during this interval (blind across a
   * restart), or (2) the newest stored bar's `close_time` is under one full
   * timeframe width old, so the venue's fixed-cadence next bar cannot have
   * closed yet — elapsed-time rather than exact boundary-matching, since
   * real bars (Alpaca equities especially) are session-anchored, not
   * UTC-clock-aligned. Without route 2, a warm-started store filled by a
   * separate backfill process would force one live call per
   * (instrument, timeframe) on every process start regardless of history held.
   */
  private cachedBars(instrument: string, window: BarWindow, asOf: Date): Bar[] | undefined {
    if (this.mode === 'backtest') {
      return undefined;
    }

    const rows = this.store.readBars(instrument, window.timeframe, asOf, window.lookback);
    if (rows.length < window.lookback) {
      return undefined;
    }

    const fetchedAt = this.lastBarFetch.get(this.barCacheKey(instrument, window.timeframe));
    if (fetchedAt === this.barIndex(window.timeframe, asOf)) {
      return rows;
    }

    const latestStoredBar = rows.at(-1);
    const storeIsFreshForInterval =
      latestStoredBar !== undefined &&
      asOf.getTime() - latestStoredBar.close_time.getTime() < timeframeToMs(window.timeframe);

    return storeIsFreshForInterval ? rows : undefined;
  }

  private recordFetch(instrument: string, window: BarWindow, asOf: Date): void {
    this.lastBarFetch.set(
      this.barCacheKey(instrument, window.timeframe),
      this.barIndex(window.timeframe, asOf),
    );
  }

  /**
   * Forwards `mode` to `DataSource.fetchMark` without branching on it, except
   * for the persistence write, which must never touch `latest_mark` in
   * backtest — reading it in replay would inject a future price into a
   * historical decision
   */
  async getMark(instrument: string, asOf: Date = this.clock.now()): Promise<Mark> {
    // Repeat live callers inside the TTL serve from the store; backtest never takes this path
    if (this.mode === 'live') {
      const fetchedAt = this.lastMarkFetch.get(instrument);
      if (fetchedAt !== undefined && asOf.getTime() - fetchedAt <= this.markTtlMs) {
        const cached = this.store.readLatestMark(instrument);
        if (cached) return cached;
      }
    }

    const mark = await this.dataSource.fetchMark(instrument, asOf, this.mode);
    if (this.mode === 'backtest') {
      return mark;
    }

    this.lastMarkFetch.set(instrument, asOf.getTime());
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
   * Each instrument still goes through `getMark`, so the TTL cache, the
   * `latest_mark` write and the backtest no-write rule all apply exactly as
   * to a single read — this batches the CALL, not a second mark path.
   * Every read is attempted even after one has failed, so the caller gets the
   * whole picture rather than a `Promise.all` one-of-N diagnosis.
   */
  async getMarks(
    instruments: readonly string[],
    asOf: Date = this.clock.now(),
  ): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
  }

  /**
   * Deterministic pure function of (instrument, indicator+params, lookback,
   * asOf). `spec.lookback` is pinned into the Tier-1 cache key so a recursive
   * indicator (EMA/RSI/ATR) seeded from a different history length can never
   * collide with another value under the same key.
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

    // From the spec, not a module constant — a non-1h consumer must not silently compute on the wrong bars
    const window: BarWindow = { timeframe: spec.timeframe, lookback: spec.lookback };
    const bars = await this.getBars(instrument, window, asOf);

    const lastBar = bars.at(-1);
    if (!lastBar) {
      // Names the timeframe, not just the instrument: "no bars" is usually "no bars at THAT timeframe"
      throw new Error(
        `No ${spec.timeframe} bars for ${instrument} at or before ${asOf.toISOString()} ` +
          `(indicator '${spec.indicator}', lookback ${spec.lookback})`,
      );
    }

    const value: IndicatorValue = {
      indicator: spec.indicator,
      value: computeIndicator(bars, spec),
      as_of_bar_close: lastBar.close_time,
    };

    this.indicatorCache.set(cacheKey, value);
    return value;
  }

  /** `null` when the source has no bid/ask, no quote for this instrument/asOf, or a quote timestamped after `asOf` — never fabricated. Delegates to `getQuote` so the two never disagree. */
  async getSpreadEstimate(
    instrument: string,
    asOf: Date = this.clock.now(),
  ): Promise<number | null> {
    const quote = await this.getQuote(instrument, asOf);
    return quote === null ? null : quote.ask - quote.bid;
  }

  /** The genuine bid/ask observation, with the same PIT re-check `getSpreadEstimate` delegates to */
  async getQuote(instrument: string, asOf: Date = this.clock.now()): Promise<Quote | null> {
    const quote = await this.dataSource.fetchQuote?.(instrument, asOf);
    if (!quote || quote.observed_at.getTime() > asOf.getTime()) {
      return null;
    }
    return quote;
  }

  /** Average bar volume over the window. Throws on no bars rather than returning 0, which would divide-by-zero in the cost model's market-impact term. */
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
