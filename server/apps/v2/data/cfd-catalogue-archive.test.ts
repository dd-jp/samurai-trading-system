import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CfdCatalogue } from './cfd-catalogue.js';
import {
  CfdCatalogueArchive,
  cfdCatalogueArchiveDirFor,
  cfdCatalogueArchivePath,
  loadCfdCatalogueArchive,
} from './cfd-catalogue-archive.js';

const FIRST = '2026-10-12';
const SECOND = '2026-10-15';

function snapshot(asOf: string): CfdCatalogue {
  return new CfdCatalogue({ asOf, instruments: [] });
}

function text(asOf: string): string {
  return JSON.stringify({
    asOf,
    instruments: [
      {
        symbol: 'AAPL',
        saxoSymbol: 'AAPL:xnas',
        uic: 211,
        assetType: 'CfdOnStock',
        currency: 'USD',
        priceToContractFactor: 1,
        tradable: true,
        shortTradeDisabled: false,
        borrowCostPerDay: 0.0000138889,
      },
    ],
  });
}

function archiveDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'cfd-archive-')), 'catalogue-archive');
}

describe('CfdCatalogueArchive.inForceOn (#2105)', () => {
  const archive = new CfdCatalogueArchive([snapshot(SECOND), snapshot(FIRST)]);

  it('has nothing in force the day before the first snapshot', () => {
    expect(archive.firstAsOf).toBe(FIRST);
    expect(archive.inForceOn('2026-10-11')).toBeUndefined();
  });

  it('puts the first snapshot in force on its own day', () => {
    expect(archive.inForceOn(FIRST)?.asOf).toBe(FIRST);
  });

  it('keeps the earlier snapshot in force between two, and the later from its day', () => {
    expect(archive.inForceOn('2026-10-14')?.asOf).toBe(FIRST);
    expect(archive.inForceOn(SECOND)?.asOf).toBe(SECOND);
    expect(archive.inForceOn('2027-01-04')?.asOf).toBe(SECOND);
  });

  it('is empty with no snapshots', () => {
    const empty = new CfdCatalogueArchive([]);
    expect(empty.firstAsOf).toBeUndefined();
    expect(empty.inForceOn(SECOND)).toBeUndefined();
  });

  it('refuses two snapshots as of one date', () => {
    expect(() => new CfdCatalogueArchive([snapshot(FIRST), snapshot(FIRST)])).toThrow(
      /share an asOf/,
    );
  });
});

describe('CfdCatalogueArchive.inForceWithin (#2105)', () => {
  const archive = new CfdCatalogueArchive([snapshot(FIRST), snapshot(SECOND)]);
  const ids = (from: string, to: string) =>
    archive.inForceWithin(from, to).map((identity) => identity.asOf);

  it('names none for a window that ends before the first snapshot', () => {
    expect(ids('2016-01-04', '2026-10-11')).toEqual([]);
  });

  it('names the snapshot in force at the start and each one dated inside the window', () => {
    expect(ids('2016-01-04', FIRST)).toEqual([FIRST]);
    expect(ids('2026-10-13', '2026-10-14')).toEqual([FIRST]);
    expect(ids('2026-10-13', SECOND)).toEqual([FIRST, SECOND]);
    expect(ids(SECOND, '2027-01-04')).toEqual([SECOND]);
  });

  it('carries each snapshot digest', () => {
    expect(archive.inForceWithin(FIRST, FIRST)).toEqual([
      { asOf: FIRST, sha256: snapshot(FIRST).sha256 },
    ]);
  });
});

describe('loadCfdCatalogueArchive (#2105)', () => {
  it('reads every dated snapshot file and ignores other entries', () => {
    const dir = archiveDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(cfdCatalogueArchivePath(dir, FIRST), text(FIRST));
    writeFileSync(cfdCatalogueArchivePath(dir, SECOND), text(SECOND));
    writeFileSync(join(dir, `${SECOND}.json.123.tmp`), 'partial');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'copy-2026-10-14.json'), text('2026-10-14'));
    const archive = loadCfdCatalogueArchive(dir);
    expect(archive.firstAsOf).toBe(FIRST);
    expect(archive.inForceOn('2026-10-14')?.asOf).toBe(FIRST);
    expect(archive.inForceOn('2026-10-14')?.lookup('AAPL')?.uic).toBe(211);
    expect(archive.inForceWithin(FIRST, SECOND).map((identity) => identity.asOf)).toEqual([
      FIRST,
      SECOND,
    ]);
  });

  it('is empty when no refresh has archived yet', () => {
    expect(loadCfdCatalogueArchive(archiveDir()).firstAsOf).toBeUndefined();
  });

  it('refuses a file whose name is not its asOf', () => {
    const dir = archiveDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(cfdCatalogueArchivePath(dir, FIRST), text(SECOND));
    expect(() => loadCfdCatalogueArchive(dir)).toThrow(
      `${FIRST}.json holds a snapshot as of ${SECOND}`,
    );
  });

  it('refuses a snapshot that does not parse', () => {
    const dir = archiveDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(cfdCatalogueArchivePath(dir, FIRST), '{}');
    expect(() => loadCfdCatalogueArchive(dir)).toThrow(/expected \{ asOf, instruments/);
  });
});

describe('cfdCatalogueArchiveDirFor', () => {
  it('archives beside the catalogue file', () => {
    expect(cfdCatalogueArchiveDirFor('data/saxo-cfd-catalogue.json')).toBe(
      'data/saxo-cfd-catalogue-archive',
    );
    expect(cfdCatalogueArchiveDirFor('/tmp/catalogue')).toBe('/tmp/catalogue-archive');
  });
});
