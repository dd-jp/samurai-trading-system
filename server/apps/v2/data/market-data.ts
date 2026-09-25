import type { MarketData, V2Bar, Venue } from '../../../../contracts/index.js';
import { type BarsSource, barsBefore } from './bars.js';
import { type FxObservation, yearStartGbpUsd } from './fx.js';

export class BarsMarketData implements MarketData {
  readonly #yearStart = new Map<number, number>();

  constructor(
    private readonly bars: BarsSource,
    private readonly fx: readonly FxObservation[],
  ) {}

  lastBarBefore(instrument: string, tradingDate: string): V2Bar | undefined {
    const series = this.bars.load(instrument);
    return series === undefined ? undefined : barsBefore(series, tradingDate).at(-1);
  }

  gbpUsdAtYearStart(year: number): number {
    const cached = this.#yearStart.get(year);
    if (cached !== undefined) return cached;
    const rate = yearStartGbpUsd(this.fx, year);
    this.#yearStart.set(year, rate);
    return rate;
  }
}

export function quotePerGbp(market: MarketData, venue: Venue, tradingDate: string): number {
  return venue === 'alpaca' ? market.gbpUsdAtYearStart(Number(tradingDate.slice(0, 4))) : 1;
}
