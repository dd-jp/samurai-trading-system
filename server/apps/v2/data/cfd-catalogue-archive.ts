import { existsSync } from 'node:fs';
import type { StoreHandle } from '../../../shared/store/index.js';
import { guardedStore, openReadOnlyStore, toStoredTimestamp } from '../../../shared/store/index.js';
import { type CfdCatalogue, parseCfdCatalogueBytes } from './cfd-catalogue.js';

export interface CfdSnapshotIdentity {
  readonly asOf: string;
  readonly sha256: string;
}

export class CfdCatalogueArchive {
  readonly #snapshots: readonly CfdCatalogue[];

  constructor(snapshots: readonly CfdCatalogue[]) {
    if (new Set(snapshots.map(({ asOf }) => asOf)).size !== snapshots.length) {
      throw new Error('CFD catalogue archive: two snapshots share an asOf');
    }
    this.#snapshots = [...snapshots].sort((a, b) => a.asOf.localeCompare(b.asOf));
  }

  get firstAsOf(): string | undefined {
    return this.#snapshots[0]?.asOf;
  }

  inForceOn(tradingDate: string): CfdCatalogue | undefined {
    return this.#snapshots.findLast((snapshot) => snapshot.asOf <= tradingDate);
  }

  inForceWithin(from: string, to: string): readonly CfdSnapshotIdentity[] {
    const opening = this.inForceOn(from);
    return this.#snapshots
      .filter((snapshot) => snapshot === opening || (snapshot.asOf > from && snapshot.asOf <= to))
      .map(({ asOf, sha256 }) => ({ asOf, sha256 }));
  }
}

export type SnapshotRecording = 'recorded' | 'held';

export function recordCfdCatalogueSnapshot(
  db: StoreHandle,
  bytes: Uint8Array,
  recordedAt: Date,
): SnapshotRecording {
  const body = Buffer.from(bytes);
  const { asOf } = parseCfdCatalogueBytes(body);
  const store = guardedStore(db, 'v2');
  return store
    .transaction((): SnapshotRecording => {
      const held = store
        .prepare('SELECT body FROM v2_cfd_catalogue_snapshots WHERE as_of = ?')
        .get(asOf) as { body: Buffer } | undefined;
      if (held === undefined) {
        store
          .prepare(
            'INSERT INTO v2_cfd_catalogue_snapshots (as_of, body, recorded_at) VALUES (?, ?, ?)',
          )
          .run(asOf, body, toStoredTimestamp(recordedAt));
        return 'recorded';
      }
      if (held.body.equals(body)) return 'held';
      throw new Error(`CFD catalogue archive: ${asOf} is already recorded with different bytes`);
    })
    .immediate();
}

function storedSnapshot(row: { as_of: string; body: Buffer }): CfdCatalogue {
  const snapshot = parseCfdCatalogueBytes(row.body);
  if (snapshot.asOf !== row.as_of) {
    throw new Error(
      `CFD catalogue archive: row ${row.as_of} holds a snapshot as of ${snapshot.asOf}`,
    );
  }
  return snapshot;
}

export function cfdCatalogueArchiveOf(db: StoreHandle): CfdCatalogueArchive {
  const rows = db
    .prepare('SELECT as_of, body FROM v2_cfd_catalogue_snapshots ORDER BY as_of')
    .all() as { as_of: string; body: Buffer }[];
  return new CfdCatalogueArchive(rows.map(storedSnapshot));
}

export function loadCfdCatalogueArchive(storePath: string): CfdCatalogueArchive {
  if (!existsSync(storePath)) return new CfdCatalogueArchive([]);
  const db = openReadOnlyStore(storePath);
  try {
    return cfdCatalogueArchiveOf(db);
  } finally {
    db.close();
  }
}
