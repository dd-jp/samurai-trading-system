import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../shared/index.js';
import { main, parseCfdCatalogueArgs, summarise } from './cfd-catalogue-cli.js';
import type { CfdReferenceApi } from './cfd-catalogue-refresh.js';
import { CFD_CATALOGUE_PATH, loadCfdCatalogue } from './data/index.js';
import { CONSTITUENTS_PATH } from './index.js';

const TODAY = '2026-09-30';
const SILENT: Logger = { log: () => undefined };

describe('parseCfdCatalogueArgs', () => {
  it('defaults to the loader path, the live token file, today and the constituents file', () => {
    expect(parseCfdCatalogueArgs([], TODAY)).toEqual({
      out: CFD_CATALOGUE_PATH,
      tokenPath: undefined,
      date: TODAY,
      constituentsPath: CONSTITUENTS_PATH,
    });
  });

  it('reads each flag', () => {
    const argv = [
      '--out',
      'o.json',
      '--token',
      't.json',
      '--date',
      '2026-01-02',
      '--constituents',
      'c.csv',
    ];
    expect(parseCfdCatalogueArgs(argv, TODAY)).toEqual({
      out: 'o.json',
      tokenPath: 't.json',
      date: '2026-01-02',
      constituentsPath: 'c.csv',
    });
  });

  it.each([[['--bogus', 'x']], [['--out']], [['out', 'x']]])('refuses %j', (argv) => {
    expect(() => parseCfdCatalogueArgs(argv, TODAY)).toThrow(/^usage: cfd-catalogue/);
  });
});

function fakeApi(): CfdReferenceApi {
  return {
    cfdInstrumentPage: (assetType, exchangeId) =>
      Promise.resolve({
        Data:
          assetType === 'CfdOnStock' && exchangeId === 'NASDAQ'
            ? [{ Symbol: 'AAPL:xnas', Identifier: 211, ExchangeId: 'NASDAQ', CurrencyCode: 'USD' }]
            : [],
      }),
    cfdInstrumentDetails: (uics) =>
      Promise.resolve({
        Data: uics.map((Uic) => ({
          Uic,
          IsTradable: true,
          ShortTradeDisabled: false,
          PriceToContractFactor: 1,
          CurrencyCode: 'USD',
        })),
      }),
    cfdInfoPrices: () => Promise.resolve({ Data: [] }),
  };
}

describe('main', () => {
  it('refreshes the catalogue for the date and constituents given, then stops the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfd-cli-'));
    const constituents = join(dir, 'c.csv');
    writeFileSync(constituents, 'date,tickers\n2026-01-01,"AAPL,MSFT"\n');
    const out = join(dir, 'catalogue.json');
    const stop = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn(() => ({ api: fakeApi(), stop }));
    const argv = ['--out', out, '--token', 'tok.json', '--constituents', constituents];
    const summary = await main(argv, TODAY, connect, SILENT);
    expect(connect).toHaveBeenCalledWith('tok.json', SILENT);
    expect(stop).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({
      asOf: TODAY,
      rows: 1,
      cfdOnStock: 1,
      cfdOnEtf: 0,
      clashes: [],
    });
    expect(summary.unmatched).toContain('MSFT');
    expect(loadCfdCatalogue(out)?.freshOn(TODAY)).toBe(true);
  });

  it('stops the session when the refresh fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfd-cli-'));
    const constituents = join(dir, 'c.csv');
    writeFileSync(constituents, 'date,tickers\n2026-01-01,"MSFT"\n');
    const stop = vi.fn().mockResolvedValue(undefined);
    const argv = ['--out', join(dir, 'o.json'), '--constituents', constituents];
    await expect(main(argv, TODAY, () => ({ api: fakeApi(), stop }), SILENT)).rejects.toThrow(
      /no instruments/,
    );
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('summarise', () => {
  it('counts rows by asset type', () => {
    const row = {
      symbol: 'ISF',
      saxoSymbol: 'ISF:xlon',
      uic: 4361,
      assetType: 'CfdOnEtf' as const,
      currency: 'GBP' as const,
      priceToContractFactor: 0.01,
      tradable: true,
      shortTradeDisabled: false,
      borrowCostPerDay: undefined,
    };
    expect(
      summarise({
        asOf: TODAY,
        instruments: [row],
        unmatched: ['X'],
        clashes: [],
        withoutDetails: ['Y'],
      }),
    ).toEqual({
      asOf: TODAY,
      rows: 1,
      cfdOnStock: 0,
      cfdOnEtf: 1,
      unmatched: ['X'],
      clashes: [],
      withoutDetails: ['Y'],
    });
  });
});
