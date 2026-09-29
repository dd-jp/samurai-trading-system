import type { Venue } from '../../../../contracts/index.js';
import type { CfdAssetType, CfdCatalogue, CfdInstrument } from './cfd-catalogue.js';
import { borrowCostPerYear } from './cfd-catalogue.js';
import { isCfdVenue, quoteCurrencyOf } from './venues.js';

type RouteSide = 'long' | 'short';
type AssetKind = 'us_stock' | 'uk_etf';
export type RouteChoice = { readonly venue: Venue } | { readonly refusal: string };

const ROUTES: Readonly<Record<AssetKind, Readonly<Record<RouteSide, Venue>>>> = {
  us_stock: { long: 'alpaca', short: 'saxo_cfd_usd' },
  uk_etf: { long: 'saxo', short: 'saxo_cfd_gbp' },
};

const CFD_ASSET_TYPES: Readonly<Record<AssetKind, CfdAssetType>> = {
  us_stock: 'CfdOnStock',
  uk_etf: 'CfdOnEtf',
};

function assetKindFor(home: Venue): AssetKind {
  return home === 'alpaca' ? 'us_stock' : 'uk_etf';
}

export interface VenueRouterDeps {
  readonly catalogue: CfdCatalogue | undefined;
  readonly costModelSet: boolean;
  readonly maxBorrowRatePerYear: number;
}

export interface VenueRouter {
  route(symbol: string, home: Venue, side: RouteSide, tradingDate: string): RouteChoice;
}

function shortRefusal(instrument: CfdInstrument, maxBorrowRatePerYear: number): string | undefined {
  if (instrument.shortTradeDisabled) return 'ShortTradeDisabled';
  const borrow = borrowCostPerYear(instrument);
  if (borrow === undefined) return 'borrow_cost_unknown';
  return borrow > maxBorrowRatePerYear ? 'borrow_cost' : undefined;
}

function instrumentRefusal(
  instrument: CfdInstrument,
  venue: Venue,
  kind: AssetKind,
  maxBorrowRatePerYear: number,
): string | undefined {
  if (instrument.assetType !== CFD_ASSET_TYPES[kind]) return 'asset_type_mismatch';
  if (!instrument.tradable) return 'not_tradable';
  if (quoteCurrencyOf(venue) !== instrument.currency) return 'currency_mismatch';
  return shortRefusal(instrument, maxBorrowRatePerYear);
}

function cfdRefusal(
  deps: VenueRouterDeps,
  symbol: string,
  venue: Venue,
  kind: AssetKind,
  tradingDate: string,
): string | undefined {
  if (!deps.costModelSet) return 'cfd_cost_model_unset';
  const { catalogue } = deps;
  if (catalogue === undefined || !catalogue.freshOn(tradingDate)) return 'no_catalogue';
  const instrument = catalogue.lookup(symbol);
  if (instrument === undefined) return 'not_in_catalogue';
  return instrumentRefusal(instrument, venue, kind, deps.maxBorrowRatePerYear);
}

export function createVenueRouter(deps: VenueRouterDeps): VenueRouter {
  return {
    route(symbol, home, side, tradingDate) {
      const kind = assetKindFor(home);
      const venue = ROUTES[kind][side];
      if (!isCfdVenue(venue)) return { venue };
      const refusal = cfdRefusal(deps, symbol, venue, kind, tradingDate);
      return refusal === undefined ? { venue } : { refusal };
    },
  };
}

export const CLOSED_VENUE_ROUTER: VenueRouter = createVenueRouter({
  catalogue: undefined,
  costModelSet: false,
  maxBorrowRatePerYear: 0,
});
