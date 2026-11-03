import { describe, expect, it } from 'vitest';
import type { Venue } from '../../../../contracts/index.js';
import { homeBarVenue, isCfdVenue, isConvertibleCurrency, quoteCurrencyOf } from './venues.js';

const CASES: readonly (readonly [Venue, 'GBP' | 'USD', boolean])[] = [
  ['alpaca', 'USD', false],
  ['saxo', 'GBP', false],
  ['saxo_cfd_gbp', 'GBP', true],
  ['saxo_cfd_usd', 'USD', true],
];

describe('venues', () => {
  it.each(CASES)('%s quotes %s and CFD is %s', (venue, currency, cfd) => {
    expect(quoteCurrencyOf(venue)).toBe(currency);
    expect(isCfdVenue(venue)).toBe(cfd);
  });
});

describe('homeBarVenue', () => {
  it.each([
    ['alpaca', 'alpaca'],
    ['saxo', 'saxo'],
    ['saxo_cfd_usd', 'alpaca'],
    ['saxo_cfd_gbp', 'saxo'],
  ] as const)('reads %s bars from the %s series', (venue, home) => {
    expect(homeBarVenue(venue)).toBe(home);
  });
});

describe('isConvertibleCurrency', () => {
  it('names the venue currencies and EUR, which a BoE year-start fix converts (#2170)', () => {
    expect(['GBP', 'USD', 'EUR', 'GBX', 'CHF', 'eur', ''].filter(isConvertibleCurrency)).toEqual([
      'GBP',
      'USD',
      'EUR',
    ]);
  });
});
