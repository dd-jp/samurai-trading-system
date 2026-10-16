import { describe, expect, it } from 'vitest';
import type { Venue } from '../../../../contracts/index.js';
import { CfdCatalogue, type CfdInstrument } from './cfd-catalogue.js';
import { CfdCatalogueArchive } from './cfd-catalogue-archive.js';
import {
  CLOSED_VENUE_ROUTER,
  createAssumedBeforeArchiveRouter,
  createDatedVenueRouter,
  createVenueRouter,
  type VenueRouterDeps,
} from './venue-routes.js';

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
    expect(short(CLOSED_VENUE_ROUTER)).toEqual({ refusal: 'cfd_not_backtested' });
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

  describe.each([
    { currency: 'USD', days: 360, home: 'alpaca', venue: 'saxo_cfd_usd', assetType: 'CfdOnStock' },
    { currency: 'GBP', days: 365, home: 'saxo', venue: 'saxo_cfd_gbp', assetType: 'CfdOnEtf' },
  ] as const)('the 2% borrow ceiling on a $currency row ($days-day basis)', (row) => {
    const shortAt = (ratePerYear: number) =>
      router([
        instrument({
          symbol: 'X',
          currency: row.currency,
          assetType: row.assetType,
          borrowCostPerDay: ratePerYear / row.days,
        }),
      ]).route('X', row.home, 'short', TODAY);

    it('admits exactly 2.00% and 1.99%, and refuses 2.01%', () => {
      expect(shortAt(0.02)).toEqual({ venue: row.venue });
      expect(shortAt(0.0199)).toEqual({ venue: row.venue });
      expect(shortAt(0.0201)).toEqual({ refusal: 'borrow_cost' });
    });
  });

  it('admits the live 2% rows whose daily figure lands a float step off the ceiling', () => {
    const mdt = instrument({ symbol: 'MDT', borrowCostPerDay: 5.55555555555556e-5 });
    const isf = instrument({
      symbol: 'ISF',
      currency: 'GBP',
      assetType: 'CfdOnEtf',
      borrowCostPerDay: 5.47945205479452e-5,
    });
    expect(5.55555555555556e-5 * 360).toBeGreaterThan(MAX_BORROW);
    expect(5.47945205479452e-5 * 365).toBeLessThan(MAX_BORROW);
    expect(short(router([mdt]), 'MDT')).toEqual({ venue: 'saxo_cfd_usd' });
    expect(router([isf]).route('ISF', 'saxo', 'short', TODAY)).toEqual({ venue: 'saxo_cfd_gbp' });
  });

  it('admits a rate a float step above the ceiling but refuses one a billionth above it', () => {
    const at = (ratePerYear: number) =>
      short(router([instrument({ symbol: 'AAPL', borrowCostPerDay: ratePerYear / 360 })]));
    expect(at(MAX_BORROW + Number.EPSILON)).toEqual({ venue: 'saxo_cfd_usd' });
    expect(at(MAX_BORROW + 2e-9)).toEqual({ refusal: 'borrow_cost' });
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

describe('VenueRouter UK single stocks (#1914)', () => {
  const RR = instrument({
    symbol: 'RR_XLON',
    currency: 'GBP',
    priceToContractFactor: 0.01,
    shortTradeDisabled: true,
    borrowCostPerDay: undefined,
  });
  const open = router([RR], { ukStockRefusal: () => undefined });
  const venues: readonly Venue[] = ['alpaca', 'saxo', 'saxo_cfd_gbp', 'saxo_cfd_usd'];

  it('sends both sides to the GBP CFD whatever home venue it is given', () => {
    for (const home of venues) {
      expect(open.route('RR_XLON', home, 'long', TODAY)).toEqual({ venue: 'saxo_cfd_gbp' });
    }
    expect(open.route('RR_XLON', 'saxo', 'short', TODAY)).toEqual({
      refusal: 'ShortTradeDisabled',
    });
  });

  it('runs the short-only checks on shorts alone, so a long ignores the short flag and borrow', () => {
    const shortable = router([{ ...RR, shortTradeDisabled: false, borrowCostPerDay: 0 }], {
      ukStockRefusal: () => undefined,
    });
    expect(shortable.route('RR_XLON', 'saxo', 'short', TODAY)).toEqual({ venue: 'saxo_cfd_gbp' });
    expect(open.route('RR_XLON', 'saxo', 'long', TODAY)).toEqual({ venue: 'saxo_cfd_gbp' });
  });

  it('refuses every UK stock route while the switch is shut, and by default', () => {
    for (const side of ['long', 'short'] as const) {
      expect(router([RR]).route('RR_XLON', 'saxo', side, TODAY)).toEqual({
        refusal: 'uk_stock_cfd_disabled',
      });
      expect(
        router([RR], { ukStockRefusal: () => 'closed_here' }).route('RR_XLON', 'saxo', side, TODAY),
      ).toEqual({ refusal: 'closed_here' });
    }
  });

  it('checks the CFD entry gates first, then the switch, before the catalogue', () => {
    const gated = router([], { entryRefusal: () => 'cfd_cost_model_unset' });
    expect(gated.route('RR_XLON', 'saxo', 'long', TODAY)).toEqual({
      refusal: 'cfd_cost_model_unset',
    });
    expect(router([]).route('RR_XLON', 'saxo', 'long', TODAY)).toEqual({
      refusal: 'uk_stock_cfd_disabled',
    });
    expect(
      router([], { ukStockRefusal: () => undefined }).route('RR_XLON', 'saxo', 'long', TODAY),
    ).toEqual({ refusal: 'not_in_catalogue' });
  });

  it('never routes a UK stock to a USD venue, and never lets the switch touch other names', () => {
    const shut = router([RR, instrument({ symbol: 'AAPL' })]);
    expect(shut.route('AAPL', 'alpaca', 'short', TODAY)).toEqual({ venue: 'saxo_cfd_usd' });
    expect(
      router([{ ...RR, currency: 'USD' }], { ukStockRefusal: () => undefined }).route(
        'RR_XLON',
        'alpaca',
        'long',
        TODAY,
      ),
    ).toEqual({ refusal: 'currency_mismatch' });
  });

  it('refuses an ETF row for a UK stock', () => {
    const etf = router([{ ...RR, assetType: 'CfdOnEtf' }], { ukStockRefusal: () => undefined });
    expect(etf.route('RR_XLON', 'saxo', 'long', TODAY)).toEqual({
      refusal: 'asset_type_mismatch',
    });
  });
});

describe('createDatedVenueRouter (#2105)', () => {
  const FIRST = '2026-10-12';
  const SECOND = '2026-10-15';
  const first = new CfdCatalogue({ asOf: FIRST, instruments: [instrument({ symbol: 'AAPL' })] });
  const archive = new CfdCatalogueArchive([
    first,
    new CfdCatalogue({
      asOf: SECOND,
      instruments: [instrument({ symbol: 'AAPL', shortTradeDisabled: true })],
    }),
  ]);
  const dated = createDatedVenueRouter(archive, {
    entryRefusal: () => undefined,
    maxBorrowRatePerYear: MAX_BORROW,
  });
  const short = (tradingDate: string) => dated.route('AAPL', 'alpaca', 'short', tradingDate);

  it('refuses every CFD route the day before the first snapshot as not backtested', () => {
    expect(short('2026-10-11')).toEqual({ refusal: 'cfd_not_backtested' });
    expect(short('2016-01-04')).toEqual({ refusal: 'cfd_not_backtested' });
  });

  it('still routes a cash long before the first snapshot', () => {
    expect(dated.route('AAPL', 'alpaca', 'long', '2026-10-11')).toEqual({ venue: 'alpaca' });
  });

  it('routes by the first snapshot on its own day', () => {
    expect(short(FIRST)).toEqual({ venue: 'saxo_cfd_usd' });
  });

  it('reads the earlier snapshot between two, and the later one from its day', () => {
    expect(short('2026-10-14')).toEqual({ venue: 'saxo_cfd_usd' });
    expect(short(SECOND)).toEqual({ refusal: 'ShortTradeDisabled' });
  });

  it('ages the snapshot in force as paper does, so a gap in the archive reads no_catalogue', () => {
    const lone = createDatedVenueRouter(new CfdCatalogueArchive([first]), {
      entryRefusal: () => undefined,
      maxBorrowRatePerYear: MAX_BORROW,
    });
    expect(lone.route('AAPL', 'alpaca', 'short', '2026-10-15')).toEqual({ venue: 'saxo_cfd_usd' });
    expect(lone.route('AAPL', 'alpaca', 'short', '2026-10-16')).toEqual({
      refusal: 'no_catalogue',
    });
  });

  it('applies the CFD entry gates once a snapshot is in force', () => {
    const gated = createDatedVenueRouter(archive, {
      entryRefusal: () => 'cfd_borrow_model_unset',
      maxBorrowRatePerYear: MAX_BORROW,
    });
    expect(gated.route('AAPL', 'alpaca', 'short', FIRST)).toEqual({
      refusal: 'cfd_borrow_model_unset',
    });
  });
});

describe('createAssumedBeforeArchiveRouter (#2143 (c))', () => {
  const FIRST = '2026-10-13';
  const TODAYS = '2026-10-15';
  const PAST = '2022-03-01';
  const archive = new CfdCatalogueArchive([
    new CfdCatalogue({ asOf: FIRST, instruments: [instrument({ symbol: 'AAPL' })] }),
  ]);
  const today = new CfdCatalogue({
    asOf: TODAYS,
    instruments: [
      instrument({ symbol: 'AAPL', borrowCostPerDay: 0.1 / 360 }),
      instrument({ symbol: 'MSFT', shortTradeDisabled: true }),
      instrument({ symbol: 'NOQUOTE', borrowCostPerDay: undefined }),
      instrument({ symbol: 'RR_XLON', currency: 'GBP', borrowCostPerDay: 0.2 / 365 }),
    ],
  });
  const deps = { entryRefusal: () => undefined, maxBorrowRatePerYear: MAX_BORROW };
  const open = () => undefined;
  const assumed = createAssumedBeforeArchiveRouter(archive, today, {
    ...deps,
    ukStockRefusal: open,
  });

  it("routes a past CFD short by today's list where the dated router refuses it", () => {
    expect(createDatedVenueRouter(archive, deps).route('AAPL', 'alpaca', 'short', PAST)).toEqual({
      refusal: 'cfd_not_backtested',
    });
    expect(assumed.route('AAPL', 'alpaca', 'short', PAST)).toEqual({ venue: 'saxo_cfd_usd' });
    expect(assumed.route('RR_XLON', 'saxo', 'long', PAST)).toEqual({ venue: 'saxo_cfd_gbp' });
  });

  it("puts every past borrow at the ceiling, so today's quote neither refuses nor is missing", () => {
    expect(assumed.route('NOQUOTE', 'alpaca', 'short', PAST)).toEqual({ venue: 'saxo_cfd_usd' });
    expect(assumed.route('RR_XLON', 'saxo', 'short', PAST)).toEqual({ venue: 'saxo_cfd_gbp' });
  });

  it("keeps today's other checks: ShortTradeDisabled, a name missing from it and the gates", () => {
    expect(assumed.route('MSFT', 'alpaca', 'short', PAST)).toEqual({
      refusal: 'ShortTradeDisabled',
    });
    expect(assumed.route('TSLA', 'alpaca', 'short', PAST)).toEqual({
      refusal: 'not_in_catalogue',
    });
    const shut = createAssumedBeforeArchiveRouter(archive, today, deps);
    expect(shut.route('RR_XLON', 'saxo', 'long', PAST)).toEqual({
      refusal: 'uk_stock_cfd_disabled',
    });
    const gated = createAssumedBeforeArchiveRouter(archive, today, {
      ...deps,
      entryRefusal: () => 'cfd_cost_model_unset',
    });
    expect(gated.route('AAPL', 'alpaca', 'short', PAST)).toEqual({
      refusal: 'cfd_cost_model_unset',
    });
  });

  it('routes as the dated router from the first snapshot on', () => {
    const dated = createDatedVenueRouter(archive, { ...deps, ukStockRefusal: open });
    for (const date of [FIRST, '2026-10-16', '2026-10-17']) {
      for (const symbol of ['AAPL', 'MSFT', 'RR_XLON']) {
        expect(assumed.route(symbol, 'alpaca', 'short', date)).toEqual(
          dated.route(symbol, 'alpaca', 'short', date),
        );
      }
    }
    expect(assumed.route('AAPL', 'alpaca', 'short', '2026-10-17')).toEqual({
      refusal: 'no_catalogue',
    });
  });

  it('reads the right day when the same router is asked about several dates in turn', () => {
    expect(assumed.route('AAPL', 'alpaca', 'short', PAST)).toEqual({ venue: 'saxo_cfd_usd' });
    expect(assumed.route('AAPL', 'alpaca', 'short', '2026-10-12')).toEqual({
      venue: 'saxo_cfd_usd',
    });
    expect(assumed.route('AAPL', 'alpaca', 'short', PAST)).toEqual({ venue: 'saxo_cfd_usd' });
  });
});
