import type { RawCandle } from '../ingestion.js';
import type { TradingCalendar } from '../trading-calendar.js';
import type { BarWindow } from '../types.js';
import { type LiveObservation, NormalizingDataSource } from './normalizing-data-source.js';
import type { BarFetcher } from './ohlcv-failover.js';

export interface SessionNormalizationConfig {
  fetch: BarFetcher;
  source: string;
  asset_class: 'crypto' | 'stocks';
  calendar: TradingCalendar;
}

class SessionNormalizedFetcherSource extends NormalizingDataSource {
  readonly #fetch: BarFetcher;

  constructor(config: SessionNormalizationConfig) {
    super({
      source: config.source,
      asset_class: config.asset_class,
      calendar: config.calendar,
      rawWidenPolicy: 'single-widest-retry',
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

  protected override async fetchLiveObservation(instrument: string): Promise<LiveObservation> {
    throw new Error(
      `Session-normalized fallback fetcher for ${instrument} serves BARS ONLY — it has no live ` +
        'observation. Marks and quotes stay on the primary (failover-data-source.ts).',
    );
  }

  protected override get markTimeframe(): string {
    throw new Error(
      'Session-normalized fallback fetcher serves BARS ONLY — no backtest mark is derived from it.',
    );
  }
}

export function withSessionNormalization(config: SessionNormalizationConfig): BarFetcher {
  const source = new SessionNormalizedFetcherSource(config);
  return (symbol, window, asOf) => source.fetchBars(symbol, window, asOf);
}
