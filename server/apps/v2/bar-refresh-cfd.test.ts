import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../shared/index.js';
import { barRefreshFor } from './bar-refresh.js';
import { cfdCatalogueRefreshFor } from './cfd-catalogue-refresh.js';
import { CFD_CATALOGUE_PATH } from './data/index.js';
import { CYCLE_CFD_CATALOGUE, V2_STORE_PATH } from './index.js';

vi.mock('./cfd-catalogue-refresh.js', () => ({
  cfdCatalogueRefreshFor: vi.fn(() => ({ run: vi.fn() })),
}));

const TARGET = { path: 'x/catalogue.json', storePath: 'x/v2.sqlite' };
const SILENT: Logger = { log: () => undefined };
const ENV = { ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' };

function constituentsFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'bar-refresh-cfd-')), 'constituents.csv');
  writeFileSync(path, 'date,tickers\n2016-01-01,"AAPL,MSFT"\n');
  return path;
}

describe('barRefreshFor CFD catalogue leg', () => {
  it('adds the catalogue leg on a non-dry run with the trading date, constituents and path', () => {
    barRefreshFor(false, ENV, '2016-01-07', constituentsFile(), SILENT, TARGET);
    expect(cfdCatalogueRefreshFor).toHaveBeenLastCalledWith(ENV, {
      tradingDate: '2016-01-07',
      constituents: ['AAPL', 'MSFT'],
      path: 'x/catalogue.json',
      storePath: 'x/v2.sqlite',
      logger: SILENT,
    });
  });

  it('writes, on the cycle, the file the loader reads and the snapshot to the v2 store', () => {
    expect(CYCLE_CFD_CATALOGUE).toEqual({ path: CFD_CATALOGUE_PATH, storePath: V2_STORE_PATH });
  });

  it('builds no catalogue leg on a dry run', () => {
    vi.mocked(cfdCatalogueRefreshFor).mockClear();
    barRefreshFor(true, ENV, '2016-01-07', constituentsFile(), SILENT, TARGET);
    expect(cfdCatalogueRefreshFor).not.toHaveBeenCalled();
  });
});
