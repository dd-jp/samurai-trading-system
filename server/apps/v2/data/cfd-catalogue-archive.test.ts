import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSharedStore } from '../../../shared/store/index.js';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { CfdCatalogue } from './cfd-catalogue.js';
import {
  CfdCatalogueArchive,
  cfdCatalogueArchiveOf,
  loadCfdCatalogueArchive,
  recordCfdCatalogueSnapshot,
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

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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

const RECORDED_AT = new Date('2026-10-12T07:00:00.000Z');

function bytes(asOf: string): Buffer {
  return Buffer.from(text(asOf));
}

describe('recordCfdCatalogueSnapshot (#2118)', () => {
  it('records the exact bytes under their asOf, stamped with the time recorded', () => {
    const db = migratedMemoryStore();
    expect(recordCfdCatalogueSnapshot(db, bytes(FIRST), RECORDED_AT)).toBe('recorded');
    expect(
      db.prepare('SELECT as_of, body, recorded_at FROM v2_cfd_catalogue_snapshots').all(),
    ).toEqual([{ as_of: FIRST, body: bytes(FIRST), recorded_at: '2026-10-12T07:00:00.000Z' }]);
  });

  it('is a no-op for the same asOf and bytes', () => {
    const db = migratedMemoryStore();
    recordCfdCatalogueSnapshot(db, bytes(FIRST), RECORDED_AT);
    expect(recordCfdCatalogueSnapshot(db, bytes(FIRST), new Date())).toBe('held');
    expect(db.prepare('SELECT recorded_at FROM v2_cfd_catalogue_snapshots').all()).toEqual([
      { recorded_at: '2026-10-12T07:00:00.000Z' },
    ]);
  });

  it('refuses the same asOf with other bytes and keeps the first', () => {
    const db = migratedMemoryStore();
    recordCfdCatalogueSnapshot(db, bytes(FIRST), RECORDED_AT);
    const reformatted = Buffer.from(`${text(FIRST)}\n`);
    expect(() => recordCfdCatalogueSnapshot(db, reformatted, RECORDED_AT)).toThrow(
      `CFD catalogue archive: ${FIRST} is already recorded with different bytes`,
    );
    expect(cfdCatalogueArchiveOf(db).inForceOn(FIRST)?.sha256).toBe(sha256(bytes(FIRST)));
  });

  it('refuses a snapshot that does not parse or carries an invalid asOf, and records nothing', () => {
    const db = migratedMemoryStore();
    expect(() => recordCfdCatalogueSnapshot(db, Buffer.from('{}'), RECORDED_AT)).toThrow(
      /expected \{ asOf, instruments/,
    );
    expect(() => recordCfdCatalogueSnapshot(db, bytes('2026-02-30'), RECORDED_AT)).toThrow(
      /expected \{ asOf, instruments/,
    );
    expect(cfdCatalogueArchiveOf(db).firstAsOf).toBeUndefined();
  });
});

describe('cfdCatalogueArchiveOf (#2118)', () => {
  it('reads every recorded snapshot with the digest of its bytes', () => {
    const db = migratedMemoryStore();
    recordCfdCatalogueSnapshot(db, bytes(SECOND), RECORDED_AT);
    recordCfdCatalogueSnapshot(db, bytes(FIRST), RECORDED_AT);
    const archive = cfdCatalogueArchiveOf(db);
    expect(archive.firstAsOf).toBe(FIRST);
    expect(archive.inForceOn('2026-10-14')?.lookup('AAPL')?.uic).toBe(211);
    expect(archive.inForceWithin(FIRST, SECOND)).toEqual([
      { asOf: FIRST, sha256: sha256(bytes(FIRST)) },
      { asOf: SECOND, sha256: sha256(bytes(SECOND)) },
    ]);
  });

  it('refuses a row whose key is not its snapshot asOf', () => {
    const db = migratedMemoryStore();
    db.prepare(
      'INSERT INTO v2_cfd_catalogue_snapshots (as_of, body, recorded_at) VALUES (?, ?, ?)',
    ).run(FIRST, bytes(SECOND), 't');
    expect(() => cfdCatalogueArchiveOf(db)).toThrow(
      `CFD catalogue archive: row ${FIRST} holds a snapshot as of ${SECOND}`,
    );
  });

  it('keeps a key that is not a date out of the table, and the rows append-only', () => {
    const db = migratedMemoryStore();
    const insert = db.prepare(
      'INSERT INTO v2_cfd_catalogue_snapshots (as_of, body, recorded_at) VALUES (?, ?, ?)',
    );
    expect(() => insert.run('latest', bytes(FIRST), 't')).toThrow(/CHECK constraint/);
    recordCfdCatalogueSnapshot(db, bytes(FIRST), RECORDED_AT);
    expect(() => db.exec('DELETE FROM v2_cfd_catalogue_snapshots')).toThrow(/append-only/);
    expect(() => db.exec("UPDATE v2_cfd_catalogue_snapshots SET recorded_at = 'x'")).toThrow(
      /append-only/,
    );
  });
});

describe('loadCfdCatalogueArchive (#2118)', () => {
  it('is empty when the store does not exist yet', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cfd-archive-')), 'v2.sqlite');
    expect(loadCfdCatalogueArchive(path).firstAsOf).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it('reads the snapshots a store holds', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cfd-archive-')), 'v2.sqlite');
    const db = openSharedStore(path);
    recordCfdCatalogueSnapshot(db, bytes(FIRST), RECORDED_AT);
    db.close();
    expect(loadCfdCatalogueArchive(path).inForceOn(SECOND)?.asOf).toBe(FIRST);
  });
});
