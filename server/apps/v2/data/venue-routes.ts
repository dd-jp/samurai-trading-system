import type { Venue } from '../../../../contracts/index.js';
import type { CfdAssetType, CfdCatalogue, CfdInstrument } from './cfd-catalogue.js';
import { borrowCostPerYear } from './cfd-catalogue.js';
import type { CfdCatalogueArchive } from './cfd-catalogue-archive.js';
import { isUkStock } from './uk-stocks.js';
import { isCfdVenue, quoteCurrencyOf } from './venues.js';

// A daily rate times its day count lands an ulp off the quoted annual rate (2%/365 x 365 is
// 0.019999999999999997), so the ceiling compares whole billionths, not raw floats
const RATE_UNITS_PER_ONE = 1e9;

function exceedsCeiling(ratePerYear: number, ceilingPerYear: number): boolean {
  return (
    Math.round(ratePerYear * RATE_UNITS_PER_ONE) > Math.round(ceilingPerYear * RATE_UNITS_PER_ONE)
  );
}

type RouteSide = 'long' | 'short';
type AssetKind = 'us_stock' | 'uk_etf' | 'uk_stock';
export type RouteChoice = { readonly venue: Venue } | { readonly refusal: string };

const ROUTES: Readonly<Record<AssetKind, Readonly<Record<RouteSide, Venue>>>> = {
  us_stock: { long: 'alpaca', short: 'saxo_cfd_usd' },
  uk_etf: { long: 'saxo', short: 'saxo_cfd_gbp' },
  uk_stock: { long: 'saxo_cfd_gbp', short: 'saxo_cfd_gbp' },
};

const CFD_ASSET_TYPES: Readonly<Record<AssetKind, CfdAssetType>> = {
  us_stock: 'CfdOnStock',
  uk_etf: 'CfdOnEtf',
  uk_stock: 'CfdOnStock',
};

// A UK single stock is told apart by its key, never its home venue: both it and a UK ETF are
// Saxo-homed, and only the ETF has a cash long (#1914)
function assetKindFor(symbol: string, home: Venue): AssetKind {
  if (isUkStock(symbol)) return 'uk_stock';
  return home === 'alpaca' ? 'us_stock' : 'uk_etf';
}

export interface VenueRouterDeps {
  readonly catalogue: CfdCatalogue | undefined;
  readonly entryRefusal: () => string | undefined;
  readonly maxBorrowRatePerYear: number;
  readonly ukStockRefusal?: (() => string | undefined) | undefined;
}

const UK_STOCK_CFD_CLOSED = (): string => 'uk_stock_cfd_disabled';

export interface VenueRouter {
  route(symbol: string, home: Venue, side: RouteSide, tradingDate: string): RouteChoice;
}

function shortRefusal(instrument: CfdInstrument, maxBorrowRatePerYear: number): string | undefined {
  if (instrument.shortTradeDisabled) return 'ShortTradeDisabled';
  const borrow = borrowCostPerYear(instrument);
  if (borrow === undefined) return 'borrow_cost_unknown';
  return exceedsCeiling(borrow, maxBorrowRatePerYear) ? 'borrow_cost' : undefined;
}

interface CfdRoute {
  readonly symbol: string;
  readonly venue: Venue;
  readonly kind: AssetKind;
  readonly side: RouteSide;
}

function instrumentRefusal(
  instrument: CfdInstrument,
  route: CfdRoute,
  maxBorrowRatePerYear: number,
): string | undefined {
  if (instrument.assetType !== CFD_ASSET_TYPES[route.kind]) return 'asset_type_mismatch';
  if (!instrument.tradable) return 'not_tradable';
  if (quoteCurrencyOf(route.venue) !== instrument.currency) return 'currency_mismatch';
  return route.side === 'short' ? shortRefusal(instrument, maxBorrowRatePerYear) : undefined;
}

function gateRefusal(deps: VenueRouterDeps, kind: AssetKind): string | undefined {
  const gated = deps.entryRefusal();
  if (gated !== undefined || kind !== 'uk_stock') return gated;
  return (deps.ukStockRefusal ?? UK_STOCK_CFD_CLOSED)();
}

function cfdRefusal(
  deps: VenueRouterDeps,
  route: CfdRoute,
  tradingDate: string,
): string | undefined {
  const gated = gateRefusal(deps, route.kind);
  if (gated !== undefined) return gated;
  const { catalogue } = deps;
  if (catalogue === undefined || !catalogue.freshOn(tradingDate)) return 'no_catalogue';
  const instrument = catalogue.lookup(route.symbol);
  if (instrument === undefined) return 'not_in_catalogue';
  return instrumentRefusal(instrument, route, deps.maxBorrowRatePerYear);
}

export function createVenueRouter(deps: VenueRouterDeps): VenueRouter {
  return {
    route(symbol, home, side, tradingDate) {
      const kind = assetKindFor(symbol, home);
      const venue = ROUTES[kind][side];
      if (!isCfdVenue(venue)) return { venue };
      const refusal = cfdRefusal(deps, { symbol, venue, kind, side }, tradingDate);
      return refusal === undefined ? { venue } : { refusal };
    },
  };
}

export const CLOSED_VENUE_ROUTER: VenueRouter = createVenueRouter({
  catalogue: undefined,
  entryRefusal: () => 'cfd_not_backtested',
  maxBorrowRatePerYear: 0,
});

// #2105 ruling 2026-10-11: Saxo publishes no catalogue history, so a date before the first
// archived snapshot is never inferred from a later one
export function createDatedVenueRouter(
  archive: Pick<CfdCatalogueArchive, 'inForceOn'>,
  deps: Omit<VenueRouterDeps, 'catalogue'>,
): VenueRouter {
  return {
    route(symbol, home, side, tradingDate) {
      const catalogue = archive.inForceOn(tradingDate);
      const router =
        catalogue === undefined ? CLOSED_VENUE_ROUTER : createVenueRouter({ ...deps, catalogue });
      return router.route(symbol, home, side, tradingDate);
    },
  };
}
