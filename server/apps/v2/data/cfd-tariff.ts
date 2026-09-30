import type {
  CfdBorrowModel,
  CfdCostModel,
  CfdFinancingModel,
  CfdSpreadModel,
  Venue,
} from '../../../../contracts/index.js';
import { CFD_DAY_COUNT } from './cfd-catalogue.js';
import { type QuoteCurrency, quoteCurrencyOf } from './venues.js';

interface CommissionTerms {
  readonly perShare: number;
  readonly notionalRate: number;
  readonly minimum: number;
}

// Measured live on Saxo infoprices Commissions.CostBuy/CostSell: USD CfdOnStock on 2026-09-30
// (1 and 100 shares $10, 1,000 $20, 10,000 $200, #1916); GBP CfdOnStock on 2026-09-29 (#1866)
// and CfdOnEtf ISF on 2026-09-30 (#1916). David accepted the £8 minimum as modelled cost (#1850)
const COMMISSION: Readonly<Record<QuoteCurrency, CommissionTerms>> = {
  USD: { perShare: 0.02, notionalRate: 0, minimum: 10 },
  GBP: { perShare: 0, notionalRate: 0.001, minimum: 8 },
};

// The p90 of each measured sample, nearest rank, used as the half spread. USD: closing
// spreads on 12 large caps, 2026-09-30 (#1850). GBP: 251 UK single-stock CFDs above the 750k
// floor (#1866); the paper UK CFD route is ISF, so that sample is conservative for it
const HALF_SPREAD_BPS: Readonly<Record<QuoteCurrency, number>> = { USD: 4.48, GBP: 30.6 };

// Saxo infoprices PaidCfdInterest, 2026-09-30: US CfdOnStock 7.2%, ISF 7.04%. Saxo's
// financing page (home.saxo/en-gb/rates-and-conditions/cfds/financing, read 2026-09-30) charges
// longs at offer + markup and credits shorts at bid - markdown; the short credit
// (ReceivedCfdInterest 0.75% / 0.58%) is not modelled, so a short pays no financing
const LONG_FINANCING_PER_YEAR: Readonly<Record<QuoteCurrency, number>> = {
  USD: 0.072,
  GBP: 0.0704,
};

function perDay(ratePerYear: number, venue: Venue): number {
  return ratePerYear / CFD_DAY_COUNT[quoteCurrencyOf(venue)];
}

export const SAXO_CFD_COMMISSION: CfdCostModel = {
  fee(venue, _side, qty, priceQuote) {
    const terms = COMMISSION[quoteCurrencyOf(venue)];
    return Math.max(terms.minimum, qty * terms.perShare + qty * priceQuote * terms.notionalRate);
  },
};

export const SAXO_CFD_SPREAD: CfdSpreadModel = {
  halfSpreadBps: (venue) => HALF_SPREAD_BPS[quoteCurrencyOf(venue)],
};

export const SAXO_CFD_FINANCING: CfdFinancingModel = {
  dailyRate: (venue, side) =>
    side === 'long' ? perDay(LONG_FINANCING_PER_YEAR[quoteCurrencyOf(venue)], venue) : 0,
};

// A held short whose catalogue row has no borrow quote accrues at the entry ceiling, the most
// the router could have admitted it at
export function saxoCfdBorrow(fallbackRatePerYear: number): CfdBorrowModel {
  return {
    dailyRate: (venue, quotedPerDay) => quotedPerDay ?? perDay(fallbackRatePerYear, venue),
  };
}
