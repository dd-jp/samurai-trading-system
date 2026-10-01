import { readFileSync } from 'node:fs';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import type { Logger } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openReadOnlyStore } from '../../shared/store/index.js';
import { errorMessage, setExitCodeWhenInvoked } from '../../tools/cli-entrypoint.js';
import { BarsMarketData, CFD_CATALOGUE_PATH, parseBoeGbpUsdCsv } from './data/index.js';
import {
  barsSourceFor,
  CONSTITUENTS_PATH,
  cfdCatalogueFor,
  constituentsFromCsv,
  FX_PATH,
  knownSecretsFrom,
  V2_STORE_PATH,
} from './index.js';
import { formatReplay, type ReplayResult, redactor, replayDay } from './replay.js';

export interface ReplayCliOptions {
  readonly tradingDate: string;
  readonly storePath: string;
  readonly barStoreRoot: string;
  readonly constituentsPath: string;
  readonly fxPath: string;
  readonly cfdCataloguePath: string;
}

const FLAGS: Readonly<Record<string, keyof ReplayCliOptions>> = {
  '--date': 'tradingDate',
  '--store': 'storePath',
  '--bars': 'barStoreRoot',
  '--constituents': 'constituentsPath',
  '--fx': 'fxPath',
  '--cfd-catalogue': 'cfdCataloguePath',
};

const DEFAULTS: Omit<ReplayCliOptions, 'tradingDate'> = {
  storePath: V2_STORE_PATH,
  barStoreRoot: DEFAULT_BAR_STORE_ROOT,
  constituentsPath: CONSTITUENTS_PATH,
  fxPath: FX_PATH,
  cfdCataloguePath: CFD_CATALOGUE_PATH,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseReplayArgs(argv: readonly string[]): ReplayCliOptions {
  const parsed: Partial<Record<keyof ReplayCliOptions, string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = FLAGS[argv[index] ?? ''];
    const value = argv[index + 1];
    if (key === undefined || value === undefined) {
      throw new Error(`unknown or valueless argument ${argv[index]}`);
    }
    parsed[key] = value;
  }
  return { ...DEFAULTS, ...parsed, tradingDate: requiredDate(parsed.tradingDate) };
}

function requiredDate(value: string | undefined): string {
  if (value === undefined || !DATE.test(value)) throw new Error('--date YYYY-MM-DD is required');
  return value;
}

const SILENT: Logger = { log: () => {} };

export async function replayFromFiles(
  options: ReplayCliOptions,
  openStore: (path: string) => StoreHandle = openReadOnlyStore,
): Promise<ReplayResult> {
  const db = openStore(options.storePath);
  try {
    const { bars, prime } = barsSourceFor({ barStoreRoot: options.barStoreRoot });
    await prime();
    return await replayDay({
      db,
      tradingDate: options.tradingDate,
      bars,
      constituents: constituentsFromCsv({ constituentsPath: options.constituentsPath }),
      market: new BarsMarketData(bars, parseBoeGbpUsdCsv(readFileSync(options.fxPath, 'utf8'))),
      catalogue: cfdCatalogueFor({ cfdCataloguePath: options.cfdCataloguePath }, SILENT),
    });
  } finally {
    db.close();
  }
}

export async function main(
  argv: readonly string[],
  write: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  replay = replayFromFiles,
): Promise<number> {
  const redact = redactor(knownSecretsFrom(env));
  try {
    const result = await replay(parseReplayArgs(argv));
    write(formatReplay(result, redact));
    return result.divergences.length === 0 ? 0 : 1;
  } catch (error) {
    write(redact(`replay failed: ${errorMessage(error)}`));
    return 1;
  }
}

await setExitCodeWhenInvoked(import.meta.url, () => main(process.argv.slice(2), console.log));
