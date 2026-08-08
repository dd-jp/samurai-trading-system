/**
 * Shared DataSource skeleton (ticket #66).
 *
 * Every source — ccxt, IBKR, Alpaca — normalizes through this one class, so
 * "all normalize into the same Bar/Mark shape" is structural rather than three
 * parallel implementations that must be kept in agreement by hand. A concrete
 * source supplies only what is genuinely source-specific: mapping its wire
 * payload to `RawCandle` / a live mark observation.
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
 * Attempts one `fetchBars` call may spend widening its RAW request to satisfy
 * the caller's COMPLETED, IN-SESSION count (issue #386).
 *
 * Bounded on purpose. An unbounded widen-and-retry loop against a live venue
 * is its own hazard: during a holiday week, an exchange halt, or an upstream
 * outage it would walk back years of paginated history for a symbol that will
 * never satisfy the window, on the ~200 req/min budget this key shares with
 * live order placement. Four attempts is enough for the adaptive widen below
 * to clear a weekend plus an adjacent holiday from a standing start; past
 * that, more requests are not evidence, they are noise.
 *
 * An "attempt" is one `fetchRawCandles` call, NOT one HTTP request. Under
 * `AlpacaHttpDataClient` each attempt is a paginated page walk, and a short
 * raw read triggers that client's own single widen-and-retry (#292) — so the
 * worst case is ~2 page walks per attempt, ~8 in total, not 4. Still bounded,
 * and bounded again below by `MAX_RAW_LIMIT_MULTIPLE`, which is what caps the
 * pages inside any one of them.
 */
const MAX_IN_SESSION_FETCH_ATTEMPTS = 4;
/**
 * Floor on how fast the raw request grows. The widen is estimated from the
 * observed in-session survival rate, and an estimate that lands just above the
 * current size would spend an attempt to learn almost nothing; doubling
 * guarantees each attempt is a materially different question.
 */
const MIN_RAW_WIDEN_FACTOR = 2;
/**
 * Ceiling on how fast it grows. When NOTHING survived normalization there is
 * no survival rate to estimate from, so the widen would otherwise be unbounded
 * — 8x per attempt keeps a single step's page walk proportionate.
 */
const MAX_RAW_WIDEN_FACTOR = 8;
/**
 * Absolute ceiling on the raw request, as a multiple of the caller's first
 * ask rather than a flat row count — so it means the same thing at `1m` as at
 * `1d`, and scales with the window instead of being a number tuned against one
 * timeframe.
 *
 * 32x is ~6x headroom over what US equities actually need: regular hours are
 * 6.5h of a 24h day, five days in seven, so in-session bars are ~19% of a
 * 24h-a-day intraday feed and ~5.2x the raw span covers any lookback.
 *
 * This is also what bounds the PAGE walk inside an attempt, so it is worth
 * checking against the live call sites rather than assuming. Every read that
 * reaches here for stocks with `partial` unset, at the widest window this
 * ceiling permits:
 * - `getIndicator` (`1h`, `lookback` 15 — the volatility provider and, via
 *   `atr_timeframe`/`atr_lookback + 1`, the Trader's stop): ~171 days,
 *   ~2.7k rows, ~3 pages.
 * - `getADV` (`1d`, `lookback` 20): daily bars survive normalization on any
 *   trading day, so this never widens at all.
 * - `fetchMark`'s backtest path (`markTimeframe`, `1m`, `lookback` 1): ~8.5
 *   hours.
 * No live call site combines a minute timeframe with a large lookback. One
 * that did would want a rows term here, as `RETRY_MAX_ROWS` is for the
 * client's own retry, rather than a multiple alone.
 */
const MAX_RAW_LIMIT_MULTIPLE = 32;

/**
 * The caller asked for `requested` COMPLETED, IN-SESSION bars and the widened
 * raw requests could not produce them (issue #386).
 *
 * Deliberately NOT `AlpacaDataUnderfetchError`, despite covering the same
 * "the venue answered fine, it just does not hold what you asked for" ground.
 * That error is raised by `AlpacaHttpDataClient` about the RAW wire payload
 * and names itself in its message; this skeleton also backs ccxt (Kraken) and
 * IBKR, so throwing an Alpaca-named error out of a Kraken read would misname
 * the venue in the logs — the same misattribution that let #358 hide for a
 * whole run. The two are complements, not alternatives: raw scarcity stays
 * the source client's `AlpacaDataUnderfetchError` (#292), and bars lost to
 * SESSION NORMALIZATION are this one.
 *
 * Never retryable by re-issuing: the widening this class already did IS the
 * retry, and it is exhausted by the time this is constructed.
 */
