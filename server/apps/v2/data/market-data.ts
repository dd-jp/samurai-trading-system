import type { MarketData, V2Bar, Venue } from '../../../../contracts/index.js';
import { type BarsSource, barsBefore } from './bars.js';
import { FX_SOURCE_GBP, type FxObservation, yearStartFxSource, yearStartGbpUsd } from './fx.js';
import { type QuoteCurrency, quoteCurrencyOf } from './venues.js';

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

  barsBefore(instrument: string, tradingDate: string, count: number): readonly V2Bar[] {
    const series = this.bars.load(instrument);
    return series === undefined || count < 1 ? [] : barsBefore(series, tradingDate).slice(-count);
  }

  gbpUsdAtYearStart(year: number): number {
    const cached = this.#yearStart.get(year);
    if (cached !== undefined) return cached;
    const rate = yearStartGbpUsd(this.fx, year);
    this.#yearStart.set(year, rate);
    return rate;
  }
}

export interface FillFx {
  readonly currency: QuoteCurrency;
  readonly quotePerGbp: number;
  readonly source: string;
}

export function fillFxOf(
  market: Pick<MarketData, 'gbpUsdAtYearStart'>,
  venue: Venue,
  tradingDate: string,
): FillFx {
  const currency = quoteCurrencyOf(venue);
  return {
    currency,
    quotePerGbp: quotePerGbp(market, venue, tradingDate),
    source: currency === 'USD' ? yearStartFxSource(Number(tradingDate.slice(0, 4))) : FX_SOURCE_GBP,
  };
}

const LONDON_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function londonDateOf(isoTimestamp: string): string {
  return LONDON_DATE.format(new Date(isoTimestamp));
}

export function quotePerGbp(
  market: Pick<MarketData, 'gbpUsdAtYearStart'>,
  venue: Venue,
  tradingDate: string,
): number {
  return quoteCurrencyOf(venue) === 'USD'
    ? market.gbpUsdAtYearStart(Number(tradingDate.slice(0, 4)))
    : 1;
}
