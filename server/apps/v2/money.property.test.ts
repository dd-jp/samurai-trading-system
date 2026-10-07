import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MarketData, Venue } from '../../../contracts/index.js';
import { saxoCustodyAccrual, wholeShares } from '../../shared/index.js';
import { addDays, quoteCurrencyOf, quotePerGbp } from './data/index.js';
import { nativeAmountFor } from './replay-broker.js';

const VENUES: readonly Venue[] = ['alpaca', 'saxo', 'saxo_cfd_gbp', 'saxo_cfd_usd'];
const positive = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

describe('GBP money math', () => {
  // Floor of a binary quotient: £99,993,896.38 at £0.07 is exactly 1,428,484,234 shares but buys one
  // fewer. Short by at most one share is the safe side; overspending the cash is never allowed
  it('wholeShares never spends more than the cash and is at most one share short, and none on a bad price or no cash', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e10 }),
        fc.integer({ min: 1, max: 1e7 }),
        (cash, price) => {
          const shares = wholeShares(cash / 100, price / 100);
          expect(Number.isInteger(shares)).toBe(true);
          expect(shares * price).toBeLessThanOrEqual(cash);
          expect((shares + 2) * price).toBeGreaterThan(cash);
        },
      ),
    );
    fc.assert(
      fc.property(positive(-1e6, 1e6), positive(-1e6, 0), (cash, price) => {
        expect(wholeShares(cash, price)).toBe(0);
        expect(wholeShares(-Math.abs(cash), Math.abs(price) + 1)).toBe(0);
      }),
    );
  });

  it('converts at the year-start rate on every day of the year, whatever the daily rate does (FX excluded)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2026, max: 2040 }),
        fc.integer({ min: 0, max: 364 }),
        positive(0.8, 2),
        positive(0.5, 3),
        fc.constantFrom(...VENUES),
        (year, day, yearStart, onDay, venue) => {
          const market: MarketData = {
            lastBarBefore: () => undefined,
            barsBefore: () => [],
            gbpUsdAtYearStart: (asked) => (asked === year ? yearStart : Number.NaN),
            gbpUsdOnDay: () => ({ gbpUsd: onDay, fixDate: `${year}-01-01` }),
          };
          const date = addDays(`${year}-01-01`, day);
          expect(date.slice(0, 4)).toBe(String(year));
          expect(quotePerGbp(market, venue, date)).toBe(
            quoteCurrencyOf(venue) === 'USD' ? yearStart : 1,
          );
        },
      ),
    );
  });

  it('a journalled GBP fill price recovers a native price that books back to the same bits', () => {
    fc.assert(
      fc.property(positive(1e-4, 1e9), positive(0.5, 3), (native, rate) => {
        const gbp = native / rate;
        expect(nativeAmountFor(gbp, rate) / rate).toBe(gbp);
      }),
    );
  });

  it('Saxo custody is non-negative, linear in notional and additive across days', () => {
    fc.assert(
      fc.property(
        positive(0, 1e8),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        positive(0, 10),
        (notional, first, second, k) => {
          const accrued = saxoCustodyAccrual(notional, first);
          expect(accrued).toBeGreaterThanOrEqual(0);
          const tolerance = 1e-9 * (1 + notional);
          expect(
            Math.abs(
              saxoCustodyAccrual(notional, first + second) -
                accrued -
                saxoCustodyAccrual(notional, second),
            ),
          ).toBeLessThanOrEqual(tolerance);
          expect(
            Math.abs(saxoCustodyAccrual(notional * k, first) - accrued * k),
          ).toBeLessThanOrEqual(tolerance * (1 + k));
        },
      ),
    );
  });
});
