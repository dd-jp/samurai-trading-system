import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StaticSaxoTokenSource } from '../../pipeline/execution/index.js';
import type { FetchResult } from '../../providers/bar-store/index.js';
import { SaxoReadOnlyApi } from '../../providers/saxo-bars/index.js';
import type { Logger } from '../../shared/index.js';
import {
  buildCfdCatalogue,
  type CfdScope,
  catalogueText,
  cfdCatalogueRefreshFor,
  cfdScopes,
  refreshCfdCatalogue,
  universeSymbolOf,
  writeAtomically,
} from './cfd-catalogue-refresh.js';
import { createVenueRouter, loadCfdCatalogue } from './data/index.js';
import { LSE_LINES } from './signal/index.js';

const GATEWAY = 'https://gw.test/openapi';
const AS_OF = '2026-09-30';
const US_BORROW = 0.005 / 360;
const UK_BORROW = 0.02 / 365;

type Row = Record<string, unknown>;

interface SaxoFixture {
  readonly listings: Readonly<Record<string, readonly Row[]>>;
  readonly details: Readonly<Record<number, Row>>;
  readonly prices: Readonly<Record<number, Row>>;
}

function listing(symbol: string, uic: number, exchangeId: string, currency: string): Row {
  return { Symbol: symbol, Identifier: uic, ExchangeId: exchangeId, CurrencyCode: currency };
}

function details(uic: number, overrides: Row = {}): Row {
  return {
    Uic: uic,
    IsTradable: true,
    ShortTradeDisabled: false,
    PriceToContractFactor: 1,
    CurrencyCode: 'USD',
    ...overrides,
  };
}

function price(uic: number, borrow: number | undefined, shortTradeDisabled = false): Row {
  const priceDetails: Row = { ShortTradeDisabled: shortTradeDisabled };
  if (borrow !== undefined) priceDetails.CfdBorrowingCost = borrow;
  return { Uic: uic, InstrumentPriceDetails: priceDetails };
}

const FIXTURE: SaxoFixture = {
  listings: {
    'CfdOnStock:NYSE': [
      listing('BRKb:xnys', 2631, 'NYSE', 'USD'),
      listing('ZZZ:xnys', 9, 'NYSE', 'USD'),
      listing('TSCO:xlon', 895, 'LSE_SETS', 'GBP'),
    ],
    'CfdOnStock:NASDAQ': [
      listing('AAPL:xnas', 211, 'NASDAQ', 'USD'),
      listing('TSCO:xnas', 44430, 'NASDAQ', 'USD'),
    ],
    'CfdOnEtf:LSE_ETF': [
      listing('ISF:xlon', 4361, 'LSE_ETF', 'GBP'),
      listing('ISFU:xlon', 14929657, 'LSE_ETF', 'USD'),
      listing('VMID:xlon', 5000, 'LSE_ETF', 'GBP'),
    ],
  },
  details: {
    211: details(211),
    44430: details(44430, { ShortTradeDisabled: true }),
    2631: details(2631, { ShortTradeDisabled: undefined }),
    4361: details(4361, { PriceToContractFactor: 0.01, CurrencyCode: 'GBP' }),
  },
  prices: {
    211: price(211, US_BORROW),
    44430: price(44430, US_BORROW),
    2631: price(2631, undefined),
    4361: price(4361, UK_BORROW),
  },
};

function respond(fixture: SaxoFixture, url: URL): unknown {
  const uics = (url.searchParams.get('Uics') ?? '').split(',').map(Number);
  if (url.pathname.endsWith('/ref/v1/instruments')) {
    const key = `${url.searchParams.get('AssetTypes')}:${url.searchParams.get('ExchangeId')}`;
    const rows = fixture.listings[key] ?? [];
    const skip = Number(url.searchParams.get('$skip'));
    return { Data: rows.slice(skip, skip + Number(url.searchParams.get('$top'))) };
  }
  const source = url.pathname.endsWith('/details') ? fixture.details : fixture.prices;
  return { Data: uics.flatMap((uic) => (source[uic] === undefined ? [] : [source[uic]])) };
}