export class InSessionUnderfetchError extends Error {
  readonly instrument: string;
  readonly timeframe: string;
  /** Completed, in-session bars the caller asked for. */
  readonly requested: number;
  /** Completed, in-session bars the widest attempt actually produced. */
  readonly received: number;
  /** Raw candles the widest attempt asked the source for. */
  readonly rawRequested: number;
  /** How many widening attempts were spent before giving up. */
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

/** A live price observation, mapped out of a source's quote/trade payload. */
export interface LiveObservation {
  price: number;
  /** When the price was OBSERVED — the source's trade/quote time. */
  observed_at: Date;
}

export interface SourceConfig {
  /** 'kraken' | 'ibkr' | 'alpaca' — audit only; consumers ignore. */
  source: string;
  asset_class: 'crypto' | 'stocks';
  /** Gates bar production to trading sessions; always-open for crypto. */
  calendar: TradingCalendar;
}

/**
 * The next raw request size, estimated from what the LAST one actually
 * yielded: `inSession / rawReturned` is the observed survival rate through
 * session normalization, so `neededInSession / rate` is the raw count that
 * would have satisfied the caller. Estimating beats a fixed multiplier because
 * the rate is a property of the venue's feed and the caller's timeframe — the
 * two things a constant cannot know.
 *
 * `neededInSession` is the caller's `window.lookback`, NOT `firstRawLimit`.
 * `FORMING_BAR_FETCH_MARGIN` must not be added on top here: `inSession` is
 * counted AFTER `completedBars` has already dropped the forming candle, so the
 * margin is inside the measured rate and adding it again would target a bar
 * the caller never asked for. Over-targeting cannot produce a wrong ANSWER —
 * every quantity below is monotonic in `neededInSession`, so a larger target
 * only ever fetches more — but it does buy raw candles nobody needed, and
 * bar requests share a rate-limit budget with live order placement.
 *
 * Clamped on both sides. The floor stops an estimate that barely moves from
 * wasting an attempt; the cap keeps the step proportionate when nothing
 * survived and there is no rate to estimate from (`Infinity`). `ceiling` is
 * the absolute bound, and the caller treats "no room left under it" as
 * exhaustion rather than as a reason to re-ask the same question.
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

  /** Map the source's streaming quote/trade payload into an observation. */
  protected abstract fetchLiveObservation(instrument: string): Promise<LiveObservation>;

