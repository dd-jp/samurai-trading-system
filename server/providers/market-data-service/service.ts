import type { Logger } from '../../shared/index.js';
import { type Clock, currentTraceId, logCaughtFailure, safeLog } from '../../shared/index.js';
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

export interface MarketDataFetchTelemetry {
  logger: Logger;
}

export const MARKET_DATA_REPEATED_MISS_WARN_THRESHOLD = 3;

export class MarketDataServiceImpl implements MarketDataService {
  private readonly indicatorCache = new IndicatorCache();
  private readonly lastBarFetch = new Map<string, number>();
  private readonly inFlightBarFetches = new Map<string, Promise<Bar[]>>();
  private readonly lastMarkFetch = new Map<string, number>();
  private readonly consecutiveFetchMisses = new Map<string, number>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: Clock,
    private readonly mode: 'live' | 'backtest',
    private readonly store: MarketDataStore,
    private readonly markTtlMs: number = 5_000,
    private readonly telemetry?: MarketDataFetchTelemetry,
  ) {}

  async getBars(
    instrument: string,
    window: BarWindow,
    asOf: Date = this.clock.now(),
  ): Promise<Bar[]> {
    const cached = this.cachedBars(instrument, window, asOf);
    if (cached !== undefined) {
      this.consecutiveFetchMisses.delete(this.missCounterKey(instrument, window));
      return cached;
    }

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

  private async fetchAndStoreBars(
    instrument: string,
    window: BarWindow,
    asOf: Date,
  ): Promise<Bar[]> {
    const consecutiveMisses =
      this.mode === 'backtest' ? 0 : this.recordCacheMiss(instrument, window);
    const startedAt = Date.now();
    let fetched: Bar[];
    try {
      fetched = await this.dataSource.fetchBars(instrument, window, asOf);
    } catch (error) {
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

  private inFlightKey(instrument: string, window: BarWindow, asOf: Date): string {
    const partial = window.partial ?? 'error';
    return `${this.missCounterKey(instrument, window)}|${partial}|${this.barIndex(window.timeframe, asOf)}`;
  }

  private missCounterKey(instrument: string, window: BarWindow): string {
    return `${instrument}|${window.timeframe}|${window.lookback}`;
  }

  private recordCacheMiss(instrument: string, window: BarWindow): number {
    const key = this.missCounterKey(instrument, window);
    const next = (this.consecutiveFetchMisses.get(key) ?? 0) + 1;
    this.consecutiveFetchMisses.set(key, next);
    return next;
  }

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
    if (this.mode === 'backtest') return;

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

  private barIndex(timeframe: string, asOf: Date): number {
    return Math.floor(asOf.getTime() / timeframeToMs(timeframe));
  }

  private barCacheKey(instrument: string, timeframe: string): string {
    return `${instrument}|${timeframe}`;
  }

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

  async getMark(instrument: string, asOf: Date = this.clock.now()): Promise<Mark> {
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

  async getMarks(
    instruments: readonly string[],
    asOf: Date = this.clock.now(),
  ): Promise<Map<string, MarkRead>> {
    return collectMarks((instrument, at) => this.getMark(instrument, at), instruments, asOf);
  }

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

    const window: BarWindow = { timeframe: spec.timeframe, lookback: spec.lookback };
    const bars = await this.getBars(instrument, window, asOf);

    const lastBar = bars.at(-1);
    if (!lastBar) {
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

  async getSpreadEstimate(
    instrument: string,
    asOf: Date = this.clock.now(),
  ): Promise<number | null> {
    const quote = await this.getQuote(instrument, asOf);
    return quote === null ? null : quote.ask - quote.bid;
  }

  async getQuote(instrument: string, asOf: Date = this.clock.now()): Promise<Quote | null> {
    const quote = await this.dataSource.fetchQuote?.(instrument, asOf);
    if (!quote || quote.observed_at.getTime() > asOf.getTime()) {
      return null;
    }
    return quote;
  }

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