function fakeSaxo(fixture: SaxoFixture = FIXTURE) {
  const urls: string[] = [];
  const fetcher = (url: string): Promise<FetchResult> => {
    urls.push(url);
    return Promise.resolve({ status: 200, body: respond(fixture, new URL(url)) });
  };
  const api = new SaxoReadOnlyApi(new StaticSaxoTokenSource('t'), GATEWAY, fetcher, () =>
    Promise.resolve(),
  );
  return { api, urls };
}

function recorder() {
  const entries: Parameters<Logger['log']>[0][] = [];
  const logger: Logger = { log: (entry) => void entries.push(entry) };
  return { entries, logger };
}

const SCOPES = cfdScopes(['AAPL', 'TSCO', 'BRK.B', 'MSFT'], ['ISF', 'VMID', 'SGLN']);

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cfd-catalogue-')), 'nested', 'catalogue.json');
}

describe('universeSymbolOf', () => {
  it('drops the exchange suffix and writes a share class the way the universe does', () => {
    expect(universeSymbolOf('AAPL:xnas')).toBe('AAPL');
    expect(universeSymbolOf('BRKb:xnys')).toBe('BRK.B');
    expect(universeSymbolOf('BFb:xnys')).toBe('BF.B');
    expect(universeSymbolOf('ISF:xlon')).toBe('ISF');
    expect(universeSymbolOf('')).toBe('');
  });
});

describe('cfdScopes', () => {
  it('lists US stock CFDs on NYSE and NASDAQ in USD and LSE ETF CFDs in GBP', () => {
    const [us, uk] = cfdScopes(['AAPL']);
    expect(us).toEqual({
      assetType: 'CfdOnStock',
      exchangeIds: ['NYSE', 'NASDAQ'],
      currency: 'USD',
      universe: ['AAPL'],
    });
    expect(uk?.assetType).toBe('CfdOnEtf');
    expect(uk?.exchangeIds).toEqual(['LSE_ETF']);
    expect(uk?.currency).toBe('GBP');
    expect(uk?.universe).toEqual(LSE_LINES.map((line) => line.tidm));
  });
});

