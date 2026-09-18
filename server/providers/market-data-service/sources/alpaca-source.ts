import type { RawCandle } from '../ingestion.js';
import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../trading-calendar.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaQuote {
  t: string;
  ap: number;
  bp: number;
}

export interface AlpacaMarketDataClient {
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
  calendar?: TradingCalendar | undefined;
  markTimeframe?: string | undefined;
}

export class AlpacaDataSource extends NormalizingDataSource {
  readonly #client: AlpacaMarketDataClient;
  readonly #markTimeframe: string;

  constructor(client: AlpacaMarketDataClient, options: AlpacaSourceOptions) {
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

  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    const quote = await this.#client.getLatestQuote(instrument);

    return {
      price: (quote.ap + quote.bp) / 2,
      observed_at: new Date(quote.t),
    };
  }
}
