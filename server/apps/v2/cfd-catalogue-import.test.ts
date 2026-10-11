import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  CFD_CATALOGUE_ARCHIVE_DIR,
  importCfdCatalogueArchive,
  main,
  parseCfdCatalogueImportArgs,
} from './cfd-catalogue-import.js';
import { cfdCatalogueArchiveOf, loadCfdCatalogue, loadCfdCatalogueArchive } from './data/index.js';
import { V2_STORE_PATH } from './index.js';

const FIRST = '2026-10-12';
const SECOND = '2026-10-15';
const RECORDED_AT = new Date('2026-10-16T07:00:00.000Z');

function text(asOf: string): string {
  const instrument = {
    symbol: 'AAPL',
    saxoSymbol: 'AAPL:xnas',
    uic: 211,
    assetType: 'CfdOnStock',
    currency: 'USD',
    priceToContractFactor: 1,
    tradable: true,
    shortTradeDisabled: false,
    borrowCostPerDay: 0.0000138889,
  };
  return `${JSON.stringify({ asOf, instruments: [instrument] }, null, 2)}\n`;
}

function archiveDir(files: Readonly<Record<string, string>>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'cfd-import-')), 'saxo-cfd-catalogue-archive');
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe('importCfdCatalogueArchive (#2118)', () => {
  it('records every dated snapshot file byte for byte and ignores decoys', () => {
    const dir = archiveDir({
      [`${FIRST}.json`]: text(FIRST),
      [`${SECOND}.json`]: text(SECOND),
      [`${SECOND}.json.123.tmp`]: 'partial',
      'notes.txt': 'x',
      'copy-2026-10-14.json': text('2026-10-14'),
    });
    const db = migratedMemoryStore();
    expect(importCfdCatalogueArchive(db, dir, RECORDED_AT)).toEqual({
      recorded: [FIRST, SECOND],
      held: [],
      ignored: ['2026-10-15.json.123.tmp', 'copy-2026-10-14.json', 'notes.txt'],
    });
    const archive = cfdCatalogueArchiveOf(db);
    expect(archive.inForceOn('2026-10-14')?.sha256).toBe(
      loadCfdCatalogue(join(dir, `${FIRST}.json`))?.sha256,
    );
    expect(archive.inForceOn(SECOND)?.sha256).toBe(
      loadCfdCatalogue(join(dir, `${SECOND}.json`))?.sha256,
    );
  });

  it('is idempotent: a second import holds what the first recorded', () => {
    const dir = archiveDir({ [`${FIRST}.json`]: text(FIRST) });
    const db = migratedMemoryStore();
    importCfdCatalogueArchive(db, dir, RECORDED_AT);
    expect(importCfdCatalogueArchive(db, dir, new Date())).toEqual({
      recorded: [],
      held: [FIRST],
      ignored: [],
    });
  });

  it('imports nothing when the archive directory is absent', () => {
    const db = migratedMemoryStore();
    const missing = join(mkdtempSync(join(tmpdir(), 'cfd-import-')), 'none');
    expect(importCfdCatalogueArchive(db, missing, RECORDED_AT)).toEqual({
      recorded: [],
      held: [],
      ignored: [],
    });
  });

  it.each([
    [
      'a file whose name is not its asOf',
      { [`${FIRST}.json`]: text(SECOND) },
      /holds a snapshot as of 2026-10-15/,
    ],
    [
      'an invalid date in a dated name',
      { '2026-02-30.json': text('2026-02-30') },
      /expected \{ asOf, instruments/,
    ],
    [
      'a dated file that does not parse',
      { [`${FIRST}.json`]: '{}' },
      /expected \{ asOf, instruments/,
    ],
  ])('refuses %s and records nothing', (_name, files, error) => {
    const dir = archiveDir({ [`${SECOND}.json`]: text(SECOND), ...files });
    const db = migratedMemoryStore();
    expect(() => importCfdCatalogueArchive(db, dir, RECORDED_AT)).toThrow(error);
    expect(cfdCatalogueArchiveOf(db).firstAsOf).toBeUndefined();
  });

  it('refuses a file that differs from the snapshot already recorded, and rolls the import back', () => {
    const db = migratedMemoryStore();
    importCfdCatalogueArchive(db, archiveDir({ [`${SECOND}.json`]: text(SECOND) }), RECORDED_AT);
    const edited = archiveDir({
      [`${FIRST}.json`]: text(FIRST),
      [`${SECOND}.json`]: `${text(SECOND)} `,
    });
    expect(() => importCfdCatalogueArchive(db, edited, RECORDED_AT)).toThrow(
      `${SECOND} is already recorded with different bytes`,
    );
    expect(cfdCatalogueArchiveOf(db).firstAsOf).toBe(SECOND);
  });
});

describe('parseCfdCatalogueImportArgs', () => {
  it('defaults to the old archive directory and the v2 store', () => {
    expect(parseCfdCatalogueImportArgs([])).toEqual({
      dir: CFD_CATALOGUE_ARCHIVE_DIR,
      storePath: V2_STORE_PATH,
    });
    expect(CFD_CATALOGUE_ARCHIVE_DIR).toBe('data/saxo-cfd-catalogue-archive');
  });

  it('reads each flag', () => {
    expect(parseCfdCatalogueImportArgs(['--dir', 'd', '--store', 's.sqlite'])).toEqual({
      dir: 'd',
      storePath: 's.sqlite',
    });
  });

  it.each([[['--bogus', 'x']], [['--dir']], [['dir', 'x']]])('refuses %j', (argv) => {
    expect(() => parseCfdCatalogueImportArgs(argv)).toThrow(/^usage: cfd-catalogue-import/);
  });
});

describe('main', () => {
  it('imports into the store given and prints the outcome', () => {
    const dir = archiveDir({ [`${FIRST}.json`]: text(FIRST) });
    const store = join(dir, '..', 'v2.sqlite');
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(main(['--dir', dir, '--store', store], RECORDED_AT)).toBe(0);
      expect(JSON.parse(String(written.mock.calls[0]?.[0]))).toEqual({
        recorded: [FIRST],
        held: [],
        ignored: [],
      });
    } finally {
      written.mockRestore();
    }
    expect(loadCfdCatalogueArchive(store).firstAsOf).toBe(FIRST);
  });
});