describe('buildCfdCatalogue', () => {
  it('keys each row on the universe symbol, keeping only in-scope exchanges and currencies', async () => {
    const report = await buildCfdCatalogue(fakeSaxo().api, SCOPES, AS_OF);
    expect(report.instruments.map((row) => [row.symbol, row.saxoSymbol, row.uic])).toEqual([
      ['BRK.B', 'BRKb:xnys', 2631],
      ['AAPL', 'AAPL:xnas', 211],
      ['TSCO', 'TSCO:xnas', 44430],
      ['ISF', 'ISF:xlon', 4361],
    ]);
    expect(report.unmatched).toEqual(['MSFT', 'VMID', 'SGLN']);
    expect(report.withoutDetails).toEqual(['VMID:xlon']);
    expect(report.clashes).toEqual([]);
    expect(report.asOf).toBe(AS_OF);
  });

  it('copies tradable, the contract factor and the borrow, and fails shorts closed', async () => {
    const report = await buildCfdCatalogue(fakeSaxo().api, SCOPES, AS_OF);
    const bySymbol = new Map(report.instruments.map((row) => [row.symbol, row]));
    expect(bySymbol.get('AAPL')).toEqual({
      symbol: 'AAPL',
      saxoSymbol: 'AAPL:xnas',
      uic: 211,
      assetType: 'CfdOnStock',
      currency: 'USD',
      priceToContractFactor: 1,
      tradable: true,
      shortTradeDisabled: false,
      borrowCostPerDay: US_BORROW,
    });
    expect(bySymbol.get('TSCO')?.shortTradeDisabled).toBe(true);
    expect(bySymbol.get('BRK.B')?.shortTradeDisabled).toBe(false);
    expect(bySymbol.get('BRK.B')?.borrowCostPerDay).toBeUndefined();
    expect(bySymbol.get('ISF')).toMatchObject({
      assetType: 'CfdOnEtf',
      currency: 'GBP',
      priceToContractFactor: 0.01,
      borrowCostPerDay: UK_BORROW,
    });
  });

  const NO_ROW = 'no price row';
  it.each([
    [undefined, undefined, true],
    [undefined, NO_ROW, true],
    [true, false, true],
    [false, true, true],
    [undefined, false, false],
    [false, undefined, false],
    [false, NO_ROW, false],
  ])(
    'details flag %s with price flag %s reads ShortTradeDisabled %s',
    async (inDetails, inPrice, expected) => {
      const priceDetails: Row = { CfdBorrowingCost: US_BORROW };
      if (typeof inPrice === 'boolean') priceDetails.ShortTradeDisabled = inPrice;
      const fixture: SaxoFixture = {
        ...FIXTURE,
        details: { 211: details(211, { ShortTradeDisabled: inDetails }) },
        prices:
          inPrice === NO_ROW ? {} : { 211: { Uic: 211, InstrumentPriceDetails: priceDetails } },
      };
      const [row] = (await buildCfdCatalogue(fakeSaxo(fixture).api, cfdScopes(['AAPL'], []), AS_OF))
        .instruments;
      expect(row?.shortTradeDisabled).toBe(expected);
      expect(row?.borrowCostPerDay).toBe(inPrice === NO_ROW ? undefined : US_BORROW);
    },
  );

  it('keeps a present zero borrow as a known free borrow', async () => {
    const fixture: SaxoFixture = { ...FIXTURE, prices: { 211: price(211, 0) } };
    const [row] = (await buildCfdCatalogue(fakeSaxo(fixture).api, cfdScopes(['AAPL'], []), AS_OF))
      .instruments;
    expect(row?.borrowCostPerDay).toBe(0);
  });

  it('reads no borrow from a price row without InstrumentPriceDetails', async () => {
    const fixture: SaxoFixture = { ...FIXTURE, prices: { 211: { Uic: 211 } } };
    const [row] = (await buildCfdCatalogue(fakeSaxo(fixture).api, cfdScopes(['AAPL'], []), AS_OF))
      .instruments;
    expect(row?.borrowCostPerDay).toBeUndefined();
    expect(row?.shortTradeDisabled).toBe(false);
  });

  it('treats a missing IsTradable as not tradable and a negative borrow as unknown', async () => {
    const fixture: SaxoFixture = {
      ...FIXTURE,
      details: { 211: details(211, { IsTradable: undefined }) },
      prices: { 211: price(211, -1) },
    };
    const [row] = (await buildCfdCatalogue(fakeSaxo(fixture).api, cfdScopes(['AAPL'], []), AS_OF))
      .instruments;
    expect(row?.tradable).toBe(false);
    expect(row?.borrowCostPerDay).toBeUndefined();
  });

  it('drops a listing whose details lack a contract factor or quote another currency', async () => {
    const fixture: SaxoFixture = {
      ...FIXTURE,
      details: {
        211: details(211, { PriceToContractFactor: 0 }),
        44430: details(44430, { CurrencyCode: 'EUR' }),
      },
    };
    const report = await buildCfdCatalogue(
      fakeSaxo(fixture).api,
      cfdScopes(['AAPL', 'TSCO'], []),
      AS_OF,
    );
    expect(report.instruments).toEqual([]);
    expect(report.withoutDetails).toEqual(['AAPL:xnas', 'TSCO:xnas']);
  });

  it('drops every row of a symbol two listings key to, and names the clash', async () => {
    const fixture: SaxoFixture = {
      ...FIXTURE,
      listings: {
        ...FIXTURE.listings,
        'CfdOnStock:NYSE': [listing('ISF:xnys', 77, 'NYSE', 'USD')],
      },
      details: { ...FIXTURE.details, 77: details(77) },
    };
    const report = await buildCfdCatalogue(
      fakeSaxo(fixture).api,
      cfdScopes(['ISF', 'AAPL'], ['ISF']),
      AS_OF,
    );
    expect(report.clashes).toEqual(['ISF']);
    expect(report.instruments.map((row) => row.symbol)).toEqual(['AAPL']);
    expect(report.unmatched).toEqual([]);
  });

  it('pages the instrument search until a short page and batches Uics by 100', async () => {
    const many = Array.from({ length: 1000 }, (_, index) =>
      listing(`X${index}:xnys`, 10_000 + index, 'NYSE', 'USD'),
    );
    const universe = many.map((row) => universeSymbolOf(String(row.Symbol)));
    const manyDetails = Object.fromEntries(
      many.map((row) => [row.Identifier, details(Number(row.Identifier))]),
    );
    const fixture: SaxoFixture = {
      listings: { 'CfdOnStock:NYSE': [...many, listing('AAPL:xnys', 211, 'NYSE', 'USD')] },
      details: { ...manyDetails, 211: details(211) },
      prices: {},
    };
    const { api, urls } = fakeSaxo(fixture);
    const report = await buildCfdCatalogue(
      api,
      [{ ...(SCOPES[0] as CfdScope), exchangeIds: ['NYSE'], universe: [...universe, 'AAPL'] }],
      AS_OF,
    );
    expect(report.instruments).toHaveLength(1001);
    const searches = urls.filter((url) => new URL(url).pathname.endsWith('/instruments'));
    expect(searches.map((url) => new URL(url).searchParams.get('$skip'))).toEqual(['0', '1000']);
    const detailCalls = urls.filter((url) => url.includes('/details?'));
    expect(detailCalls).toHaveLength(11);
    expect(new URL(detailCalls[0] as string).searchParams.get('Uics')?.split(',')).toHaveLength(
      100,
    );
  });

  it('refuses an instrument search that never ends', async () => {
    const full = Array.from({ length: 1000 }, (_, index) =>
      listing(`Y${index}:xnys`, index + 1, 'NYSE', 'USD'),
    );
    const api = {
      cfdInstrumentPage: vi.fn().mockResolvedValue({ Data: full }),
      cfdInstrumentDetails: vi.fn(),
      cfdInfoPrices: vi.fn(),
    };
    await expect(buildCfdCatalogue(api, cfdScopes(['AAPL'], []), AS_OF)).rejects.toThrow(
      /NYSE CfdOnStock exceeds 20 pages/,
    );
    expect(api.cfdInstrumentPage).toHaveBeenCalledTimes(20);
  });

  it('refuses a response without a Data array', async () => {
    const api = {
      cfdInstrumentPage: vi.fn().mockResolvedValue({ Error: 'x' }),
      cfdInstrumentDetails: vi.fn(),
      cfdInfoPrices: vi.fn(),
    };
    await expect(buildCfdCatalogue(api, SCOPES, AS_OF)).rejects.toThrow(
      /instruments: Data missing/,
    );
    api.cfdInstrumentPage.mockResolvedValue('not json');
    await expect(buildCfdCatalogue(api, SCOPES, AS_OF)).rejects.toThrow(/Data missing/);
  });

  it('skips a listing or detail row without a numeric Uic', async () => {
    const fixture: SaxoFixture = {
      ...FIXTURE,
      listings: {
        'CfdOnStock:NASDAQ': [{ Symbol: 'AAPL:xnas', ExchangeId: 'NASDAQ', CurrencyCode: 'USD' }],
      },
    };
    expect(
      (await buildCfdCatalogue(fakeSaxo(fixture).api, cfdScopes(['AAPL'], []), AS_OF)).instruments,
    ).toEqual([]);
    const noUic: SaxoFixture = { ...FIXTURE, details: { 211: { ...details(211), Uic: 'x' } } };
    const report = await buildCfdCatalogue(fakeSaxo(noUic).api, cfdScopes(['AAPL'], []), AS_OF);
    expect(report.withoutDetails).toEqual(['AAPL:xnas']);
  });

  it('sends only GETs to the instrument search, details and infoprices list endpoints', async () => {
    const { api, urls } = fakeSaxo();
    await buildCfdCatalogue(api, SCOPES, AS_OF);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/gw\.test\/openapi\/(ref\/v1\/instruments(\/details)?|trade\/v1\/infoprices\/list)\?/,
      );
    }
    const prices = urls.find((url) => url.includes('/infoprices/list?')) as string;
    expect(new URL(prices).searchParams.get('FieldGroups')).toBe('InstrumentPriceDetails');
    expect(new URL(prices).searchParams.get('AssetType')).toBe('CfdOnStock');
  });
});

