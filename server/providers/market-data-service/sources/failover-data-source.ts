/**
 * Primary -> fallback failover at the `DataSource` port (#562), for the LIVE
 * orchestrator's bar reads.
 *
 * ## Why a second wrapper rather than reusing `withOhlcvFailover` directly
 *
 * `withOhlcvFailover` (./ohlcv-failover.ts) wraps a `BarFetcher` — the shape
 * the #512 warm-start backfill script composes, because that script talks to
 * vendor clients directly and never constructs a `DataSource`. The live
 * composition root (`server/apps/orchestrator/production.ts`) injects a
 * `DataSource` into `MarketDataServiceImpl`, so failover has to arrive as a
 * `DataSource`. This class is the adapter between the two: it holds a
 * primary `DataSource`, and delegates its `fetchBars` to the SAME
 * `withOhlcvFailover` the backfill uses, so there is exactly one
 * implementation of "try, alert, fall back" in the repo rather than two that
 * can drift.
 *
 * ## BARS ONLY — `fetchMark`/`fetchQuote` stay on the primary
 *
 * Both other port methods delegate straight to `primary` with no fallback,
 * and that is a decision rather than an omission. The fallback vendors named
 * by `docs/research/31-free-ohlcv-evidence.md` serve historical aggregates
 * and nothing else: Polygon's free tier has no quote endpoint at all and its
 * aggregates are delayed. A mark is what prices an open position, sizes the
 * next one and arms a stop — pricing those off a delayed, differently-
 * conventioned feed during a vendor stall is a worse failure than the read
 * failing loudly, because a loud failure is visible and a quietly-stale mark
 * is not. So: bars degrade to a second vendor, marks do not degrade at all.
 *
 * ## What counts as "the primary failed"
 *
 * Any THROW from `primary.fetchBars`, inherited unchanged from
 * `withOhlcvFailover`'s contract — including the underfetch errors
 * (`AlpacaDataUnderfetchError` after `AlpacaHttpDataClient`'s own
 * widen-and-retry, and `NormalizingDataSource`'s `InSessionUnderfetchError`).
 * Naming that explicitly because it has a real consequence: a mid-session
 * SHORT read, not just an outage, switches the vendor serving that
 * (instrument, timeframe) for that call, and Polygon reports up to ~8% less
 * volume than Alpaca on the same bar (polygon-bars-client.ts), which moves
 * `getADV()`'s denominator while a fallback-sourced bar sits in the window.
 * That is accepted deliberately: an underfetch that survived the primary's
 * own retry is a primary that cannot answer, and a second vendor's answer
 * with a known volume skew is worth more to a running book than no bars.
 * Every fallback bar is stamped with its own `source` (`bars.source`), so the
 * skew is detectable after the fact rather than anonymous.
 *
 * ## No re-derivation
 *
 * A bar served by the fallback is NOT replaced when the primary recovers —
 * explicitly decided in #562, not overlooked. `bars.source` makes a
 * fallback-sourced row detectable at any later time, so a re-derivation pass
 * is a separate, resumable job rather than something this wrapper must do
 * inline on a live tick; doing it inline would mean re-fetching history from
 * the vendor that just stalled, on the tick path, to fix a row that is
 * already usable.
 */
import type { BarWindow, DataSource, Mark, Quote } from '../types.js';
import { type BarFetcher, type FailoverAlerter, withOhlcvFailover } from './ohlcv-failover.js';

/** One instrument's fallback: which leg it belongs to, what serves it, and what that vendor is called. */
export interface DataSourceFallbackLeg {
  leg: 'equities' | 'crypto';
  /** Vendor name, as it appears in the alert and in `bars.source` (e.g. `'polygon'`). */
  name: string;
  fetchBars: BarFetcher;
}

export interface FailoverDataSourceConfig {
  primary: DataSource;
  /** Vendor name of `primary`, for the alert (e.g. `'alpaca'`). */
  primaryName: string;
  /**
   * The fallback for `instrument`, or `undefined` when that instrument has
   * none — in which case a primary failure propagates exactly as it did
   * before this wrapper existed.
   *
   * A per-instrument function rather than a per-asset-class map because the
   * legs genuinely differ in whether they HAVE a fallback: the equities leg
   * has Polygon; the crypto leg has no live fallback wired, crypto having
   * left Samurai's scope on 2026-08-16 (ADR-0015's amendment). Returning
   * `undefined` is the honest answer for an instrument nothing else can
   * serve, and is not the same as a silent pass-through default — the
   * composition root decides it explicitly.
   */
  fallbackFor: (instrument: string) => DataSourceFallbackLeg | undefined;
  /**
   * Raised BEFORE the fallback is attempted, so an operator learns about a
   * stall even when the fallback also fails. Guarded by `withOhlcvFailover`'s
   * own `safeAlert`: a throwing alerter can never mask the fallback's result.
   */
  alert: FailoverAlerter;
}

export class FailoverDataSource implements DataSource {
  readonly #config: FailoverDataSourceConfig;

  constructor(config: FailoverDataSourceConfig) {
    this.#config = config;
  }

  async fetchBars(instrument: string, window: BarWindow, asOf: Date) {
    const fallback = this.#config.fallbackFor(instrument);
    if (fallback === undefined) {
      return this.#config.primary.fetchBars(instrument, window, asOf);
    }

    const fetch = withOhlcvFailover({
      leg: fallback.leg,
      primary: (symbol, barWindow, at) => this.#config.primary.fetchBars(symbol, barWindow, at),
      primaryName: this.#config.primaryName,
      fallback: fallback.fetchBars,
      fallbackName: fallback.name,
      alert: this.#config.alert,
    });

    return fetch(instrument, window, asOf);
  }

  /** Primary only — see the module doc: a mark must not come from a delayed fallback feed. */
  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    return this.#config.primary.fetchMark(instrument, asOf, mode);
  }

  /**
   * Forwarded only when the primary implements it — `fetchQuote` is optional
   * on the port, and answering `null` is MDS's documented "no observable
   * spread", the same posture `AssetClassRoutingDataSource` takes. No
   * fallback here either: no fallback vendor quotes bid/ask.
   */
  async fetchQuote(instrument: string, asOf: Date): Promise<Quote | null> {
    const primary = this.#config.primary;
    if (primary.fetchQuote === undefined) return null;
    return primary.fetchQuote(instrument, asOf);
  }
}
