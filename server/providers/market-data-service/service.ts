/**
 * Market Data Service — bar/mark serving (ticket #64) + deterministic
 * indicator computation and two-tier caching (ticket #65).
 * See docs/specs/market-data-service-spec.md (Module: Point-in-Time
 * Enforcement, Module: Marks, Module: Indicators, Module: Caching) and
 * docs/specs/cross-spec-contracts.md §3.
 */
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

/**
 * Optional venue-fetch telemetry (#1082). A service built without this
 * argument behaves exactly as before — no import, no log line, nothing to
 * wire — matching the `TokenBucketTelemetry` (#1083) precedent this mirrors:
 * `undefined` is the fully backward-compatible default at every pre-#1082
 * call site.
 */
export interface MarketDataFetchTelemetry {
  logger: Logger;
}

/**
 * A cache MISS whose (instrument, timeframe, lookback) has already missed
 * this many times in a row escalates from `info` to `warn` (#1082) — the
 * issue's own pathological case: a window the venue can never fully satisfy
 * (e.g. a 936-bar RVOL lookback on a thin symbol) re-walks pages every tick
 * forever, and that steady state deserves louder-than-routine visibility
 * without needing a SEPARATE mechanism to detect it. 3 is not tuned against
 * measured data (there is none yet — that is this ticket's whole premise);
 * it is chosen so a single cold-start miss (every instrument's first tick)
 * stays `info`, and only a run REPEATING the same failing window warns.
 */
