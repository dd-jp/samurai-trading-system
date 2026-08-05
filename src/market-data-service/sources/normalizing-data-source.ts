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
   * Requests `window.lookback + FORMING_BAR_FETCH_MARGIN` raw candles, not
   * `window.lookback` — the most recent one may still be forming at `asOf`
   * (issue #362; see `FORMING_BAR_FETCH_MARGIN`'s doc comment). `completedBars`
   * below is still asked for the caller's ORIGINAL `window.lookback`: the
   * margin only widens the raw request so that, once the forming candle (if
   * any) is filtered out, the caller still gets the count it asked for.
   */
  async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
    const candles = await this.fetchRawCandles(
      instrument,
      window.timeframe,
      asOf,
      window.lookback + FORMING_BAR_FETCH_MARGIN,
      window.partial,
    );
    const bars = normalizeBars(candles, {
      instrument,
      timeframe: window.timeframe,
      source: this.config.source,
      calendar: this.config.calendar,
    });

    return completedBars(bars, asOf, window.lookback);
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
