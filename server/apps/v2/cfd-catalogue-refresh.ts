import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  openSaxoLiveSession,
  type SaxoCfdAssetType,
  type SaxoReadOnlyApi,
} from '../../providers/saxo-bars/index.js';
import type { Logger } from '../../shared/index.js';
import { isFiniteNumber } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import {
  type BarRefresh,
  logRefresh,
  messageOf,
  stoppedAtCap,
  type TimeLimit,
  UNLIMITED,
  withinTimeLimit,
} from './bar-refresh-core.js';
import {
  type CfdInstrument,
  parseCfdCatalogue,
  type QuoteCurrency,
  recordCfdCatalogueSnapshot,
  ukStockKey,
  ukStockScreenCounts,
} from './data/index.js';
import {
  connectUnlessLost,
  ledgerFor,
  noteSessionLoss,
  type SaxoSessionLedger,
} from './saxo-session-loss.js';
import { LSE_LINES, requireSet, UK_STOCK_SCREENS } from './signal/index.js';

export type CfdReferenceApi = Pick<
  SaxoReadOnlyApi,
  'cfdInstrumentPage' | 'cfdInstrumentDetails' | 'cfdInfoPrices'
>;

const SEARCH_PAGE_SIZE = 1000;
const MAX_SEARCH_PAGES = 20;
const UIC_BATCH = 100;

export interface CfdScope {
  readonly assetType: SaxoCfdAssetType;
  readonly exchangeIds: readonly string[];
  readonly currency: QuoteCurrency;
  readonly universe: readonly string[] | 'whole_exchange';
  readonly keyOf: (saxoSymbol: string) => string;
}

export function cfdScopes(
  usConstituents: readonly string[],
  lseTidms: readonly string[] = LSE_LINES.map((line) => line.tidm),
): readonly CfdScope[] {
  return [
    {
      assetType: 'CfdOnStock',
      exchangeIds: ['NYSE', 'NASDAQ'],
      currency: 'USD',
      universe: usConstituents,
      keyOf: universeSymbolOf,
    },
    {
      assetType: 'CfdOnEtf',
      exchangeIds: ['LSE_ETF'],
      currency: 'GBP',
      universe: lseTidms,
      keyOf: universeSymbolOf,
    },
    {
      assetType: 'CfdOnStock',
      exchangeIds: ['LSE_SETS'],
      currency: 'GBP',
      universe: 'whole_exchange',
      keyOf: ukStockKey,
    },
  ];
}

interface Listing {
  readonly symbol: string;
  readonly saxoSymbol: string;
  readonly uic: number;
}

interface Details {
  readonly tradable: boolean;
  readonly shortTradeDisabled: boolean | undefined;
  readonly priceToContractFactor: number | undefined;
  readonly currency: string;
  readonly priceCurrency: string | undefined;
}

interface PriceDetails {
  readonly shortTradeDisabled: boolean | undefined;
  readonly borrowCostPerDay: number | null;
  readonly bid: number | undefined;
  readonly ask: number | undefined;
  readonly averageVolume30Days: number | undefined;
}

export interface CfdCatalogueRefreshReport {
  readonly asOf: string;
  readonly instruments: readonly CfdInstrument[];
  readonly unmatched: readonly string[];
  readonly clashes: readonly string[];
  readonly withoutDetails: readonly string[];
  readonly otherCurrency: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function dataOf(body: unknown, endpoint: string): readonly Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.Data)) {
    throw new Error(`Saxo ${endpoint}: Data missing`);
  }
  return body.Data.filter(isRecord);
}

// Saxo writes a share class as a lowercase suffix (BRKb:xnys); the universe writes BRK.B
export function universeSymbolOf(saxoSymbol: string): string {
  const root = saxoSymbol.split(':')[0] ?? '';
  const shareClass = /^([A-Z0-9]+)([a-z])$/.exec(root);
  return shareClass === null ? root : `${shareClass[1]}.${shareClass[2]?.toUpperCase()}`;
}

function wanted(scope: CfdScope): (symbol: string) => boolean {
  if (scope.universe === 'whole_exchange') return () => true;
  const names = new Set(scope.universe);
  return (symbol) => names.has(symbol);
}

function pricedElsewhere(row: Record<string, unknown>, scope: CfdScope): boolean {
  return (
    scope.universe === 'whole_exchange' &&
    scope.exchangeIds.includes(String(row.ExchangeId)) &&
    row.CurrencyCode !== scope.currency
  );
}

