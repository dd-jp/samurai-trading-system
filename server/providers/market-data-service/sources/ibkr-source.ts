/**
 * Stock DataSource via IBKR TWS (ticket #66).
 * See docs/specs/market-data-service-spec.md (Module: Ingestion & Sources):
 * "IBKR TWS streaming during market hours + scheduled historical polling/
 * backfill." The long-term stock source; Alpaca is the MVP path (ADR-0001).
 *
 * The TWS client is injected — connection provisioning is an ops/setup task,
 * not this spec's logic (spec Dependencies). `IbkrClient` is kept to the
 * narrowest slice this source needs (open-timestamped historical bars + a
 * last-trade observation); the TWS adapter that implements it against the
 * real API is ops wiring, and no behaviour beyond that slice is assumed here.
 */
import type { RawCandle } from '../ingestion.js';
import { type TradingCalendar, UsEquityRegularHoursCalendar } from '../trading-calendar.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';

/** An IBKR historical bar, timestamped at the bar's open. */
export interface IbkrHistoricalBar {
  /** RFC-3339 open timestamp. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** IBKR's last-trade observation. */
export interface IbkrLastTrade {
  price: number;
  /** RFC-3339 trade timestamp. */
  time: string;
}

export interface IbkrClient {
  getHistoricalBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
  ): Promise<IbkrHistoricalBar[]>;
  getLastTrade(symbol: string): Promise<IbkrLastTrade>;
}

export interface IbkrSourceOptions {
  /**
   * Session calendar. Defaults to regular US equity hours; the real
   * holiday/session table injects here (see trading-calendar.ts).
   */
  calendar?: TradingCalendar | undefined;
  /** Bar granularity backtest marks derive from. */
  markTimeframe?: string | undefined;
}

export class IbkrDataSource extends NormalizingDataSource {
  readonly #client: IbkrClient;
  readonly #markTimeframe: string;

  constructor(client: IbkrClient, options: IbkrSourceOptions = {}) {
    super({
      source: 'ibkr',
      asset_class: 'stocks',
      calendar: options.calendar ?? new UsEquityRegularHoursCalendar(),
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
  ): Promise<RawCandle[]> {
    const bars = await this.#client.getHistoricalBars(instrument, timeframe, asOf, limit);

    return bars.map((bar) => ({
      open_time: new Date(bar.time),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }

  /**
   * The last trade, observed at the trade's own time. Outside market hours
   * this is legitimately stale rather than an error (spec: a stock mark is
   * legitimately old when the market is closed).
   */
  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    const trade = await this.#client.getLastTrade(instrument);

    return { price: trade.price, observed_at: new Date(trade.time) };
  }
}
