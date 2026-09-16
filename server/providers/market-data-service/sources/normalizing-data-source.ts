/**
 * Every source (Alpaca, LSE, …) normalizes through this one class, so "all
 * normalize into the same Bar/Mark shape" is structural rather than
 * parallel implementations kept in agreement by hand.
 */
import {
  completedBars,
  deriveBacktestMark,
  FORMING_BAR_FETCH_MARGIN,
  normalizeBars,
  type RawCandle,
} from '../ingestion.js';
import type { TradingCalendar } from '../trading-calendar.js';
import type { Bar, BarWindow, DataSource, Mark } from '../types.js';

/**
 * Bounded on purpose: unbounded widen-and-retry against a live venue would
 * walk back years of history for a symbol that never satisfies the window,
 * against the ~200 req/min budget (Alpaca's) this key shares with live
 * order placement. An "attempt" is one `fetchRawCandles` call, not one HTTP
 * request — worst case ~2x that under a client's own widen-and-retry. A
 * source paced far slower opts out via `SourceConfig.rawWidenPolicy`
 * instead of re-tuning this.
 */
const MAX_IN_SESSION_FETCH_ATTEMPTS = 4;
/**
 * For `'single-widest-retry'` sources (`SourceConfig.rawWidenPolicy`). 2,
 * not 1: one widen is what turns a mostly-out-of-session raw payload into a
 * serve at all — dropping to 1 would short-serve every intraday read.
 */
const MAX_WIDEST_RETRY_FETCH_ATTEMPTS = 2;
/**
 * Floor on how fast the raw request grows. An estimate landing just above
 * the current size would spend an attempt to learn almost nothing;
 * doubling guarantees each attempt asks a materially different question.
 */
const MIN_RAW_WIDEN_FACTOR = 2;
/**
 * Ceiling on how fast it grows. When nothing survived normalization there
 * is no survival rate to estimate from, so the widen would otherwise be
 * unbounded — 8x per attempt keeps a single step's page walk proportionate.
 */
const MAX_RAW_WIDEN_FACTOR = 8;
/**
 * A multiple of the caller's own ask, not a flat row count, so it means the
 * same thing at `1m` as at `1d`. 32x is ~6x headroom over what US equities
 * need: regular hours are ~19% of a 24h intraday feed, so ~5.2x the raw
 * span covers any lookback. This also bounds the page walk inside an
 * attempt.
 */
const MAX_RAW_LIMIT_MULTIPLE = 32;
/**
 * Absolute cap in ROWS, independent of `firstRawLimit`: the multiple above
 * has no ceiling that doesn't grow with the caller's own ask (RVOL's large
 * lookback is the case that exposed this). Set below
 * `AlpacaHttpDataClient`'s own `RETRY_MAX_ROWS` (25,000) so the two caps
 * don't fight. Enforced twice — clamps `rawLimitCeiling`, and a first ask
 * already over it fails loud before any fetch (see the check at the top of
 * `fetchBars`).
 */
const MAX_RAW_LIMIT_ABSOLUTE = 20_000;

/**
 * The widened raw requests could not produce `requested` completed,
 * in-session bars. Deliberately NOT `AlpacaDataUnderfetchError`: that error
 * names Alpaca specifically, but this skeleton also backs the LSE mark
 * source, so reusing it would misname the venue in the logs. Never
 * retryable by re-issuing — the widening already done IS the retry.
 */
