import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { errorStack, runWhenInvoked } from '../../tools/cli-entrypoint.js';
import { parseFlags } from './cfd-catalogue-cli.js';
import { parseCfdCatalogueBytes, recordCfdCatalogueSnapshot } from './data/index.js';
import { V2_STORE_PATH } from './index.js';

export const CFD_CATALOGUE_ARCHIVE_DIR = 'data/saxo-cfd-catalogue-archive';
export const CFD_CATALOGUE_IMPORT_USAGE = 'usage: cfd-catalogue-import [--dir PATH] [--store PATH]';

const SNAPSHOT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const FLAGS = new Set(['dir', 'store']);

export interface CfdCatalogueImport {
  readonly recorded: readonly string[];
  readonly held: readonly string[];
  readonly ignored: readonly string[];
}

interface ArchivedFile {
  readonly asOf: string;
  readonly bytes: Buffer;
}

function archivedFile(dir: string, name: string, asOf: string): ArchivedFile {
  const bytes = readFileSync(join(dir, name));
  const snapshot = parseCfdCatalogueBytes(bytes);
  if (snapshot.asOf !== asOf) {
    throw new Error(`CFD catalogue import: ${name} holds a snapshot as of ${snapshot.asOf}`);
  }
  return { asOf, bytes };
}

export function importCfdCatalogueArchive(
  db: StoreHandle,
  dir: string,
  recordedAt: Date,
): CfdCatalogueImport {
  const names = existsSync(dir) ? readdirSync(dir).sort() : [];
  const files: ArchivedFile[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    const asOf = SNAPSHOT_FILE.exec(name)?.[1];
    if (asOf === undefined) ignored.push(name);
    else files.push(archivedFile(dir, name, asOf));
  }
  const outcome = { recorded: [] as string[], held: [] as string[], ignored };
  db.transaction(() => {
    for (const { asOf, bytes } of files) {
      outcome[recordCfdCatalogueSnapshot(db, bytes, recordedAt)].push(asOf);
    }
  })();
  return outcome;
}

export function parseCfdCatalogueImportArgs(argv: readonly string[]): {
  dir: string;
  storePath: string;
} {
  const parsed = parseFlags(argv, FLAGS, CFD_CATALOGUE_IMPORT_USAGE);
  return {
    dir: parsed.get('dir') ?? CFD_CATALOGUE_ARCHIVE_DIR,
    storePath: parsed.get('store') ?? V2_STORE_PATH,
  };
}

export function main(argv: readonly string[], now: Date = new Date()): number {
  const { dir, storePath } = parseCfdCatalogueImportArgs(argv);
  const db = openSharedStore(storePath);
  try {
    const outcome = importCfdCatalogueArchive(db, dir, now);
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return 0;
  } finally {
    db.close();
  }
}

void runWhenInvoked(
  import.meta.url,
  () => Promise.resolve().then(() => main(process.argv.slice(2))),
  errorStack,
);
