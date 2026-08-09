/**
 * Alpaca DataSource — the ADR-0001 MVP source (ticket #66).
 * See docs/specs/market-data-service-spec.md (Module: Ingestion & Sources):
 * Alpaca supplies historical bars AND streaming quotes for the MVP universe
 * (SPY/QQQ/AAPL/TSLA equities + the BTC-USD/ETH-USD pairs Alpaca supports),
 * normalizing into the same Bar/latest_mark representation as ccxt/IBKR.
 *
 * Alpaca serves both asset classes, so the calendar is chosen by `asset_class`:
 * equities gate on the injected session calendar, crypto runs 24/7. The client
 * is injected — connection provisioning is an ops task (spec Dependencies).
 */
import type { RawCandle } from '../ingestion.js';
import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../trading-calendar.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';

/** Alpaca's bar payload, timestamped at the bar's open. */
export interface AlpacaBar {
  /** RFC-3339 open timestamp. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Alpaca's latest-quote payload. */
export interface AlpacaQuote {
  /** RFC-3339 quote timestamp. */
  t: string;
  /** Ask price. */
  ap: number;
  /** Bid price. */
  bp: number;
}

export interface AlpacaClient {
  /**
   * `partial` (issue #292) is the caller's short-read policy: omitted or
   * `'error'` means an implementation that CAN detect an under-covered range
   * must fail loudly rather than return fewer than `limit` bars; `'allow'` is
   * the explicit opt-in for a caller that tolerates a short window.
   */
  getBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<AlpacaBar[]>;
  getLatestQuote(symbol: string): Promise<AlpacaQuote>;
}

export interface AlpacaSourceOptions {
  asset_class: 'crypto' | 'stocks';
  /**
   * Session calendar for equities. Defaults to regular US equity hours; the
   * real holiday/session table injects here (see trading-calendar.ts).
   * Ignored for crypto, which is 24/7.
   */
  calendar?: TradingCalendar | undefined;
  /** Bar granularity backtest marks derive from. */
  markTimeframe?: string | undefined;
}

export class AlpacaDataSource extends NormalizingDataSource {
  readonly #client: AlpacaClient;
  readonly #markTimeframe: string;

  constructor(client: AlpacaClient, options: AlpacaSourceOptions) {
    super({
      source: 'alpaca',
      asset_class: options.asset_class,
      calendar:
        options.asset_class === 'crypto'
          ? new AlwaysOpenCalendar()
          : (options.calendar ?? new UsEquityRegularHoursCalendar()),
    });
    this.#client = client;
    this.#markTimeframe = options.markTimeframe ?? '1m';
  }

  protected override get markTimeframe(): string {
    return this.#markTimeframe;
  }

  protected override async fetchRawCandles(
    instrument: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial?: 'error' | 'allow',
  ): Promise<RawCandle[]> {
    const bars = await this.#client.getBars(instrument, timeframe, asOf, limit, partial);

    return bars.map((bar) => ({
      open_time: new Date(bar.t),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));
  }

  /**
   * Midpoint of the latest quote, observed at the quote's own timestamp — not
   * the request time (spec: staleness). When the equity session is shut this
   * legitimately returns an old observation rather than failing.
   */
  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    const quote = await this.#client.getLatestQuote(instrument);

    return {
      price: (quote.ap + quote.bp) / 2,
      observed_at: new Date(quote.t),
    };
  }
}