  /**
   * The caller's `window.lookback` COMPLETED, IN-SESSION bars — or a loud
   * error. Bars lost to SESSION NORMALIZATION are never short-served
   * silently; see the two carve-outs at the end of this comment for the two
   * shortfalls this method deliberately does not own.
   *
   * The first raw ask is `window.lookback + FORMING_BAR_FETCH_MARGIN`, not
   * `window.lookback` — the most recent candle may still be forming at `asOf`
   * (issue #362; see `FORMING_BAR_FETCH_MARGIN`'s doc comment). `completedBars`
   * is still asked for the caller's ORIGINAL `window.lookback`: the margin only
   * widens the raw request so that, once the forming candle (if any) is
   * filtered out, the caller still gets the count it asked for.
   *
   * **Why the guarantee has to be enforced HERE — the canonical account of
   * issue #386; other modules point here rather than restating it.** The
   * source client enforces "at least `limit` bars" on its RAW wire payload,
   * and `normalizeBars` below then drops every out-of-session candle — after
   * that guard has already passed. IEX equity bars carry pre/post-market
   * hours, so the gap is large and not a corner case. Measured live against
   * the paper account on 2026-08-05 with the US session shut, SPY at `1h`:
   * `BUFFER_MULTIPLIER`'s 5-day window held 26 raw bars, of which `getBars`
   * returned the newest 16 for a `lookback: 15` ask — and only 12 of those 16
   * were in session. Every equity ATR read threw `atr(14) needs 15 bars but
   * received 12`, on every tick. This is the only layer that holds BOTH the
   * calendar and the caller's count, so it is the only layer that can make the
   * contract true.
   *
   * Deliberately NOT fixed by raising the client's `BUFFER_MULTIPLIER`. A
   * multiplier that covers hourly equity bars today is a calibration that
   * happens to work, not a guarantee: it silently under-serves the next
   * timeframe, feed or venue, exactly as `drift_tolerance: 500` did. The
   * widening below is bounded and self-checking — the constants govern how
   * many requests the fix costs, never whether the count is right.
   *
   * Two short-read cases stay OUT of scope here, both by design:
   * - `window.partial === 'allow'` (#292) is the caller's explicit opt-in to a
   *   short window (the Risk Manager's correlation estimate). It costs exactly
   *   one request, as before, and never throws.
   * - A source that returns fewer RAW candles than asked has exhausted its
   *   history; widening cannot conjure bars that do not exist. That is raw
   *   scarcity, not session loss, and throwing `InSessionUnderfetchError` for
   *   it would misname the cause — see the long comment at that branch for
   *   the case that settles it. It is still LOUD, one layer up and under a
   *   correctly-named error (`InsufficientBarsError`, #319), plus
   *   `AlpacaDataUnderfetchError` (#292) before it on the MVP path.
   *
   * One consequence of widening worth knowing before reading a log: when the
   * venue's history runs out mid-widen, `AlpacaDataUnderfetchError` cites the
   * WIDENED raw count, not the caller's `lookback` (e.g. "requested 512" for a
   * `lookback: 15` ATR read). That number is honest — it is what was asked of
   * the venue — but it is not what the caller asked for. `requested` there
   * means raw candles; `InSessionUnderfetchError.requested` means the caller's
   * completed in-session count.
   */
  async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
    const context = {
      instrument,
      timeframe: window.timeframe,
      source: this.config.source,
      calendar: this.config.calendar,
    };
    const firstRawLimit = window.lookback + FORMING_BAR_FETCH_MARGIN;
    const rawLimitCeiling = firstRawLimit * MAX_RAW_LIMIT_MULTIPLE;

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

      // The guarantee, checked on the bars the CALLER will actually receive.
      if (served.length >= window.lookback) return served;
      // Opted in to a short window (#292): one request, no widen, no throw.
      if (window.partial === 'allow') return served;
      // RAW SCARCITY, NOT SESSION LOSS — and the two must not be conflated.
      // The source returned fewer raw candles than asked, so it has no more
      // history and widening cannot conjure bars that do not exist.
      //
      // Throwing InSessionUnderfetchError here was tried and REJECTED: it
      // misnames the cause. A sparse 24/7 crypto listing under
      // AlwaysOpenCalendar loses NOTHING to normalization, so 'the missing
      // bars fell outside a trading session' would be false, and it would
      // displace the loud guard that already covers this exact case —
      // ingestion-round-trip.test.ts's 'still refuses a window that is
      // genuinely short' pins InsufficientBarsError (#319) for it.
      //
      // So this is NOT a silent path. It is loud one layer up, via an error
      // that names the real cause: computeIndicator throws InsufficientBarsError
      // whenever the serve falls under minimumBarsFor(spec), which every
      // current getIndicator caller sits exactly on. AlpacaHttpDataClient
      // additionally fails loudly BEFORE this branch (AlpacaDataUnderfetchError,
      // #292), so on the MVP path it is unreachable.
      //
      // Residual gap, stated so it is not rediscovered: a caller whose
      // lookback EXCEEDS its indicator minimum, reading from a source with no
      // raw-count guard (ccxt/IBKR — neither live), could be served short
      // without any throw. Closing that belongs with those sources' own
      // guards, not here: the shortfall is a property of the venue's history,
      // not of the calendar, and this method cannot tell the difference.
      if (candles.length < rawLimit) return served;
      if (attempts >= MAX_IN_SESSION_FETCH_ATTEMPTS) break;

      const widened = widenRawLimit(rawLimit, candles.length, served.length, {
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
