import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../shared/index.js';
import { barRefreshFor } from './bar-refresh.js';
import { cfdCatalogueRefreshFor } from './cfd-catalogue-refresh.js';
import { CFD_CATALOGUE_PATH } from './data/index.js';

vi.mock('./cfd-catalogue-refresh.js', () => ({
  cfdCatalogueRefreshFor: vi.fn(() => ({ run: vi.fn() })),
}));

const SILENT: Logger = { log: () => undefined };
const ENV = { ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' };

function constituentsFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'bar-refresh-cfd-')), 'constituents.csv');
  writeFileSync(path, 'date,tickers\n2016-01-01,"AAPL,MSFT"\n');
  return path;
}

describe('barRefreshFor CFD catalogue leg', () => {
  it('adds the catalogue leg on a non-dry run with the trading date, constituents and path', () => {
    barRefreshFor(false, ENV, '2016-01-07', constituentsFile(), SILENT, 'x/catalogue.json');
    expect(cfdCatalogueRefreshFor).toHaveBeenLastCalledWith(ENV, {
      tradingDate: '2016-01-07',
      constituents: ['AAPL', 'MSFT'],
      path: 'x/catalogue.json',
      logger: SILENT,
    });
  });

  it('defaults to the path the loader reads', () => {
    barRefreshFor(false, ENV, '2016-01-07', constituentsFile(), SILENT);
    expect(vi.mocked(cfdCatalogueRefreshFor).mock.lastCall?.[1].path).toBe(CFD_CATALOGUE_PATH);
  });

  it('builds no catalogue leg on a dry run', () => {
    vi.mocked(cfdCatalogueRefreshFor).mockClear();
    barRefreshFor(true, ENV, '2016-01-07', constituentsFile(), SILENT);
    expect(cfdCatalogueRefreshFor).not.toHaveBeenCalled();
  });
});
