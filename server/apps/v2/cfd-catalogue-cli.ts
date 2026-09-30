import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openSaxoLiveSession } from '../../providers/saxo-bars/index.js';
import type { Logger } from '../../shared/index.js';
import {
  type CfdCatalogueRefreshReport,
  type CfdSession,
  cfdScopes,
  refreshCfdCatalogue,
} from './cfd-catalogue-refresh.js';
import { CFD_CATALOGUE_PATH, currentConstituents } from './data/index.js';
import { CONSTITUENTS_PATH } from './index.js';

export const CFD_CATALOGUE_USAGE =
  'usage: cfd-catalogue [--out PATH] [--token PATH] [--date YYYY-MM-DD] [--constituents PATH]';

export interface CfdCatalogueArgs {
  readonly out: string;
  readonly tokenPath: string | undefined;
  readonly date: string;
  readonly constituentsPath: string;
}

const FLAGS = new Set(['out', 'token', 'date', 'constituents']);

function flags(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = /^--(\w+)$/.exec(argv[index] ?? '')?.[1];
    const value = argv[index + 1];
    if (name === undefined || !FLAGS.has(name) || value === undefined) {
      throw new Error(CFD_CATALOGUE_USAGE);
    }
    parsed.set(name, value);
  }
  return parsed;
}

export function parseCfdCatalogueArgs(argv: readonly string[], today: string): CfdCatalogueArgs {
  const parsed = flags(argv);
  return {
    out: parsed.get('out') ?? CFD_CATALOGUE_PATH,
    tokenPath: parsed.get('token'),
    date: parsed.get('date') ?? today,
    constituentsPath: parsed.get('constituents') ?? CONSTITUENTS_PATH,
  };
}

export function summarise(report: CfdCatalogueRefreshReport): Record<string, unknown> {
  const count = (assetType: string) =>
    report.instruments.filter((instrument) => instrument.assetType === assetType).length;
  return {
    asOf: report.asOf,
    rows: report.instruments.length,
    cfdOnStock: count('CfdOnStock'),
    cfdOnEtf: count('CfdOnEtf'),
    unmatched: report.unmatched,
    clashes: report.clashes,
    withoutDetails: report.withoutDetails,
  };
}

export type CliConnect = (tokenPath: string | undefined, logger: Logger) => CfdSession;

const connectLive: CliConnect = (tokenPath, logger) =>
  openSaxoLiveSession(process.env, tokenPath, logger);

const STDERR_LOGGER: Logger = {
  log: (entry) => process.stderr.write(`${entry.event}: ${entry.message}\n`),
};

export async function main(
  argv: readonly string[],
  today: string,
  connect: CliConnect = connectLive,
  logger: Logger = STDERR_LOGGER,
): Promise<Record<string, unknown>> {
  const args = parseCfdCatalogueArgs(argv, today);
  const constituents = currentConstituents(readFileSync(args.constituentsPath, 'utf8'), args.date);
  const session = connect(args.tokenPath, logger);
  try {
    const scopes = cfdScopes(constituents);
    return summarise(await refreshCfdCatalogue(session.api, scopes, args.date, args.out, logger));
  } finally {
    await session.stop();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), new Date().toISOString().slice(0, 10))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