function listingOf(
  row: Record<string, unknown>,
  scope: CfdScope,
  inUniverse: (symbol: string) => boolean,
): Listing | undefined {
  const saxoSymbol = String(row.Symbol ?? '');
  const symbol = scope.keyOf(saxoSymbol);
  const inScope =
    inUniverse(symbol) &&
    scope.exchangeIds.includes(String(row.ExchangeId)) &&
    row.CurrencyCode === scope.currency &&
    isFiniteNumber(row.Identifier);
  return inScope ? { symbol, saxoSymbol, uic: row.Identifier as number } : undefined;
}

async function searchExchange(
  api: CfdReferenceApi,
  scope: CfdScope,
  exchangeId: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const body = await api.cfdInstrumentPage(
      scope.assetType,
      exchangeId,
      page * SEARCH_PAGE_SIZE,
      SEARCH_PAGE_SIZE,
    );
    const data = dataOf(body, 'instruments');
    rows.push(...data);
    if (data.length < SEARCH_PAGE_SIZE) return rows;
  }
  throw new Error(
    `Saxo instruments: ${exchangeId} ${scope.assetType} exceeds ${MAX_SEARCH_PAGES} pages`,
  );
}

interface ScopeListings {
  readonly listings: Listing[];
  readonly otherCurrency: string[];
}

async function listScope(api: CfdReferenceApi, scope: CfdScope): Promise<ScopeListings> {
  const inUniverse = wanted(scope);
  const found: ScopeListings = { listings: [], otherCurrency: [] };
  for (const exchangeId of scope.exchangeIds) {
    for (const row of await searchExchange(api, scope, exchangeId)) {
      const listing = listingOf(row, scope, inUniverse);
      if (listing !== undefined) found.listings.push(listing);
      else if (pricedElsewhere(row, scope)) found.otherCurrency.push(String(row.Symbol ?? ''));
    }
  }
  return found;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function positiveOrUndefined(value: unknown): number | undefined {
  return isFiniteNumber(value) && value > 0 ? value : undefined;
}

function detailsOf(row: Record<string, unknown>): Details {
  return {
    tradable: row.IsTradable === true,
    shortTradeDisabled: optionalBoolean(row.ShortTradeDisabled),
    priceToContractFactor: positiveOrUndefined(row.PriceToContractFactor),
    currency: String(row.CurrencyCode ?? ''),
    priceCurrency: typeof row.PriceCurrency === 'string' ? row.PriceCurrency : undefined,
  };
}

function nonNegativeOrUndefined(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? value : undefined;
}

function priceDetailsOf(row: Record<string, unknown>): PriceDetails {
  const details = isRecord(row.InstrumentPriceDetails) ? row.InstrumentPriceDetails : {};
  const quote = isRecord(row.Quote) ? row.Quote : {};
  return {
    shortTradeDisabled: optionalBoolean(details.ShortTradeDisabled),
    borrowCostPerDay: nonNegativeOrUndefined(details.CfdBorrowingCost) ?? null,
    bid: positiveOrUndefined(quote.Bid),
    ask: positiveOrUndefined(quote.Ask),
    averageVolume30Days: nonNegativeOrUndefined(details.AverageVolume30Days),
  };
}

function batches(uics: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let start = 0; start < uics.length; start += UIC_BATCH) {
    out.push(uics.slice(start, start + UIC_BATCH));
  }
  return out;
}

async function byUic<T>(
  uics: readonly number[],
  fetchBatch: (batch: readonly number[]) => Promise<unknown>,
  endpoint: string,
  parse: (row: Record<string, unknown>) => T,
): Promise<Map<number, T>> {
  const found = new Map<number, T>();
  for (const batch of batches(uics)) {
    for (const row of dataOf(await fetchBatch(batch), endpoint)) {
      if (isFiniteNumber(row.Uic)) found.set(row.Uic, parse(row));
    }
  }
  return found;
}

// Fail closed: a short is allowed only when a source says ShortTradeDisabled is false and
// none says true, so a field Saxo stops sending blocks shorts instead of opening them
function shortTradeDisabled(details: Details, price: PriceDetails | undefined): boolean {
  const flags = [details.shortTradeDisabled, price?.shortTradeDisabled];
  return flags.includes(true) || !flags.includes(false);
}

function usableFactor(details: Details, scope: CfdScope): number | undefined {
  return details.currency === scope.currency ? details.priceToContractFactor : undefined;
}

