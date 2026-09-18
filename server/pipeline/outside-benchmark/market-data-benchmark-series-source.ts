import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { BenchmarkObservation } from './outside-benchmark.js';

export interface BenchmarkSeriesSource {
  getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ANCHOR_PAD_BARS = 5;

export class MarketDataBenchmarkSeriesSource implements BenchmarkSeriesSource {
  constructor(private readonly marketData: MarketDataService) {}

  async getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]> {
    const calendarDays = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
    const bars = await this.marketData.getBars(
      instrument,
      {
        timeframe: '1d',
        lookback: Math.max(calendarDays, 1) + ANCHOR_PAD_BARS,
        partial: 'allow',
      },
      to,
    );

    return bars.map((bar) => ({ close_time: bar.close_time, close: bar.close }));
  }
}
