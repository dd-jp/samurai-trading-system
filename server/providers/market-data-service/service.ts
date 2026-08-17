/**
 * Market Data Service — bar/mark serving (ticket #64) + deterministic
 * indicator computation and two-tier caching (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Point-in-Time
 * Enforcement, Module: Marks, Module: Indicators, Module: Caching) and
 * docs/specs/cross-spec-contracts.md §3.
 */
import type { Clock } from '../../shared/index.js';
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
} from './types.js';

/**
 * `IndicatorSpec` (per spec) pins `indicator`/`params`/`lookback` but not a
 * timeframe — timeframes are explicitly config, tuned in paper trading (spec
 * "Out of Scope: Exact parameters"). One default is used until that config
 * lands.
 */
export class MarketDataServiceImpl implements MarketDataService {
  private readonly indicatorCache = new IndicatorCache();
  /**
   * `instrument|timeframe` -> the bar interval its last fetch was made in
   * (#391). In-process and restart-clean, like `indicatorCache`: a fresh
   * process refetches, which is the conservative direction.
   */
  private readonly lastBarFetch = new Map<string, number>();
  /**
   * instrument -> when its mark was last FETCHED (wall-clock of the request,
   * not the mark's own trade-time `observed_at`, which can lag minutes on an
   * illiquid symbol while the quote is perfectly fresh). In-process and
   * restart-clean, like `lastBarFetch` — a fresh process refetches.
   */
  private readonly lastMarkFetch = new Map<string, number>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: Clock,
    private readonly mode: 'live' | 'backtest',
    private readonly store: MarketDataStore,
    /**
     * How long a live mark serves repeat callers from the store before the
     * next fetch (review 2026-08-06 A7). Within one tick, trader, risk's
     * portfolio view, and verdict each ask for the same instruments' marks
     * seconds apart — previously every call was its own venue round trip.
     * Zero disables the reuse window entirely.
     */
    private readonly markTtlMs: number = 5_000,
  ) {}

  /**
   * The Tier-2 bulk tier (#194): fetches from the source, persists into the
   * `bars` table (idempotent — a re-fetched bar is a no-op), then serves the
   * response from the persisted store rather than the source's own return
   * value. Every caller (direct, `getIndicator`, `getADV`) is therefore
   * reading the real bulk cache, not an in-memory structure.
   *
   * ## Skipping the fetch within one bar interval (#391)
   *
   * A repeat call inside the SAME bar interval cannot learn anything new — no
   * bar has closed since — so it serves from the store and makes no HTTP call.
   * That is what makes six instruments affordable on Alpaca's per-account
   * budget: without it, every tick re-fetched every instrument's whole window
   * even though at most one new bar exists per interval.
   *
   * The freshness test is deliberately NOT "the store holds >= lookback rows".
   * That check was rejected when this method was written, and correctly: a
   * store holding enough rows for an OLDER `asOf` satisfies it while missing
   * every bar since. The test here is instead "we already fetched this
   * (instrument, timeframe) during the bar interval `asOf` falls in", recorded
   * per process — so the cache can never serve data more than one interval
   * stale, and it needs no "freshest bar ingested" column (#194 does not add
   * one).
   *
   * A hit ALSO requires the store to actually return `lookback` rows. Callers
   * ask for different depths of the same series — `DEFAULT_VOLATILITY_INDICATOR`
   * uses 15 while the technical analyst uses 20 — so a shallow first fetch must
   * not satisfy a deeper later one within the same hour.
   *
   * DISABLED in backtest. Replay steps `asOf` on its own terms and may step
   * within an interval; point-in-time determinism (spec: Module: Point-in-Time
   * Enforcement) is worth more than the saved call in a mode that makes no
   * network requests anyway.
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
    const cached = this.cachedBars(instrument, window, asOf);
    if (cached !== undefined) {
      return cached;
    }

    const fetched = await this.dataSource.fetchBars(instrument, window, asOf);
    const completed = fetched.filter((bar) => bar.close_time.getTime() <= asOf.getTime());
    this.store.appendBars(completed);
    this.recordFetch(instrument, window, asOf);
    return this.store.readBars(instrument, window.timeframe, asOf, window.lookback);
  }

  /** The bar interval `asOf` falls in — the cache's unit of freshness. */
  private barIndex(timeframe: string, asOf: Date): number {
    return Math.floor(asOf.getTime() / timeframeToMs(timeframe));
  }

  private barCacheKey(instrument: string, timeframe: string): string {
    return `${instrument}|${timeframe}`;
  }

  /**
   * The stored window, if the store can satisfy this call's `lookback` AND
   * is known fresh for `asOf`'s bar interval — by either of two routes.
   *
   * The store read happens FIRST, before either route is consulted, which is
   * a change from the pre-#512 order (interval check, then read). Route 2
   * cannot decide freshness without the rows, and both routes need them to
   * return anything, so the only call this costs an extra read is one where
   * BOTH routes miss and a live fetch was about to happen anyway — an
   * indexed range scan against an HTTP round trip.
   *
   * ## Route 1: in-process fetch history (#391, the original test)
   *
   * This (instrument, timeframe) was already fetched, by THIS instance,
   * during `asOf`'s bar interval. Exact, but blind across a process restart:
   * `lastBarFetch` is an in-memory map with no constructor seam, so it starts
   * empty every time this class is constructed.
   *
   * ## Route 2: store recency (#512, warm-start backfill)
   *
   * Without route 2, a warm-started `SqliteMarketDataStore` — filled by a
   * separate backfill process before the orchestrator even starts — is
   * invisible to this check: a fresh process's `lastBarFetch` is always
   * empty, so route 1 alone would force one live HTTP call per
   * (instrument, timeframe) on literally every process start regardless of
   * how much history the store already holds — `paper-profile.ts`'s
   * `correlationConfig.window` comment documents exactly this gap as a
   * live-Alpaca observation ("MarketDataServiceImpl.getBars calls
   * DataSource.fetchBars on every request ... so a cold first tick pulls the
   * whole window straight from Alpaca's archive").
   *
   * The test here is stricter than "the store holds >= lookback rows" for
   * the same reason the doc comment above (this method's original one) gives
   * for rejecting that as route 1's test: a store holding enough rows for an
   * OLDER `asOf` would satisfy a count check while missing every bar since.
   * Route 2 instead asks whether LESS THAN ONE FULL TIMEFRAME WIDTH has
   * elapsed since the most recently stored bar's `close_time` — i.e. bars
   * for this (instrument, timeframe) are produced at a fixed cadence, so if
   * the newest known one closed under one width ago, the next bar in that
   * same fixed sequence cannot have closed yet either, regardless of what
   * wall-clock phase the venue's bars are stamped at.
   *
   * That phase-agnosticism is deliberate, not incidental: an exact
   * "close_time equals the UTC interval boundary" test would silently never
   * match real Alpaca equity bars, which are session-anchored (a `1Day` bar
   * closes at the next session's open, not UTC midnight; an `1Hour` bar
   * closes on the half-hour during EDT) rather than UTC-clock-aligned —
   * `timeframe.ts`'s `isDailyTimeframe` doc ("whose bar covers an entire
   * session") is the same fact from the other side. Coinbase's UTC-midnight
   * daily opens would pass an exact-boundary test; Alpaca's would not, which
   * would make the store-recency route silently inert for every equity in
   * `DEFAULT_UNIVERSE` while still (incorrectly) claiming to cover crypto.
   * Elapsed-time avoids depending on either venue's stamp convention.
   *
   * Any gap of a FULL WIDTH OR MORE — a session close over a weekend, a
   * backfill run stale by more than one interval — makes this false and
   * falls through to a real fetch, which is the conservative direction (the
   * same bound route 1 already accepts: a repeat call inside the SAME
   * recorded interval, i.e. under one width old).
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
   * Live vs backtest derivation lives inside `DataSource.fetchMark(mode)`;
   * this method forwards `mode` without branching on it, staying mode-blind
   * — except for the persistence write, which must never touch `latest_mark`
   * in backtest (spec Module: Marks: reading it in replay would inject a
   * future price into a historical decision). Live upserts into the real
   * table and reads the row back, so both the write and the read sides
   * exercise the real store, not just the freshly fetched value.
   */
  async getMark(instrument: string, asOf: Date = this.clock.now()): Promise<Mark> {
    // Repeat live callers inside the TTL serve from the store (A7): the same
    // freshness argument as the bar-interval skip above, at mark timescale.
    // Backtest never takes this path — `latest_mark` must stay untouched there.
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
   * The batch form (#289 H8). See `MarketDataService.getMarks` for the
   * contract; this implementation adds nothing to it beyond the concurrency.
   *
   * Each instrument still goes through `getMark`, so the TTL cache, the
   * `latest_mark` write and the backtest no-write rule all apply exactly as
   * they do to a single read — this is a batching of the CALL, not a second
   * mark path that could drift from the first. `DataSource` has no batch
   * `fetchMark`, so a genuinely single round-trip to the venue is not
   * available to build on today; what this collapses is the caller's N call
   * sites into one, and with them the N places a partial failure could be
   * handled differently.
   *
   * Every read is attempted even after one has failed — the point of the
   * result type is that the caller gets the WHOLE picture, and a short-circuit
   * would hand it the same one-of-N diagnosis `Promise.all` already gave. That
   * containment lives in `collectMarks`, shared with the doubles, so no
   * implementation of this method can quietly adopt a different policy.
   */
  async getMarks(
    instruments: readonly string[],
    asOf: Date = this.clock.now(),
  ): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
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

    // From the SPEC, not the module constant (#315). The constant pinned every
    // caller to 1h, so a non-1h consumer either bypassed this whole serving
    // layer — losing the Tier-1 cache — or, worse, came through anyway and had
    // its indicator silently computed on the wrong bars.
    const window: BarWindow = { timeframe: spec.timeframe, lookback: spec.lookback };
    const bars = await this.getBars(instrument, window, asOf);

    const lastBar = bars.at(-1);
    if (!lastBar) {
      // Names the TIMEFRAME, not just the instrument (#315). Now that the
      // window comes from the spec, "no bars" is most often "no bars at THAT
      // timeframe" — a spec asking for one nothing ingests fails here, and
      // without the timeframe in the message it reads as missing data.
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