function instrumentOf(
  listing: Listing,
  scope: CfdScope,
  details: Details | undefined,
  price: PriceDetails | undefined,
): CfdInstrument | undefined {
  if (details === undefined) return undefined;
  const factor = usableFactor(details, scope);
  if (factor === undefined) return undefined;
  return {
    symbol: listing.symbol,
    saxoSymbol: listing.saxoSymbol,
    uic: listing.uic,
    assetType: scope.assetType,
    currency: scope.currency,
    priceToContractFactor: factor,
    tradable: details.tradable,
    shortTradeDisabled: shortTradeDisabled(details, price),
    borrowCostPerDay: price?.borrowCostPerDay ?? undefined,
    ...definedOnly({
      priceCurrency: details.priceCurrency,
      bid: price?.bid,
      ask: price?.ask,
      averageVolume30Days: price?.averageVolume30Days,
    }),
  };
}

function definedOnly<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

interface ScopeRows {
  readonly instruments: CfdInstrument[];
  readonly withoutDetails: string[];
  readonly otherCurrency: string[];
}

async function scopeRows(api: CfdReferenceApi, scope: CfdScope): Promise<ScopeRows> {
  const { listings, otherCurrency } = await listScope(api, scope);
  const uics = listings.map((listing) => listing.uic);
  const details = await byUic(
    uics,
    (batch) => api.cfdInstrumentDetails(batch, scope.assetType),
    'instruments/details',
    detailsOf,
  );
  const prices = await byUic(
    uics,
    (batch) => api.cfdInfoPrices(batch, scope.assetType),
    'infoprices/list',
    priceDetailsOf,
  );
  const rows: ScopeRows = { instruments: [], withoutDetails: [], otherCurrency };
  for (const listing of listings) {
    const row = instrumentOf(listing, scope, details.get(listing.uic), prices.get(listing.uic));
    if (row === undefined) rows.withoutDetails.push(listing.saxoSymbol);
    else rows.instruments.push(row);
  }
  return rows;
}

function withoutClashes(instruments: readonly CfdInstrument[]): {
  kept: CfdInstrument[];
  clashes: string[];
} {
  const counts = new Map<string, number>();
  for (const { symbol } of instruments) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  const clashes = [...counts].filter(([, count]) => count > 1).map(([symbol]) => symbol);
  const clashing = new Set(clashes);
  return { kept: instruments.filter(({ symbol }) => !clashing.has(symbol)), clashes };
}

export async function buildCfdCatalogue(
  api: CfdReferenceApi,
  scopes: readonly CfdScope[],
  asOf: string,
): Promise<CfdCatalogueRefreshReport> {
  const instruments: CfdInstrument[] = [];
  const withoutDetails: string[] = [];
  const otherCurrency: string[] = [];
  for (const scope of scopes) {
    const rows = await scopeRows(api, scope);
    instruments.push(...rows.instruments);
    withoutDetails.push(...rows.withoutDetails);
    otherCurrency.push(...rows.otherCurrency);
  }
  const { kept, clashes } = withoutClashes(instruments);
  const listed = new Set(instruments.map(({ symbol }) => symbol));
  const unmatched = scopes.flatMap(({ universe }) =>
    universe === 'whole_exchange' ? [] : universe.filter((s) => !listed.has(s)),
  );
  return { asOf, instruments: kept, unmatched, clashes, withoutDetails, otherCurrency };
}

export function catalogueText(report: CfdCatalogueRefreshReport): string {
  const instruments = report.instruments.map((instrument) => ({
    ...instrument,
    borrowCostPerDay: instrument.borrowCostPerDay ?? null,
  }));
  const text = `${JSON.stringify({ asOf: report.asOf, instruments }, null, 2)}\n`;
  if (instruments.length === 0) throw new Error('CFD catalogue: no instruments, refusing to write');
  parseCfdCatalogue(text);
  return text;
}

export function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.tmp`;
  const fd = openSync(staging, 'w');
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
}

function logReport(report: CfdCatalogueRefreshReport, path: string, logger: Logger): void {
  if (report.clashes.length > 0) {
    logRefresh(
      logger,
      'warn',
      'v2_cfd_catalogue_symbol_clash',
      `dropped ${report.clashes.join(', ')}: more than one CFD row keys to the same symbol`,
    );
  }
  if (report.otherCurrency.length > 0) {
    logRefresh(
      logger,
      'info',
      'v2_cfd_catalogue_other_currency',
      `excluded ${report.otherCurrency.join(', ')}: not priced in the scope's currency (#1914)`,
    );
  }
  const ukScreen = ukStockScreenCounts(report.instruments, requireSet(UK_STOCK_SCREENS));
  if (Object.values(ukScreen).some((count) => count > 0)) {
    logRefresh(
      logger,
      'info',
      'v2_cfd_catalogue_uk_screen',
      `UK stock CFDs by screen outcome: ${JSON.stringify(ukScreen)}`,
    );
  }
  logRefresh(
    logger,
    'info',
    'v2_cfd_catalogue_written',
    `${report.instruments.length} CFD rows as of ${report.asOf} to ${path}; ` +
      `${report.unmatched.length} universe names without a row, ` +
      `${report.withoutDetails.length} listings without usable details`,
  );
}