describe('catalogueText', () => {
  it('writes a snapshot parseCfdCatalogue accepts, with null for an unknown borrow', async () => {
    const report = await buildCfdCatalogue(fakeSaxo().api, SCOPES, AS_OF);
    const text = catalogueText(report);
    const body = JSON.parse(text) as { asOf: string; instruments: Row[] };
    expect(body.asOf).toBe(AS_OF);
    expect(body.instruments.find((row) => row.symbol === 'BRK.B')?.borrowCostPerDay).toBeNull();
  });

  it('refuses an empty catalogue and one the parser rejects', () => {
    expect(() =>
      catalogueText({
        asOf: AS_OF,
        instruments: [],
        unmatched: [],
        clashes: [],
        withoutDetails: [],
      }),
    ).toThrow(/no instruments, refusing to write/);
    const row = {
      symbol: 'A',
      saxoSymbol: 'A:xnys',
      uic: 1,
      assetType: 'CfdOnStock' as const,
      currency: 'USD' as const,
      priceToContractFactor: 1,
      tradable: true,
      shortTradeDisabled: false,
      borrowCostPerDay: undefined,
    };
    expect(() =>
      catalogueText({
        asOf: AS_OF,
        instruments: [row, row],
        unmatched: [],
        clashes: [],
        withoutDetails: [],
      }),
    ).toThrow(/duplicate symbol/);
    expect(() =>
      catalogueText({
        asOf: '30/09/2026',
        instruments: [row],
        unmatched: [],
        clashes: [],
        withoutDetails: [],
      }),
    ).toThrow(/expected \{ asOf, instruments/);
  });
});

describe('writeAtomically', () => {
  it('creates the directory, writes the text and leaves no staging file', () => {
    const path = tempPath();
    writeAtomically(path, 'one');
    writeAtomically(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(readdirSync(join(path, '..'))).toEqual(['catalogue.json']);
  });
});

describe('refreshCfdCatalogue', () => {
  it('writes a catalogue the router reads, and logs the summary', async () => {
    const path = tempPath();
    const { entries, logger } = recorder();
    await refreshCfdCatalogue(fakeSaxo().api, SCOPES, AS_OF, path, logger);
    const router = createVenueRouter({
      catalogue: loadCfdCatalogue(path),
      entryRefusal: () => undefined,
      maxBorrowRatePerYear: 0.02,
    });
    expect(router.route('AAPL', 'alpaca', 'short', AS_OF)).toEqual({ venue: 'saxo_cfd_usd' });
    expect(router.route('TSCO', 'alpaca', 'short', AS_OF)).toEqual({
      refusal: 'ShortTradeDisabled',
    });
    expect(router.route('BRK.B', 'alpaca', 'short', AS_OF)).toEqual({
      refusal: 'borrow_cost_unknown',
    });
    expect(router.route('ISF', 'saxo', 'short', AS_OF)).toEqual({ venue: 'saxo_cfd_gbp' });
    expect(router.route('MSFT', 'alpaca', 'short', AS_OF)).toEqual({ refusal: 'not_in_catalogue' });
    expect(entries.map((entry) => entry.event)).toEqual(['v2_cfd_catalogue_written']);
    expect(entries[0]?.message).toMatch(
      /^4 CFD rows as of 2026-09-30 .* 3 universe names without a row, 1 listings/,
    );
  });

  it('logs a symbol clash as a warning', async () => {
    const fixture: SaxoFixture = {
      ...FIXTURE,
      listings: {
        ...FIXTURE.listings,
        'CfdOnStock:NYSE': [listing('ISF:xnys', 77, 'NYSE', 'USD')],
      },
      details: { ...FIXTURE.details, 77: details(77) },
    };
    const { entries, logger } = recorder();
    await refreshCfdCatalogue(
      fakeSaxo(fixture).api,
      cfdScopes(['ISF', 'AAPL'], ['ISF']),
      AS_OF,
      tempPath(),
      logger,
    );
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ['v2_cfd_catalogue_symbol_clash', 'warn'],
      ['v2_cfd_catalogue_written', 'info'],
    ]);
    expect(entries[0]?.message).toContain('dropped ISF');
  });

  it('keeps the previous file when the new snapshot is refused', async () => {
    const path = tempPath();
    writeAtomically(path, 'previous');
    const { logger } = recorder();
    await expect(
      refreshCfdCatalogue(fakeSaxo().api, cfdScopes(['MSFT'], []), AS_OF, path, logger),
    ).rejects.toThrow(/no instruments/);
    expect(readFileSync(path, 'utf8')).toBe('previous');
  });
});

