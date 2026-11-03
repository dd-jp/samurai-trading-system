import type { GbpUsdFix, MarketData, V2Bar, Venue } from '../../../../contracts/index.js';
import { describeThrownSafely, readSeededFile } from '../../../shared/index.js';
import { type BarsSource, barsBefore } from './bars.js';
import {
  type BoeFix,
  FX_EUR_PATH,
  FX_SOURCE_GBP,
  type FxObservation,
  latestGbpUsd,
  parseBoeGbpEurCsv,
  staleYearStartReason,
  yearStartFix,
  yearStartFxSource,
  yearStartGbpEur,
} from './fx.js';
import { type ConvertibleCurrency, type QuoteCurrency, quoteCurrencyOf } from './venues.js';

function noGbpEurSeries(): readonly BoeFix[] {
  throw new Error('fx: no BoE XUDLERS series is loaded');
}

export function gbpEurFromFile(path: string = FX_EUR_PATH): () => readonly BoeFix[] {
  return () => parseBoeGbpEurCsv(readSeededFile(path));
}

export class BarsMarketData implements MarketData {
  readonly #yearStart = new Map<number, FxObservation>();
  #gbpEur: readonly BoeFix[] | undefined;

  constructor(
    private readonly bars: BarsSource,
    private readonly fx: readonly FxObservation[],
    private readonly loadGbpEur: () => readonly BoeFix[] = noGbpEurSeries,
  ) {}

  gbpEurAtYearStart(year: number): number {
    this.#gbpEur ??= this.loadGbpEur();
    return yearStartGbpEur(this.#gbpEur, year);
  }

  lastBarBefore(instrument: string, tradingDate: string): V2Bar | undefined {
    const series = this.bars.load(instrument);
    return series === undefined ? undefined : barsBefore(series, tradingDate).at(-1);
  }

  barsBefore(instrument: string, tradingDate: string, count: number): readonly V2Bar[] {
    this.bars.noteWindow?.(instrument, count);
    const series = this.bars.load(instrument);
    return series === undefined || count < 1 ? [] : barsBefore(series, tradingDate).slice(-count);
  }

  gbpUsdAtYearStart(year: number): number {
    return this.#yearStartFix(year).gbpUsd;
  }

  gbpUsdYearStartFixDate(year: number): string {
    return this.#yearStartFix(year).date;
  }

  gbpUsdOnDay(date: string): GbpUsdFix {
    const fix = latestGbpUsd(this.fx, date);
    if (!fix.ok) throw new Error(fix.reason);
    return { gbpUsd: fix.gbpUsd, fixDate: fix.fixDate };
  }

  #yearStartFix(year: number): FxObservation {
    const cached = this.#yearStart.get(year);
    if (cached !== undefined) return cached;
    const fix = yearStartFix(this.fx, year);
    this.#yearStart.set(year, fix);
    return fix;
  }
}

export interface FillFx {
  readonly currency: QuoteCurrency;
  readonly quotePerGbp: number;
  readonly source: string;
}

export function fillFxOf(
  market: Pick<MarketData, 'gbpUsdAtYearStart' | 'gbpUsdYearStartFixDate'>,
  venue: Venue,
  tradingDate: string,
): FillFx {
  const currency = quoteCurrencyOf(venue);
  const year = Number(tradingDate.slice(0, 4));
  return {
    currency,
    quotePerGbp: quotePerGbp(market, venue, tradingDate),
    source:
      currency === 'USD'
        ? yearStartFxSource(year, market.gbpUsdYearStartFixDate?.(year))
        : FX_SOURCE_GBP,
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

export function currencyQuotePerGbp(
  market: Pick<MarketData, 'gbpUsdAtYearStart' | 'gbpEurAtYearStart'>,
  currency: ConvertibleCurrency,
  tradingDate: string,
): number {
  const year = Number(tradingDate.slice(0, 4));
  switch (currency) {
    case 'GBP':
      return 1;
    case 'USD':
      return market.gbpUsdAtYearStart(year);
    case 'EUR':
      return gbpEurAtYearStartOf(market, year);
  }
}

export function gbpEurAtYearStartOf(
  market: Pick<MarketData, 'gbpEurAtYearStart'>,
  year: number,
): number {
  if (market.gbpEurAtYearStart === undefined) {
    throw new Error('fx: this market carries no BoE XUDLERS GBP/EUR rate');
  }
  return market.gbpEurAtYearStart(year);
}

export function quotePerGbp(
  market: Pick<MarketData, 'gbpUsdAtYearStart'>,
  venue: Venue,
  tradingDate: string,
): number {
  return currencyQuotePerGbp(market, quoteCurrencyOf(venue), tradingDate);
}

export function yearStartCoverageRefusal(
  market: Pick<MarketData, 'gbpUsdYearStartFixDate'>,
  tradingDate: string,
): string | undefined {
  const year = Number(tradingDate.slice(0, 4));
  try {
    const fixDate = market.gbpUsdYearStartFixDate?.(year);
    return fixDate === undefined ? undefined : staleYearStartReason(year, fixDate);
  } catch (error) {
    return describeThrownSafely(error);
  }
}