export class InSessionUnderfetchError extends Error {
  readonly instrument: string;
  readonly timeframe: string;
  /** Completed, in-session bars the caller asked for */
  readonly requested: number;
  /** Completed, in-session bars the widest attempt actually produced */
  readonly received: number;
  /** Raw candles the widest attempt asked the source for */
  readonly rawRequested: number;
  /** How many widening attempts were spent before giving up */
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

/**
 * The caller's minimum raw ask already exceeds `MAX_RAW_LIMIT_ABSOLUTE` —
 * refused before any fetch, rather than silently clamping and serving a
 * truncated widen that `InSessionUnderfetchError` would then misreport as
 * ordinary session-normalization loss. Bump the limit deliberately if a
 * caller genuinely needs it.
 */
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

/** A live price observation, mapped out of a source's quote/trade payload */
export interface LiveObservation {
  price: number;
  /** When the price was OBSERVED — the source's trade/quote time */
  observed_at: Date;
}

export interface SourceConfig {
  /** The vendor that served it, e.g. 'alpaca' — audit only; consumers ignore. */
  source: string;
  asset_class: 'crypto' | 'stocks';
  /** Gates bar production to trading sessions; always-open for crypto */
  calendar: TradingCalendar;
  /**
   * How `fetchBars` spends its widen budget when the first raw ask falls
   * short. `'gradual'` (default) fits Alpaca, where requests are cheap and
   * over-fetching rows is the cost to avoid: up to
   * `MAX_IN_SESSION_FETCH_ATTEMPTS` requests, each sized from the previous
   * one's survival rate. `'single-widest-retry'` fits a source where the
   * REQUEST itself is scarce (e.g. the rate-limited Polygon fallback) — it
   * jumps straight to `rawLimitCeiling` on retry rather than stepping an
   * estimate, since that's already the widest ask any `'gradual'` sequence
   * could reach, so two requests there dominate four smaller ones.
   */
  rawWidenPolicy?: 'gradual' | 'single-widest-retry';
}

/**
 * Estimates the next raw size from the observed survival rate
 * (`inSession / rawReturned`) rather than a fixed multiplier — the rate is
 * a property of the venue's feed and the caller's timeframe, which a
 * constant can't know. Uses `window.lookback`, not `firstRawLimit`:
 * `inSession` is counted after the forming candle is already dropped, so
 * re-adding the margin would over-target. Clamped both ways — floor against
 * near-zero progress, cap for when nothing survived (`Infinity`).
 */
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

  /**
   * Map the source's historical-bars payload into open-timestamped candles.
   *
   * `partial` (issue #292) is the window's short-read policy, forwarded
   * verbatim so the decision stays at the call site that can reason about it.
   * A source with no notion of an under-covered range simply omits the
   * parameter — implementing this with four parameters stays type-correct.
   */
  protected abstract fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<RawCandle[]>;

  /** Map the source's streaming quote/trade payload into an observation */
  protected abstract fetchLiveObservation(instrument: string): Promise<LiveObservation>;

  /**
   * Guarantees `window.lookback` completed, in-session bars, or throws
   * loud. Enforced HERE because this is the only layer holding both the
   * calendar and the caller's count: the raw client only guarantees `limit`
   * bars on the RAW payload, and `normalizeBars` then drops out-of-session
   * candles after that guard already passed (pre/post-market-heavy feeds,
   * e.g. hourly equities, can under-serve even on a successful raw fetch).
   * Raising the client's own buffer multiplier would only be a
   * per-timeframe calibration, not a guarantee.
   *
   * The first raw ask adds `FORMING_BAR_FETCH_MARGIN` because the most
   * recent candle may still be forming at `asOf`; `completedBars` is still
   * measured against the caller's original `window.lookback`.
   *
   * Two short-read cases stay out of scope by design: `window.partial ===
   * 'allow'` is an explicit caller opt-in to a short window, and a source
   * returning fewer raw candles than asked has exhausted its history and
   * widening can't help — both throw loud elsewhere, not here.
   */
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

    // The widen budget and step size — see `SourceConfig.rawWidenPolicy`
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

      // The guarantee, checked on the bars the CALLER will actually receive
      if (served.length >= window.lookback) return served;
      // Explicit opt-in to a short window: one request, no widen, no throw
      if (window.partial === 'allow') return served;
      // RAW SCARCITY, NOT SESSION LOSS — must not be conflated. Fewer raw
      // candles than asked means the source has no more history; widening
      // can't help. Not silent: surfaces one layer up as
      // InsufficientBarsError once the serve falls under an indicator's
      // minimum. A caller whose lookback exceeds its indicator minimum, on
      // a source with no raw-count guard of its own, could still be served
      // short with no throw — that gap belongs with those clients' guards,
      // not here.
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

  /**
   * Live reads the source's latest observation; backtest derives from the last
   * completed bar and never touches the live mark (spec Module: Marks).
   *
   * A closed market is not an error: a stock mark is legitimately old when the
   * session is shut, which surfaces to consumers as a stale `observed_at`
   * (spec Module: Ingestion & Sources) rather than a throw.
   */
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

  /**
   * The bar granularity a backtest mark is derived from. Pinned per source so
   * the derivation is deterministic rather than dependent on whatever window a
   * caller last asked for.
   */
  protected abstract get markTimeframe(): string;
}