export const MARKET_DATA_REPEATED_MISS_WARN_THRESHOLD = 3;

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
   * `instrument|timeframe|lookback|partial|barIndex` -> the fetch already in
   * flight for exactly that window (#1080).
   *
   * `lastBarFetch` above is written when a fetch COMPLETES, so it is blind to
   * one that is still running: under the fan-out every concurrent caller asking
   * for the same window missed together, and every one of them spent a venue
   * token on the same bytes. Measured in the 2026-09-10 19:56 soak burst — 133
   * fetches over 34 distinct windows, all logged `cache: "miss"`, one window
   * fetched seven times in a single tick. Against Alpaca's shared bucket
   * (`shared/http/venue-pacing.ts`, 2.0 tok/s with 20 tokens of headroom above
   * the order path's reserve) those 99 redundant tokens are ~50s of queue that
   * every analyst's answer deadline then waited behind.
   *
   * Two fields beyond `(instrument, timeframe, lookback)` are in the key
   * because sharing a promise across either would hand a joiner a different
   * contract than it asked for:
   *
   *  - `barIndex`, because two callers a bar apart want genuinely different
   *    data and the later one would get a window stopping short of its `asOf`.
   *  - `window.partial`, because `'allow'` and the default `'error'` disagree
   *    about what a short read means (`alpaca-http-client.ts`), and a caller
   *    that wanted the throw would silently receive a short window instead.
   *
   * An analyst RETRY joins one of these rather than re-issuing, and that is the
   * intended reading rather than an accident. `AnalystOrchestrator` runs its
   * second attempt without an `AbortSignal`, so attempt 1's fetch is still in
   * flight, and `barIndex` is unchanged across a 30s gap at 5m or 1h — so
   * attempt 2 lands on this key. Re-asking the venue would put a second request
   * behind the same token queue that made attempt 1 slow; joining costs no
   * token and settles when the first settles, which `fetchWithTimeout`
   * (10,000ms, inside a bounded `withRetry`) bounds independently of anything
   * here. The price is that analysts-spec.md story 19's retry absorbs a
   * transient FAULT and not a transient QUEUE, which that spec now says.
   *
   * Entries are removed in a `finally`, so a rejection cannot poison the key —
   * the next caller re-fetches rather than replaying a stale error.
   */
  private readonly inFlightBarFetches = new Map<string, Promise<Bar[]>>();
  /**
   * instrument -> when its mark was last FETCHED (wall-clock of the request,
   * not the mark's own trade-time `observed_at`, which can lag minutes on an
   * illiquid symbol while the quote is perfectly fresh). In-process and
   * restart-clean, like `lastBarFetch` — a fresh process refetches.
   */
  private readonly lastMarkFetch = new Map<string, number>();
  /**
   * `instrument|timeframe|lookback` -> consecutive cache-miss count (#1082).
   * Deliberately a DIFFERENT key shape than `barCacheKey` (which ignores
   * lookback): the issue's pathological case is one (instrument, timeframe)
   * whose SHALLOW window hits every tick (e.g. `WARMUP_5M`'s 260) while its
   * DEEP window misses every tick (e.g. `RVOL_5M_LOOKBACK`'s 936) — reusing
   * `barCacheKey` would let the shallow hit reset the deep window's counter
   * every tick and hide the exact repeated-miss pattern this exists to show.
   * In-process and restart-clean, like the other fetch-history maps above.
   *
   * Only touched from `getBars`'s hit/miss branches. `getIndicator`'s own
   * Tier-1 cache (above, `indicatorCache`) can satisfy a request without
   * ever calling `getBars` at all — on that path this counter neither
   * increments nor resets, which is correct: no venue fetch happened, so
   * the streak legitimately stands unchanged until the next real `getBars`
   * call resolves it one way or the other.
   *
   * BOUND (review on #1095, deepseek): this map's key space is
   * (instrument x static analyst indicator window), not unbounded. Every
   * `BarWindow` a caller passes is a module-level constant computed once
   * at load time (`technical-analyst.ts`'s `WARMUP_5M`, `RVOL_5M_LOOKBACK`,
   * `INDICATOR_LOOKBACK`-derived specs, etc. — see that file, not a value
   * derived per-tick from live data), and today's instrument set
   * (`DEFAULT_UNIVERSE`, `scheduler.ts`) is a hardcoded, compile-time array
   * of ~20 names — there is no runtime re-rank or screener wiring it yet
   * ("This is a paper-soak widening, NOT #751", per that file's own doc
   * comment; `ActiveUniverseProvider` does not exist in this codebase as
   * of #1082/#1095 — it is a NAME for #751's not-yet-built future cutover,
   * referenced only in comments). So today this map holds at most
   * instruments x windows keys for the LIFE OF THE PROCESS (one
   * `MarketDataServiceImpl` is constructed once in
   * `buildProductionComponents` and never recreated) — measured at ~8
   * windows/instrument (see `logFetch`'s AC3 comment), that's a firm,
   * small ceiling (~160 for a 20-name universe), not a leak. If #751 later
   * makes the universe re-rank across days within one long-running
   * process, an instrument dropped from the universe would orphan its keys
   * here indefinitely — revisit bounding this (e.g. evict on universe
   * change, which #751 would be positioned to signal) when that lands, not
   * speculatively now.
   *
   * Skipped entirely in backtest mode (`getBars` never calls
   * `recordCacheMiss` there) — see that call site's comment: backtest
   * disables the cache unconditionally, so every call would otherwise be
   * an uninformative "miss" that could run many symbols over long
   * historical replay windows, which is the one mode where this map's
   * size was NOT already bounded by the live/paper universe above.
   */
  private readonly consecutiveFetchMisses = new Map<string, number>();

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
    /** #1082 — see `MarketDataFetchTelemetry`. Optional, backward-compatible. */
    private readonly telemetry?: MarketDataFetchTelemetry,
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
      // Cache HITS stay silent (#1082 AC3) — a healthy, warmed run logs ~0
      // lines/tick. A hit also clears this exact window's miss streak, so
      // `consecutive_misses` on the next miss counts only the CURRENT run of
      // failures, not a stale accumulation from before the window recovered.
      this.consecutiveFetchMisses.delete(this.missCounterKey(instrument, window));
      return cached;
    }

    // Backtest replays a single walk and never overlaps calls, so joining an
    // in-flight fetch can only add a map to a path that has nothing to share
    // — and `cachedBars` already disables itself there for the same reason.
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

  /** `getBars`'s miss path, extracted so the in-flight map above wraps exactly one call. */
  private async fetchAndStoreBars(
    instrument: string,
    window: BarWindow,
    asOf: Date,
  ): Promise<Bar[]> {
    // Backtest never touches `consecutiveFetchMisses` at all (review on
    // #1095, deepseek) — `cachedBars` disables itself unconditionally in
    // that mode (see its own doc comment), so EVERY replay step lands here,
    // and a backtest run can walk many symbols over long historical
    // windows. Bumping the map on every one of those calls would be the one
    // path where its size isn't already bounded by the live/paper universe
    // (see the map's own doc comment) — so skip the bump entirely rather
    // than rely on `logFetch`'s later `mode === 'backtest'` short-circuit to
    // make the wasted increment harmless. `0` is never read: `logFetch`
    // returns before consulting `consecutiveMisses` in backtest mode.
    const consecutiveMisses =
      this.mode === 'backtest' ? 0 : this.recordCacheMiss(instrument, window);
    const startedAt = Date.now();
    let fetched: Bar[];
    try {
      fetched = await this.dataSource.fetchBars(instrument, window, asOf);
    } catch (error) {
      // #1082's whole premise: the 106 undiagnosable analyst timeouts are the
      // fetches that never RETURNED. Log the failed attempt with its elapsed
      // time — a line with duration_ms far past the analyst's 10s deadline is
      // exactly the fetch that stalled it — then rethrow UNCHANGED (AC5: this
      // observes, it never changes fetch behaviour or outcome).
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

  /** `${instrument}|${timeframe}|${lookback}|${partial}|${barIndex}` — see `inFlightBarFetches` for why the last two are part of this key. */
  private inFlightKey(instrument: string, window: BarWindow, asOf: Date): string {
    const partial = window.partial ?? 'error';
    return `${this.missCounterKey(instrument, window)}|${partial}|${this.barIndex(window.timeframe, asOf)}`;
  }

  /** `${instrument}|${timeframe}|${lookback}` — see `consecutiveFetchMisses`'s doc comment for why lookback is part of this key and `barCacheKey` is not reused. */
  private missCounterKey(instrument: string, window: BarWindow): string {
    return `${instrument}|${window.timeframe}|${window.lookback}`;
  }

  /** Bumps and returns the new consecutive-miss count for this exact (instrument, timeframe, lookback). */
  private recordCacheMiss(instrument: string, window: BarWindow): number {
    const key = this.missCounterKey(instrument, window);
    const next = (this.consecutiveFetchMisses.get(key) ?? 0) + 1;
    this.consecutiveFetchMisses.set(key, next);
    return next;
  }

  /**
   * The single `market_data_fetch` emission point (#1082) — every venue-
   * reaching fetch, success or failure, goes through here.
   *
   * `event: 'market_data_fetch'` is grep-unique the same way #1083's
   * `token_bucket_wait` is: chosen to survive a search that a bare
   * `market_data`/`fetch` cannot, since both substring-match unrelated log
   * lines elsewhere in the pipeline.
   *
   * Fields deliberately OMITTED, and why: `pages` (Alpaca's HTTP client
   * tracks its own pagination loop internally and `DataSource.fetchBars`'s
   * return type carries no channel to surface it — plumbing one through
   * every `DataSource` implementation, live and fixture alike, is a
   * different-shaped change than "observe the existing choke point").
   * `trace_id` is subject to that same constraint — no `MarketDataService`
   * method accepts one — so it comes from the ambient tick context
   * (`shared/trace-context.ts`), falling back to the `'market-data'` label
   * when there is genuinely no tick. That is exactly
   * the AC3 note below: the analyst's 8 windows per tick are in-tick fetches,
   * and they now say which tick.
   * `pages` remains the issue's own "if available" qualifier; a reader
   * chasing pagination detail still has this line's `duration_ms` as the
   * signal that a fetch paginated slowly, just not how many pages it took.
   *
   * AC3 volume bound (measured, not estimated — `npm run smoke`, 4 ticks,
   * paper/live mode): a single instrument's technical analyst issues 8
   * distinct (timeframe, lookback) `getBars` windows per tick (observed:
   * 5m/260, 1h/20, 5m/112, 5m/84, 5m/81, 5m/936, 1h/57, 1d/30). Cache hits
   * are silent, so that's also the worst-case ceiling PER INSTRUMENT PER
   * TICK — reached only on a cold store (first tick after startup/restart,
   * or any window whose bar interval never lines up with the cache's
   * recency check, e.g. RVOL's 936-bar lookback, which can stay a "miss"
   * indefinitely and is exactly what `consecutive_misses` surfaces). That
   * eight is a ceiling on the LINES, not a count of distinct cold fetches:
   * this smoke fixture is too shallow to serve the narrower 5m specs, so
   * they missed on row count rather than on freshness. #1543 measured the
   * same cold pass against history deep enough to satisfy every window and
   * got THREE (`5m/260`, `1h/20`, `5m/936`) — the narrow specs collapse onto
   * the shared warm-up through route 1 exactly as they do warm. Once
   * the store is warm, most windows hit every tick and this drops to ~0-2
   * lines/instrument/tick — only a bar-interval rollover re-triggers a
   * fetch. Across a 20-name universe that's ~160 lines on a cold start,
   * not ~160/tick steady-state. Backtest mode is silent unconditionally
   * (see the `mode === 'backtest'` check below), so it never adds to this.
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
    // Backtest re-fetches on EVERY call by design (`cachedBars` disables
    // itself there — see its doc comment) — every replay step is therefore a
    // "miss" that carries no information, and logging each one would flood a
    // backtest run's output with lines this ticket's AC3 volume bound is
    // meant to prevent. Live/paper is the mode #1082's 106 timeouts were
    // observed in, and where a stalled venue fetch is the diagnostic this
    // exists for.
    if (this.mode === 'backtest') return;

    // Consecutive-miss escalation applies to the `ok` branch only. A thrown
    // fetch — "the fetch that never returned" this issue exists to surface —
    // must not depend on happening to land on the 3rd+ consecutive miss on
    // this exact key to be visible at `warn`; a single throw on an otherwise
    // healthy key is itself the anomaly. Matches the sibling `logCaughtFailure`
    // sites (`residual-protection-sweep.ts`, `ingest-fills.ts`), which both
    // derive `level` from the failure's own severity, not from an unrelated
    // counter.
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
   *
   * Delegates to `getQuote` so the two never disagree about what "no quote"
   * means — a single PIT check, not two that could drift.
   */
  async getSpreadEstimate(
    instrument: string,
    asOf: Date = this.clock.now(),
  ): Promise<number | null> {
    const quote = await this.getQuote(instrument, asOf);
    return quote === null ? null : quote.ask - quote.bid;
  }

  /**
   * The genuine bid/ask observation — #1001. Same source call and same PIT
   * re-check `getSpreadEstimate` used to do inline (now the other way
   * around: that method delegates here).
   */
  async getQuote(instrument: string, asOf: Date = this.clock.now()): Promise<Quote | null> {
    const quote = await this.dataSource.fetchQuote?.(instrument, asOf);
    if (!quote || quote.observed_at.getTime() > asOf.getTime()) {
      return null;
    }
    return quote;
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
