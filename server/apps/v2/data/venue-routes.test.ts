import { describe, expect, it } from 'vitest';
import type { Venue } from '../../../../contracts/index.js';
import { CfdCatalogue, type CfdInstrument } from './cfd-catalogue.js';
import { CLOSED_VENUE_ROUTER, createVenueRouter, type VenueRouterDeps } from './venue-routes.js';

const TODAY = '2026-09-29';
const MAX_BORROW = 0.02;

function instrument(over: Partial<CfdInstrument> & { symbol: string }): CfdInstrument {
  return {
    saxoSymbol: over.symbol,
    uic: 1,
    assetType: 'CfdOnStock',
    currency: 'USD',
    priceToContractFactor: 1,
    tradable: true,
    shortTradeDisabled: false,
    borrowCostPerDay: 0.0000137,
    ...over,
  };
}

function router(
  instruments: readonly CfdInstrument[],
  over: Partial<VenueRouterDeps> = {},
  asOf = TODAY,
) {
  return createVenueRouter({
    catalogue: new CfdCatalogue({ asOf, instruments }),
    entryRefusal: () => undefined,
    maxBorrowRatePerYear: MAX_BORROW,
    ...over,
  });
}

describe('VenueRouter route table', () => {
  const both = router([
    instrument({ symbol: 'AAPL' }),
    instrument({ symbol: 'ISF', currency: 'GBP', assetType: 'CfdOnEtf' }),
  ]);

  it('sends a US stock long to Alpaca and its short to the USD CFD', () => {
    expect(both.route('AAPL', 'alpaca', 'long', TODAY)).toEqual({ venue: 'alpaca' });
    expect(both.route('AAPL', 'alpaca', 'short', TODAY)).toEqual({ venue: 'saxo_cfd_usd' });
  });

  it('sends a UK ETF long to cash Saxo and its short to the GBP CFD', () => {
    expect(both.route('ISF', 'saxo', 'long', TODAY)).toEqual({ venue: 'saxo' });
    expect(both.route('ISF', 'saxo', 'short', TODAY)).toEqual({ venue: 'saxo_cfd_gbp' });
  });

  it('never consults the catalogue or cost model for a non-CFD long', () => {
    expect(CLOSED_VENUE_ROUTER.route('AAPL', 'alpaca', 'long', TODAY)).toEqual({ venue: 'alpaca' });
    expect(CLOSED_VENUE_ROUTER.route('ISF', 'saxo', 'long', TODAY)).toEqual({ venue: 'saxo' });
  });
});

describe('VenueRouter short refusals', () => {
  const short = (r: ReturnType<typeof router>, symbol = 'AAPL', home: Venue = 'alpaca') =>
    r.route(symbol, home, 'short', TODAY);

  it('fails closed on the closed router', () => {
    expect(short(CLOSED_VENUE_ROUTER)).toEqual({ refusal: 'cfd_cost_model_unset' });
  });

  it('refuses with the injected entry refusal before looking at anything else', () => {
    for (const refusal of ['cfd_spread_model_unset', 'cfd_resting_stop_unverified']) {
      const r = router([], { entryRefusal: () => refusal, catalogue: undefined });
      expect(short(r)).toEqual({ refusal });
    }
  });

  it('refuses with no catalogue loaded', () => {
    expect(short(router([], { catalogue: undefined }))).toEqual({ refusal: 'no_catalogue' });
  });

  it('accepts a snapshot three days old and refuses one four days old', () => {
    const instruments = [instrument({ symbol: 'AAPL' })];
    expect(short(router(instruments, {}, '2026-09-26'))).toEqual({ venue: 'saxo_cfd_usd' });
    expect(short(router(instruments, {}, '2026-09-25'))).toEqual({ refusal: 'no_catalogue' });
  });

  it('refuses a symbol the catalogue does not list', () => {
    expect(short(router([instrument({ symbol: 'MSFT' })]))).toEqual({
      refusal: 'not_in_catalogue',
    });
  });

  it('refuses an untradable instrument', () => {
    expect(short(router([instrument({ symbol: 'AAPL', tradable: false })]))).toEqual({
      refusal: 'not_tradable',
    });
  });

  it('refuses when the CFD quote currency is not the venue currency', () => {
    expect(short(router([instrument({ symbol: 'AAPL', currency: 'GBP' })]))).toEqual({
      refusal: 'currency_mismatch',
    });
  });

  it('refuses a ShortTradeDisabled instrument', () => {
    expect(short(router([instrument({ symbol: 'AAPL', shortTradeDisabled: true })]))).toEqual({
      refusal: 'ShortTradeDisabled',
    });
  });

  it('refuses an unknown borrow cost', () => {
    expect(short(router([instrument({ symbol: 'AAPL', borrowCostPerDay: undefined })]))).toEqual({
      refusal: 'borrow_cost_unknown',
    });
  });

  it('admits a borrow cost at exactly the 2% ceiling and refuses one just above', () => {
    const at = instrument({ symbol: 'AAPL', borrowCostPerDay: MAX_BORROW / 365 });
    const over = instrument({ symbol: 'AAPL', borrowCostPerDay: (MAX_BORROW + 0.0001) / 365 });
    expect(short(router([at]))).toEqual({ venue: 'saxo_cfd_usd' });
    expect(short(router([over]))).toEqual({ refusal: 'borrow_cost' });
  });

  it('admits a present zero borrow cost as free', () => {
    expect(short(router([instrument({ symbol: 'AAPL', borrowCostPerDay: 0 })]))).toEqual({
      venue: 'saxo_cfd_usd',
    });
  });

  it('refuses an index CFD row for a US stock and for a UK ETF', () => {
    const index = router([
      instrument({ symbol: 'AAPL', assetType: 'CfdOnIndex' }),
      instrument({ symbol: 'ISF', currency: 'GBP', assetType: 'CfdOnIndex' }),
    ]);
    expect(short(index)).toEqual({ refusal: 'asset_type_mismatch' });
    expect(short(index, 'ISF', 'saxo')).toEqual({ refusal: 'asset_type_mismatch' });
  });

  it('refuses a stock CFD row for a UK ETF and an ETF CFD row for a US stock', () => {
    const swapped = router([
      instrument({ symbol: 'AAPL', assetType: 'CfdOnEtf' }),
      instrument({ symbol: 'ISF', currency: 'GBP', assetType: 'CfdOnStock' }),
    ]);
    expect(short(swapped)).toEqual({ refusal: 'asset_type_mismatch' });
    expect(short(swapped, 'ISF', 'saxo')).toEqual({ refusal: 'asset_type_mismatch' });
  });

  it('names the earlier rule when several apply', () => {
    const r = router([
      instrument({
        symbol: 'AAPL',
        tradable: false,
        shortTradeDisabled: true,
        borrowCostPerDay: 1,
      }),
    ]);
    expect(short(r)).toEqual({ refusal: 'not_tradable' });
    const typed = router([
      instrument({ symbol: 'AAPL', assetType: 'CfdOnIndex', tradable: false }),
    ]);
    expect(short(typed)).toEqual({ refusal: 'asset_type_mismatch' });
  });
});
