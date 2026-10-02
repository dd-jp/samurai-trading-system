import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import { type Logger, readSeededFile } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openReadOnlyStore } from '../../shared/store/index.js';
import { errorMessage, setExitCodeWhenInvoked } from '../../tools/cli-entrypoint.js';
import {
  BarsMarketData,
  CFD_CATALOGUE_PATH,
  parseBoeGbpUsdCsv,
  type VenueSessionGate,
} from './data/index.js';
import {
  barsSourceFor,
  CONSTITUENTS_PATH,
  cfdCatalogueFor,
  constituentsFromCsv,
  FX_PATH,
  halfSpreadLookup,
  knownSecretsFrom,
  SAXO_SPREADS_PATH,
  SPREADS_PATH,
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
  readonly spreadsPath: string;
  readonly saxoSpreadsPath: string;
  readonly venueSessions?: VenueSessionGate | undefined;
}

type FlagOption = Exclude<keyof ReplayCliOptions, 'venueSessions'>;

const FLAGS: Readonly<Record<string, FlagOption>> = {
  '--date': 'tradingDate',
  '--store': 'storePath',
  '--bars': 'barStoreRoot',
  '--constituents': 'constituentsPath',
  '--fx': 'fxPath',
  '--cfd-catalogue': 'cfdCataloguePath',
  '--spreads': 'spreadsPath',
  '--saxo-spreads': 'saxoSpreadsPath',
};

const DEFAULTS: Omit<ReplayCliOptions, 'tradingDate'> = {
  storePath: V2_STORE_PATH,
  barStoreRoot: DEFAULT_BAR_STORE_ROOT,
  constituentsPath: CONSTITUENTS_PATH,
  fxPath: FX_PATH,
  cfdCataloguePath: CFD_CATALOGUE_PATH,
  spreadsPath: SPREADS_PATH,
  saxoSpreadsPath: SAXO_SPREADS_PATH,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseReplayArgs(argv: readonly string[]): ReplayCliOptions {
  const parsed: Partial<Record<FlagOption, string>> = {};
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
      market: new BarsMarketData(bars, parseBoeGbpUsdCsv(readSeededFile(options.fxPath))),
      catalogue: cfdCatalogueFor({ cfdCataloguePath: options.cfdCataloguePath }, SILENT),
      halfSpreadBps: halfSpreadLookup(options.spreadsPath, options.saxoSpreadsPath),
      venueSessions: options.venueSessions,
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
