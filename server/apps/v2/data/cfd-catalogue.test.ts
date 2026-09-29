import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  borrowCostPerYear,
  CFD_CATALOGUE_MAX_AGE_CALENDAR_DAYS,
  CfdCatalogue,
  type CfdInstrument,
  loadCfdCatalogue,
  parseCfdCatalogue,
} from './cfd-catalogue.js';

const VOD = {
  symbol: 'VOD',
  saxoSymbol: 'VODl:xlon',
  uic: 4_711,
  assetType: 'CfdOnStock',
  currency: 'GBP',
  priceToContractFactor: 0.01,
  tradable: true,
  shortTradeDisabled: false,
  borrowCostPerDay: 0.0000137,
};

function file(body: unknown): string {
  return JSON.stringify(body);
}

describe('parseCfdCatalogue', () => {
  it('reads instruments by symbol', () => {
    const catalogue = parseCfdCatalogue(file({ asOf: '2026-09-29', instruments: [VOD] }));
    expect(catalogue.lookup('VOD')).toEqual(VOD);
    expect(catalogue.lookup('BARC')).toBeUndefined();
  });

  it('treats a missing or null borrow cost as unknown, not zero', () => {
    const { borrowCostPerDay: _omitted, ...rest } = VOD;
    const catalogue = parseCfdCatalogue(
      file({
        asOf: '2026-09-29',
        instruments: [rest, { ...VOD, symbol: 'X', borrowCostPerDay: null }],
      }),
    );
    expect(catalogue.lookup('VOD')?.borrowCostPerDay).toBeUndefined();
    expect(catalogue.lookup('X')?.borrowCostPerDay).toBeUndefined();
  });

  it('rejects a duplicate symbol', () => {
    expect(() =>
      parseCfdCatalogue(
        file({ asOf: '2026-09-29', instruments: [VOD, { ...VOD, borrowCostPerDay: 0 }] }),
      ),
    ).toThrow(/duplicate symbol/);
  });

  it('accepts a zero borrow cost', () => {
    const catalogue = parseCfdCatalogue(
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, borrowCostPerDay: 0 }] }),
    );
    expect(catalogue.lookup('VOD')?.borrowCostPerDay).toBe(0);
  });

  it.each([
    ['a non-object body', '[]'],
    ['no asOf', file({ instruments: [] })],
    ['a non-date asOf', file({ asOf: 'yesterday', instruments: [] })],
    ['an impossible asOf', file({ asOf: '2026-02-30', instruments: [] })],
    ['no instruments', file({ asOf: '2026-09-29' })],
    ['a non-string symbol', file({ asOf: '2026-09-29', instruments: [{ ...VOD, symbol: 3 }] })],
    ['an empty symbol', file({ asOf: '2026-09-29', instruments: [{ ...VOD, symbol: '' }] })],
    [
      'an unknown asset type',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, assetType: 'Etf' }] }),
    ],
    [
      'an unknown currency',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, currency: 'GBX' }] }),
    ],
    [
      'a zero contract factor',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, priceToContractFactor: 0 }] }),
    ],
    [
      'a non-boolean tradable',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, tradable: 'yes' }] }),
    ],
    [
      'a non-boolean short flag',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, shortTradeDisabled: 0 }] }),
    ],
    [
      'a negative borrow cost',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, borrowCostPerDay: -1 }] }),
    ],
    [
      'a non-numeric borrow cost',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, borrowCostPerDay: 'x' }] }),
    ],
    ['a null instrument', file({ asOf: '2026-09-29', instruments: [null] })],
    ['a zero uic', file({ asOf: '2026-09-29', instruments: [{ ...VOD, uic: 0 }] })],
    ['a negative uic', file({ asOf: '2026-09-29', instruments: [{ ...VOD, uic: -1 }] })],
    ['a string uic', file({ asOf: '2026-09-29', instruments: [{ ...VOD, uic: '5' }] })],
    [
      'an infinite uic',
      file({ asOf: '2026-09-29', instruments: [VOD] }).replace('"uic":4711', '"uic":1e999'),
    ],
    [
      'an infinite borrow cost',
      file({ asOf: '2026-09-29', instruments: [VOD] }).replace(
        '"borrowCostPerDay":0.0000137',
        '"borrowCostPerDay":1e999',
      ),
    ],
    [
      'a string borrow cost',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, borrowCostPerDay: '5' }] }),
    ],
    [
      'a non-string saxo symbol',
      file({ asOf: '2026-09-29', instruments: [{ ...VOD, saxoSymbol: 3 }] }),
    ],
    ['an array asOf', file({ asOf: ['2026-09-29'], instruments: [] })],
    ['an asOf with trailing text', file({ asOf: '2026-09-29x', instruments: [] })],
    ['an asOf with leading text', file({ asOf: 'x2026-09-29', instruments: [] })],
    ['a scalar body', '5'],
    ['a scalar instrument', file({ asOf: '2026-09-29', instruments: [5] })],
  ])('throws on %s', (_name, text) => {
    expect(() => parseCfdCatalogue(text)).toThrow(/CFD catalogue/);
  });
});

describe('CfdCatalogue.freshOn', () => {
  const catalogue = new CfdCatalogue({ asOf: '2026-09-25', instruments: [] });

  it('is fresh through the third calendar day after the snapshot and stale on the fourth', () => {
    expect(CFD_CATALOGUE_MAX_AGE_CALENDAR_DAYS).toBe(3);
    expect(catalogue.freshOn('2026-09-25')).toBe(true);
    expect(catalogue.freshOn('2026-09-28')).toBe(true);
    expect(catalogue.freshOn('2026-09-29')).toBe(false);
  });

  it('is not fresh for a trading date before the snapshot, so a replay never reads a later snapshot', () => {
    expect(catalogue.freshOn('2026-09-24')).toBe(false);
  });
});

describe('borrowCostPerYear', () => {
  const instrument = (borrowCostPerDay: number | undefined): CfdInstrument => ({
    ...(VOD as Omit<CfdInstrument, 'borrowCostPerDay'>),
    borrowCostPerDay,
  });

  it('annualises the per-day fraction over 365 days', () => {
    expect(borrowCostPerYear(instrument(0.0000137))).toBeCloseTo(0.005, 4);
    expect(borrowCostPerYear(instrument(0.02 / 365))).toBeCloseTo(0.02, 12);
  });

  it('is undefined when the borrow cost is unknown', () => {
    expect(borrowCostPerYear(instrument(undefined))).toBeUndefined();
  });
});

describe('loadCfdCatalogue', () => {
  it('is undefined for a missing file and parses a present one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfd-catalogue-'));
    expect(loadCfdCatalogue(join(dir, 'absent.json'))).toBeUndefined();
    const present = join(dir, 'catalogue.json');
    writeFileSync(present, file({ asOf: '2026-09-29', instruments: [VOD] }));
    expect(loadCfdCatalogue(present)?.lookup('VOD')?.uic).toBe(4_711);
  });

  it('throws on a present but malformed file rather than pretending it is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfd-catalogue-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(() => loadCfdCatalogue(bad)).toThrow();
  });
});
