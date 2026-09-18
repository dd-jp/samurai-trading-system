import {
  completedBars,
  deriveBacktestMark,
  FORMING_BAR_FETCH_MARGIN,
  normalizeBars,
  type RawCandle,
} from '../ingestion.js';
import type { TradingCalendar } from '../trading-calendar.js';
import type { Bar, BarWindow, DataSource, Mark } from '../types.js';

const MAX_IN_SESSION_FETCH_ATTEMPTS = 4;
const MAX_WIDEST_RETRY_FETCH_ATTEMPTS = 2;
const MIN_RAW_WIDEN_FACTOR = 2;
const MAX_RAW_WIDEN_FACTOR = 8;
const MAX_RAW_LIMIT_MULTIPLE = 32;
const MAX_RAW_LIMIT_ABSOLUTE = 20_000;

export class InSessionUnderfetchError extends Error {
  readonly instrument: string;
  readonly timeframe: string;
  readonly requested: number;
  readonly received: number;
  readonly rawRequested: number;
  readonly attempts: number;

  constructor(details: {
    instrument: string;
    timeframe: string;
    requested: number;
    received: number;
    rawRequested: number;
    attempts: number;
    source: string;
  }) {
    super(
      `${details.source} bars for ${details.instrument} ${details.timeframe}: ` +
        `${details.received} completed in-session bars for a requested ${details.requested}, ` +
        `after ${details.attempts} widening attempt(s) up to ${details.rawRequested} raw candles. ` +
        'The raw payload was long enough; the missing bars fell outside a trading session and ' +
        'were dropped by normalization. Refusing to return a short window silently — an ' +
        'indicator computed over fewer bars than the caller asked for is wrong, not merely ' +
        "degraded. Pass partial: 'allow' if this call site genuinely tolerates fewer bars.",
    );
    this.name = 'InSessionUnderfetchError';
    this.instrument = details.instrument;
    this.timeframe = details.timeframe;
    this.requested = details.requested;
    this.received = details.received;
    this.rawRequested = details.rawRequested;
    this.attempts = details.attempts;
  }
}

export class RawFetchLimitExceededError extends Error {
  readonly instrument: string;
  readonly timeframe: string;
  readonly requestedRawLimit: number;
  readonly absoluteLimit: number;

  constructor(details: {
    instrument: string;
    timeframe: string;
    requestedRawLimit: number;
    absoluteLimit: number;
    source: string;
  }) {
    super(
      `${details.source} bars for ${details.instrument} ${details.timeframe}: the first raw ask ` +
        `(${details.requestedRawLimit} candles) already exceeds the absolute raw-row cap of ` +
        `${details.absoluteLimit}. Refusing to fetch unbounded history. Lower window.lookback, or ` +
        'raise MAX_RAW_LIMIT_ABSOLUTE in normalizing-data-source.ts as a deliberate, reviewed change.',
    );
    this.name = 'RawFetchLimitExceededError';
    this.instrument = details.instrument;
    this.timeframe = details.timeframe;
    this.requestedRawLimit = details.requestedRawLimit;
    this.absoluteLimit = details.absoluteLimit;
  }
}

export interface LiveObservation {
  price: number;
  observed_at: Date;
}

export interface SourceConfig {
  source: string;
  asset_class: 'crypto' | 'stocks';
  calendar: TradingCalendar;
  rawWidenPolicy?: 'gradual' | 'single-widest-retry';
}

function widenRawLimit(
  current: number,
  rawReturned: number,
  inSession: number,
  bounds: { neededInSession: number; ceiling: number },
): number {
  const survivalRate = rawReturned > 0 ? inSession / rawReturned : 0;
  const estimated =
    survivalRate > 0 ? Math.ceil(bounds.neededInSession / survivalRate) : Number.POSITIVE_INFINITY;

  const stepped = Math.max(
    current * MIN_RAW_WIDEN_FACTOR,
    Math.min(estimated, current * MAX_RAW_WIDEN_FACTOR),
  );
  return Math.min(bounds.ceiling, stepped);
}

export abstract class NormalizingDataSource implements DataSource {
  protected constructor(private readonly config: SourceConfig) {}

  protected abstract fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<RawCandle[]>;

  protected abstract fetchLiveObservation(instrument: string): Promise<LiveObservation>;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the retry loop's guards share accumulated state (attempts, rawLimit, served) across iterations and are explicitly reasoned against each other in the comments above (raw scarcity vs session loss "must not be conflated"); splitting them into sub-functions would orphan that cross-guard reasoning.
  async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
    const context = {
      instrument,
      timeframe: window.timeframe,
      source: this.config.source,
      calendar: this.config.calendar,
    };
    const firstRawLimit = window.lookback + FORMING_BAR_FETCH_MARGIN;
    if (firstRawLimit > MAX_RAW_LIMIT_ABSOLUTE) {
      throw new RawFetchLimitExceededError({
        instrument,
        timeframe: window.timeframe,
        requestedRawLimit: firstRawLimit,
        absoluteLimit: MAX_RAW_LIMIT_ABSOLUTE,
        source: this.config.source,
      });
    }
    const rawLimitCeiling = Math.min(
      firstRawLimit * MAX_RAW_LIMIT_MULTIPLE,
      MAX_RAW_LIMIT_ABSOLUTE,
    );

    const widestRetry = this.config.rawWidenPolicy === 'single-widest-retry';
    const maxAttempts = widestRetry
      ? MAX_WIDEST_RETRY_FETCH_ATTEMPTS
      : MAX_IN_SESSION_FETCH_ATTEMPTS;

    let rawLimit = firstRawLimit;
    let attempts = 0;
    let served: Bar[] = [];

    while (true) {
      attempts++;
      const candles = await this.fetchRawCandles(
        instrument,
        window.timeframe,
        asOf,
        rawLimit,
        window.partial,
      );
      served = completedBars(normalizeBars(candles, context), asOf, window.lookback);

      if (served.length >= window.lookback) return served;
      if (window.partial === 'allow') return served;
      if (candles.length < rawLimit) return served;
      if (attempts >= maxAttempts) break;

      const widened = widestRetry
        ? rawLimitCeiling
        : widenRawLimit(rawLimit, candles.length, served.length, {
            neededInSession: window.lookback,
            ceiling: rawLimitCeiling,
          });
      if (widened <= rawLimit) break;
      rawLimit = widened;
    }

    throw new InSessionUnderfetchError({
      instrument,
      timeframe: window.timeframe,
      requested: window.lookback,
      received: served.length,
      rawRequested: rawLimit,
      attempts,
      source: this.config.source,
    });
  }

  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    if (mode === 'live') {
      const observation = await this.fetchLiveObservation(instrument);
      return {
        price: observation.price,
        observed_at: observation.observed_at,
        source: this.config.source,
        asset_class: this.config.asset_class,
      };
    }

    const bars = await this.fetchBars(
      instrument,
      { timeframe: this.markTimeframe, lookback: 1 },
      asOf,
    );
    return deriveBacktestMark(bars, instrument, asOf, this.config.asset_class);
  }

  protected abstract get markTimeframe(): string;
}
