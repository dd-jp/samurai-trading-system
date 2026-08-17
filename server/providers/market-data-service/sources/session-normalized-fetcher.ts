/**
 * Session normalization for a RAW vendor `BarFetcher` (#562).
 *
 * **The invariant: on the LIVE orchestrator's bar read path, a bar that
 * reaches the store carries the same session semantics whichever vendor
 * served it.** The primary (`AlpacaDataSource`) is a
 * `NormalizingDataSource`, so its bars are calendar-filtered and counted
 * before they leave the port; a fallback vendor client (`PolygonBarsClient`)
 * is a bare `BarFetcher` that applies no calendar at all. Handing that client
 * straight to `FailoverDataSource` makes `bars` mean one thing under Alpaca
 * and another under Polygon — an `atr(14)` over `lookback: 15` covering ~2
 * regular US sessions from the primary and ~1 extended-hours day from the
 * fallback, persisted permanently because `failover-data-source.ts`
 * deliberately never re-derives a fallback-served bar. This wrapper closes
 * that at the fallback's own edge.
 *
 * The invariant is scoped to the live read path. `backfill-market-data.ts`
 * composes the same vendor clients through `withOhlcvFailover` WITHOUT this
 * wrapper, so warm-start rows written by that script still carry each
 * vendor's own raw session coverage. Closing that asymmetry is a change to
 * the backfill script, not to this file.
 *
 * Implemented by delegating to `NormalizingDataSource` rather than by
 * filtering the returned array, because filtering alone would UNDER-SERVE:
 * dropping ~9 of a Polygon `1h` day's 16 bars leaves a `lookback: 15` ask
 * with ~7 bars and no way to ask for more. `NormalizingDataSource` already
 * owns the bounded widen-and-retry that turns "the caller wants 15 in-session
 * bars" into a raw request large enough to yield them, and reusing it means
 * the fallback and the primary cannot drift on what a window means.
 */
import type { RawCandle } from '../ingestion.js';
import type { TradingCalendar } from '../trading-calendar.js';
import type { BarWindow } from '../types.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';
import type { BarFetcher } from './ohlcv-failover.js';

export interface SessionNormalizationConfig {
  /** The raw vendor fetcher being wrapped. Its `window.lookback` is a RAW candle count, not the caller's in-session one. */
  fetch: BarFetcher;
  /** Vendor name, stamped onto every surviving bar as `Bar.source` — the same field `normalizeBars` stamps for the primary. */
  source: string;
  asset_class: 'crypto' | 'stocks';
  /** The SAME calendar the primary source was constructed with; any other value reintroduces the divergence this closes. */
  calendar: TradingCalendar;
}

/**
 * A `NormalizingDataSource` whose raw payload comes from a `BarFetcher`
 * instead of a vendor SDK. Only the open timestamp and OHLCV survive into
 * `RawCandle`: `instrument`/`timeframe`/`close_time`/`source` are re-derived
 * by `normalizeBars` from the normalization context, so a vendor that stamped
 * them differently cannot carry a second convention past this point.
 */
class SessionNormalizedFetcherSource extends NormalizingDataSource {
  readonly #fetch: BarFetcher;

  constructor(config: SessionNormalizationConfig) {
    super({
      source: config.source,
      asset_class: config.asset_class,
      calendar: config.calendar,
    });
    this.#fetch = config.fetch;
  }

  protected override async fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<RawCandle[]> {
    const window: BarWindow =
      partial === undefined
        ? { timeframe, lookback: limit }
        : { timeframe, lookback: limit, partial };
    const bars = await this.#fetch(instrument, window, asOf);

    return bars.map((bar) => ({
      open_time: bar.open_time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }

  /**
   * Unreachable by construction: `withSessionNormalization` exposes only
   * `fetchBars`, and the fallback is bars-only by decision
   * (`failover-data-source.ts` — a mark must not come from a delayed
   * aggregate feed). Throws rather than returning a plausible number so a
   * future caller that wires a mark through here finds out immediately.
   */
  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    throw new Error(
      `Session-normalized fallback fetcher for ${instrument} serves BARS ONLY — it has no live ` +
        'observation. Marks and quotes stay on the primary (failover-data-source.ts).',
    );
  }

  /** Same reason as `fetchLiveObservation`: no mark is ever derived here. */
  protected override get markTimeframe(): string {
    throw new Error(
      'Session-normalized fallback fetcher serves BARS ONLY — no backtest mark is derived from it.',
    );
  }
}

/**
 * Wraps `config.fetch` so its bars are calendar-filtered, completed-bar
 * filtered and counted exactly as the primary's are, returned as a plain
 * `BarFetcher` — the shape `FailoverDataSource` takes.
 *
 * Two consequences to know before reading a log:
 * - A window the vendor cannot cover IN SESSION throws
 *   `InSessionUnderfetchError`, which `withOhlcvFailover` reports as "both
 *   primary and fallback failed". Short-and-loud rather than wide-and-silent
 *   is the point: a stop distance computed off an extended-hours window is
 *   wrong, not degraded.
 * - Raw scarcity (the vendor returning fewer candles than asked) is NOT
 *   session loss and does not throw here — `NormalizingDataSource` returns the
 *   short serve and `computeIndicator`'s `InsufficientBarsError` is the loud
 *   guard one layer up, exactly as on the primary path.
 */
export function withSessionNormalization(config: SessionNormalizationConfig): BarFetcher {
  const source = new SessionNormalizedFetcherSource(config);
  return (symbol, window, asOf) => source.fetchBars(symbol, window, asOf);
}
