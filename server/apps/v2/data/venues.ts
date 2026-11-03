import type { Venue } from '../../../../contracts/index.js';

export type QuoteCurrency = 'GBP' | 'USD';

const QUOTE_CURRENCY: Readonly<Record<Venue, QuoteCurrency>> = {
  alpaca: 'USD',
  saxo: 'GBP',
  saxo_cfd_gbp: 'GBP',
  saxo_cfd_usd: 'USD',
};

const CFD_VENUES: ReadonlySet<Venue> = new Set<Venue>(['saxo_cfd_gbp', 'saxo_cfd_usd']);

export type ConvertibleCurrency = QuoteCurrency | 'EUR';

const CONVERTIBLE_CURRENCIES: ReadonlySet<string> = new Set<ConvertibleCurrency>([
  'GBP',
  'USD',
  'EUR',
]);

export function isConvertibleCurrency(currency: string): currency is ConvertibleCurrency {
  return CONVERTIBLE_CURRENCIES.has(currency);
}

export function quoteCurrencyOf(venue: Venue): QuoteCurrency {
  return QUOTE_CURRENCY[venue];
}

export function isCfdVenue(venue: Venue): boolean {
  return CFD_VENUES.has(venue);
}

export function homeBarVenue(venue: Venue): 'alpaca' | 'saxo' {
  if (!isCfdVenue(venue)) return venue === 'alpaca' ? 'alpaca' : 'saxo';
  return quoteCurrencyOf(venue) === 'USD' ? 'alpaca' : 'saxo';
}
