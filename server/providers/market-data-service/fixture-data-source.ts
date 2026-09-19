import { deriveBacktestMark } from './ingestion.js';
import type { Bar, BarWindow, DataSource, Mark, Quote } from './types.js';

export interface FixtureLiveMark {
  price: number;
  observed_at: Date;
  source: string;
}

export class FixtureDataSource implements DataSource {
  constructor(
    private readonly bars: Bar[],
    private readonly liveMark: FixtureLiveMark,
    private readonly assetClass: 'crypto' | 'stocks',
    private readonly quote?: Quote,
  ) {}

  async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
    return this.bars
      .filter((bar) => bar.instrument === instrument && bar.timeframe === window.timeframe)
      .filter((bar) => bar.close_time.getTime() <= asOf.getTime())
      .sort((a, b) => a.close_time.getTime() - b.close_time.getTime())
      .slice(-window.lookback);
  }

  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    if (mode === 'live') {
      return {
        price: this.liveMark.price,
        observed_at: this.liveMark.observed_at,
        source: this.liveMark.source,
        asset_class: this.assetClass,
      };
    }

    const instrumentBars = this.bars.filter((bar) => bar.instrument === instrument);
    return deriveBacktestMark(instrumentBars, instrument, asOf, this.assetClass);
  }

  async fetchQuote(_instrument: string, _asOf: Date): Promise<Quote | null> {
    return this.quote ?? null;
  }
}
