import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type CfdCatalogue, loadCfdCatalogue } from './cfd-catalogue.js';

const SNAPSHOT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export function cfdCatalogueArchiveDirFor(cataloguePath: string): string {
  return `${cataloguePath.replace(/\.json$/, '')}-archive`;
}

export function cfdCatalogueArchivePath(archiveDir: string, asOf: string): string {
  return join(archiveDir, `${asOf}.json`);
}

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

function archivedSnapshot(archiveDir: string, name: string, asOf: string): CfdCatalogue {
  const snapshot = loadCfdCatalogue(join(archiveDir, name)) as CfdCatalogue;
  if (snapshot.asOf !== asOf) {
    throw new Error(`CFD catalogue archive: ${name} holds a snapshot as of ${snapshot.asOf}`);
  }
  return snapshot;
}

export function loadCfdCatalogueArchive(archiveDir: string): CfdCatalogueArchive {
  if (!existsSync(archiveDir)) return new CfdCatalogueArchive([]);
  const snapshots: CfdCatalogue[] = [];
  for (const name of readdirSync(archiveDir)) {
    const asOf = SNAPSHOT_FILE.exec(name)?.[1];
    if (asOf !== undefined) snapshots.push(archivedSnapshot(archiveDir, name, asOf));
  }
  return new CfdCatalogueArchive(snapshots);
}