describe('cfdCatalogueRefreshFor', () => {
  it('refreshes inside a session, stops it, and adds nothing to the bar report', async () => {
    const path = tempPath();
    const stop = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn(() => ({ api: fakeSaxo().api, stop }));
    const { entries, logger } = recorder();
    const leg = cfdCatalogueRefreshFor(
      { K: 'v' },
      { tradingDate: AS_OF, constituents: ['AAPL'], path, logger, connect },
    );
    expect(await leg.run()).toEqual({ attempted: 0, updated: [], noNewBars: [], failed: [] });
    expect(connect).toHaveBeenCalledWith({ K: 'v' }, logger);
    expect(stop).toHaveBeenCalledOnce();
    expect(loadCfdCatalogue(path)?.lookup('AAPL')?.uic).toBe(211);
    expect(entries.map((entry) => entry.event)).toEqual(['v2_cfd_catalogue_written']);
  });

  it('never throws: a failed refresh is logged, the session still stops and no file is written', async () => {
    const path = tempPath();
    const stop = vi.fn().mockResolvedValue(undefined);
    const { entries, logger } = recorder();
    const leg = cfdCatalogueRefreshFor(
      {},
      {
        tradingDate: AS_OF,
        constituents: ['MSFT'],
        path,
        logger,
        connect: () => ({ api: fakeSaxo({ ...FIXTURE, listings: {} }).api, stop }),
      },
    );
    expect(await leg.run()).toEqual({ attempted: 0, updated: [], noNewBars: [], failed: [] });
    expect(stop).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(false);
    expect(entries.map((entry) => [entry.event, entry.level])).toEqual([
      ['v2_cfd_catalogue_refresh_failed', 'warn'],
    ]);
  });

  it('logs a session that cannot open', async () => {
    const { entries, logger } = recorder();
    const leg = cfdCatalogueRefreshFor(
      {},
      {
        tradingDate: AS_OF,
        constituents: [],
        path: tempPath(),
        logger,
        connect: () => {
          throw new Error('Saxo token dead');
        },
      },
    );
    await leg.run();
    expect(entries[0]?.message).toContain('Saxo token dead');
  });

  it('defaults to a live session, which refuses without Saxo config', async () => {
    const { entries, logger } = recorder();
    const path = join(mkdtempSync(join(tmpdir(), 'cfd-live-')), 'c.json');
    writeFileSync(path, 'untouched');
    await cfdCatalogueRefreshFor({}, { tradingDate: AS_OF, constituents: [], path, logger }).run();
    expect(entries.map((entry) => entry.event)).toEqual(['v2_cfd_catalogue_refresh_failed']);
    expect(readFileSync(path, 'utf8')).toBe('untouched');
  });
});