export interface CfdCatalogueTarget {
  readonly path: string;
  readonly storePath: string;
  readonly now?: () => Date;
}

function recordSnapshot(target: CfdCatalogueTarget, text: string): void {
  const db = openSharedStore(target.storePath);
  try {
    recordCfdCatalogueSnapshot(db, Buffer.from(text), target.now?.() ?? new Date());
  } finally {
    db.close();
  }
}

export async function refreshCfdCatalogue(
  api: CfdReferenceApi,
  scopes: readonly CfdScope[],
  asOf: string,
  target: CfdCatalogueTarget,
  logger: Logger,
  limit: TimeLimit = UNLIMITED,
): Promise<CfdCatalogueRefreshReport> {
  const report = await buildCfdCatalogue(api, scopes, asOf);
  const text = catalogueText(report);
  // Recorded first (#2105, #2118): a file the cycle reads is always a snapshot the backtest can date
  await limit.atomic(async () => {
    recordSnapshot(target, text);
    writeAtomically(target.path, text);
  });
  logReport(report, target.path, logger);
  return report;
}

export interface CfdSession {
  readonly api: CfdReferenceApi;
  readonly stop: () => Promise<void>;
  readonly lostReason?: () => string | undefined;
}

export type CfdSessionConnect = (
  env: NodeJS.ProcessEnv,
  logger: Logger,
  signal: AbortSignal,
) => CfdSession;

export interface CfdCatalogueLeg extends CfdCatalogueTarget {
  readonly tradingDate: string;
  readonly constituents: readonly string[];
  readonly logger: Logger;
  readonly connect?: CfdSessionConnect;
  readonly tokenPath?: string;
  readonly timeLimitMs?: number;
}

async function refreshInSession(
  session: CfdSession,
  leg: CfdCatalogueLeg,
  ledger: SaxoSessionLedger,
  limit: TimeLimit,
): Promise<void> {
  try {
    const scopes = cfdScopes(leg.constituents);
    await refreshCfdCatalogue(session.api, scopes, leg.tradingDate, leg, leg.logger, limit);
  } finally {
    noteSessionLoss(session.lostReason?.(), ledger);
    await session.stop();
  }
}

// Bounds the leg's wall time, not its worst case: one request alone can take 4 x 60 s timeouts
// plus 3 x 65 s backoffs (435 s), so a pull that is retrying hard is cut and the last file stands
const CFD_CATALOGUE_TIME_LIMIT_MS = 5 * 60_000;

function timedOut(limitMs: number, logger: Logger): void {
  logRefresh(
    logger,
    'warn',
    'v2_cfd_catalogue_refresh_timed_out',
    `CFD catalogue cut at the ${limitMs / 1000} s cap; every CFD route reads the last written file`,
  );
}

// The catalogue is not bars, so the leg adds nothing to the bar report; a failure keeps the
// previous file, which the router stops trusting after CFD_CATALOGUE_MAX_AGE_CALENDAR_DAYS
export function cfdCatalogueRefreshFor(env: NodeJS.ProcessEnv, leg: CfdCatalogueLeg): BarRefresh {
  const connect: CfdSessionConnect =
    leg.connect ??
    ((liveEnv, logger, signal) => openSaxoLiveSession(liveEnv, leg.tokenPath, logger, signal));
  const ledger = ledgerFor(leg, leg.logger);
  const limitMs = leg.timeLimitMs ?? CFD_CATALOGUE_TIME_LIMIT_MS;
  const work = async (limit: TimeLimit) => {
    const session = connectUnlessLost(() => connect(env, leg.logger, limit.signal), ledger);
    await refreshInSession(stoppedAtCap(session, limit), leg, ledger, limit);
  };
  return {
    run: async () => {
      try {
        await withinTimeLimit(limitMs, work, () => timedOut(limitMs, leg.logger));
      } catch (error) {
        logRefresh(
          leg.logger,
          'warn',
          'v2_cfd_catalogue_refresh_failed',
          `CFD catalogue not refreshed (${messageOf(error)}); every CFD route reads the last written file`,
        );
      }
      return { attempted: 0, updated: [], noNewBars: [], failed: [] };
    },
  };
}
