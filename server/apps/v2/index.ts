import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type {
  AnthropicMessagesClient,
  LlmSpendSink,
  SpendCap,
} from '../../pipeline/debate-engine/index.js';
import { SqliteLlmSpendStore } from '../../pipeline/debate-engine/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import { AlpacaNewsClient } from '../../providers/market-intelligence/sources/alpaca-news-client.js';
import type { Clock, Logger } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import { NousAccountInFlightGate, tryNousEndpoint } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { backupFor, type CommandRunner, execRunner, withBackup } from './backup.js';
import { composeCycle } from './compose.js';
import { type CycleReport, runCycle } from './cycle.js';
import {
  AlpacaNewsSource,
  BarsMarketData,
  type BarsSource,
  currentConstituents,
  type NewsSource,
  NO_NEWS,
  ParquetBarsSource,
  parseBoeGbpUsdCsv,
} from './data/index.js';
import type { AlpacaBrokerClient } from './execution/index.js';
import { heartbeatFor, withHeartbeat } from './heartbeat.js';
import type { Journal } from './journal/index.js';
import type { CapitalConfigStore, PaperBooks } from './risk/index.js';
import {
  ALL_PINS,
  BULLISH_SCRIPT,
  buildLlmPanel,
  createDebateSleeve,
  type LlmPanel,
  type ModelPin,
  NousPinnedTransport,
  ScriptedTransport,
  type SleeveRegistry,
  SqliteMonthlySpendCap,
  verifyNousPins,
} from './signal/index.js';

export const V2_STORE_PATH = 'data/samurai-v2-paper.sqlite';
export const V2_DRY_RUN_STORE_PATH = 'data/samurai-v2-dry-run.sqlite';
export const CONSTITUENTS_PATH = 'data/bars/sp500-constituents.csv';
export const SPREADS_PATH = 'data/bars/alpaca-spreads.csv';
export const FX_PATH = 'data/bars/fx/gbpusd-boe-xudluss.csv';
export const DEFAULT_HALF_SPREAD_BPS = 5;
const LLM_MAX_IN_FLIGHT_PER_ACCOUNT = 1;
const LLM_EXPECTED_CALL_MS = 20_000;

export interface V2RootOptions {
  readonly tradingDate: string;
  readonly dryRun: boolean;
  readonly storePath?: string | undefined;
  readonly store?: StoreHandle | undefined;
  readonly barStoreRoot?: string | undefined;
  readonly constituentsPath?: string | undefined;
  readonly spreadsPath?: string | undefined;
  readonly fxPath?: string | undefined;
  readonly nousBaseUrl?: string | undefined;
  readonly nousApiKey?: string | undefined;
  readonly samuraiMode?: string | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
  readonly bars?: BarsSource | undefined;
  readonly constituents?: ((tradingDate: string) => readonly string[]) | undefined;
  readonly transportFor?: ((pin: ModelPin) => AnthropicMessagesClient) | undefined;
  readonly alpacaClient?: AlpacaBrokerClient | undefined;
  readonly newsSource?: NewsSource | undefined;
}

export interface V2Root {
  readonly registry: SleeveRegistry;
  readonly books: PaperBooks;
  readonly capital: CapitalConfigStore;
  readonly journal: Journal;
  readonly panel: LlmPanel;
  readonly db: StoreHandle;
  readonly scriptedTransports: readonly ScriptedTransport[];
  run(): Promise<CycleReport>;
  close(): void;
}

export function llmKeysPresent(options: V2RootOptions): boolean {
  return (options.nousBaseUrl ?? '').trim() !== '' && (options.nousApiKey ?? '').trim() !== '';
}

export function nousOptionsFrom(
  env: NodeJS.ProcessEnv,
): Pick<V2RootOptions, 'nousBaseUrl' | 'nousApiKey'> {
  const endpoint = tryNousEndpoint('debate', env);
  return { nousBaseUrl: endpoint?.baseUrl, nousApiKey: endpoint?.apiKey };
}

function nousTransportFactory(
  options: V2RootOptions,
  logger: Logger,
): (pin: ModelPin) => AnthropicMessagesClient {
  const accountGate = new NousAccountInFlightGate({
    maxInFlight: LLM_MAX_IN_FLIGHT_PER_ACCOUNT,
    expectedCallMs: LLM_EXPECTED_CALL_MS,
    logger,
  });
  return (pin) =>
    new NousPinnedTransport({
      pin,
      apiKey: options.nousApiKey ?? '',
      baseUrl: options.nousBaseUrl ?? '',
      gate: accountGate,
      logger,
    });
}

function refuseKeylessPaperRun(options: V2RootOptions): void {
  if (options.dryRun || options.transportFor !== undefined || llmKeysPresent(options)) return;
  throw new Error(
    'v2 root refuses a paper run without NOUS_BASE_URL and a Nous key (NOUS_DEBATE_API_KEY or NOUS_API_KEY): scripted verdicts never reach a broker',
  );
}

function transportsFor(
  options: V2RootOptions,
  scripted: ScriptedTransport[],
  logger: Logger,
): (pin: ModelPin) => AnthropicMessagesClient {
  if (options.transportFor !== undefined) return options.transportFor;
  if (!options.dryRun) return nousTransportFactory(options, logger);
  logger.log({
    trace_id: 'v2-root',
    stage: 'v2',
    level: 'warn',
    event: 'v2_llm_transport_scripted',
    message: 'dry run: LLM transports are scripted, Nous is not called',
  });
  return (pin) => {
    const transport = new ScriptedTransport(pin, BULLISH_SCRIPT);
    scripted.push(transport);
    return transport;
  };
}

function halfSpreadLookup(path: string): (instrument: string) => number {
  const spreads = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
    const [symbol, , bps] = line.split(',');
    if (symbol !== undefined && Number(bps) >= 0) spreads.set(symbol.trim(), Number(bps));
  }
  return (instrument) => spreads.get(instrument) ?? DEFAULT_HALF_SPREAD_BPS;
}

function constituentsFromCsv(options: V2RootOptions): (tradingDate: string) => readonly string[] {
  const csv = readFileSync(options.constituentsPath ?? CONSTITUENTS_PATH, 'utf8');
  return (tradingDate) => currentConstituents(csv, tradingDate);
}

function newsSourceFor(options: V2RootOptions): NewsSource {
  if (options.newsSource !== undefined) return options.newsSource;
  return options.dryRun ? NO_NEWS : new AlpacaNewsSource(new AlpacaNewsClient());
}

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
};

function refuseLiveMode(options: V2RootOptions): void {
  if (options.samuraiMode === 'live') {
    throw new Error('v2 root refuses SAMURAI_MODE=live: nothing has passed the gate (doc 66 Q10)');
  }
}

function storePathFor(options: V2RootOptions): string {
  return options.storePath ?? (options.dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH);
}

function barsSourceFor(options: V2RootOptions): {
  bars: BarsSource;
  prime: () => Promise<void>;
} {
  if (options.bars !== undefined) return { bars: options.bars, prime: () => Promise.resolve() };
  const bars = new ParquetBarsSource(options.barStoreRoot ?? DEFAULT_BAR_STORE_ROOT, 'alpaca');
  return { bars, prime: () => bars.prime() };
}

export function composeV2Root(options: V2RootOptions): V2Root {
  refuseLiveMode(options);
  refuseKeylessPaperRun(options);
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? STDERR_LOGGER;
  const news = newsSourceFor(options);
  const db = options.store ?? openSharedStore(storePathFor(options));
  const scripted: ScriptedTransport[] = [];
  const spendSink: LlmSpendSink = new SqliteLlmSpendStore(db, logger, true);
  const spendCap: SpendCap = new SqliteMonthlySpendCap(db, clock, undefined, logger);
  const panel = buildLlmPanel({
    transportFor: transportsFor(options, scripted, logger),
    spendSink,
    spendCap,
    logger,
  });
  const { bars, prime } = barsSourceFor(options);
  const constituents = options.constituents ?? constituentsFromCsv(options);
  const market = new BarsMarketData(
    bars,
    parseBoeGbpUsdCsv(readFileSync(options.fxPath ?? FX_PATH, 'utf8')),
  );
  const cycle = composeCycle({
    db,
    clock,
    logger,
    market,
    sleeves: [
      createDebateSleeve({
        panel,
        bars,
        constituents,
        venueFor: () => 'alpaca',
        news,
        clock,
        logger,
      }),
    ],
    openingDate: options.tradingDate,
    tradingDate: () => options.tradingDate,
    dryRun: options.dryRun,
    halfSpreadBps: halfSpreadLookup(options.spreadsPath ?? SPREADS_PATH),
    alpacaClient: options.alpacaClient,
  });
  return {
    registry: cycle.registry,
    books: cycle.books,
    capital: cycle.capital,
    journal: cycle.journal,
    panel,
    db,
    scriptedTransports: scripted,
    run: async () => {
      await prime();
      return runCycle(cycle, options.tradingDate);
    },
    close: () => db.close(),
  };
}

export function parseCliArgs(
  argv: readonly string[],
  today: string,
): { dryRun: boolean; tradingDate: string } {
  let dryRun = false;
  let tradingDate = today;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--date') {
      tradingDate = dateArgument(argv[index + 1]);
      index += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return { dryRun, tradingDate };
}

function dateArgument(value: string | undefined): string {
  if (value === undefined) throw new Error('--date needs a YYYY-MM-DD value');
  return value;
}

export function exitCodeFor(report: CycleReport): number {
  return report.dry_run && report.submitted_orders > 0 ? 1 : 0;
}

export async function runAfterPinCheck(
  root: Pick<V2Root, 'run'>,
  pinCheck: () => Promise<void>,
): Promise<CycleReport> {
  await pinCheck();
  return root.run();
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  litestream: CommandRunner = execRunner,
): Promise<number> {
  const heartbeat = heartbeatFor(argv, env, fetch, STDERR_LOGGER);
  return withHeartbeat(() => {
    const clock = new SystemClock();
    const { dryRun, tradingDate } = parseCliArgs(argv, clock.now().toISOString().slice(0, 10));
    const backup = backupFor(argv, V2_STORE_PATH, env, litestream, STDERR_LOGGER);
    return withBackup(() => runOnce(dryRun, tradingDate, env, clock), backup);
  }, heartbeat);
}

async function runOnce(
  dryRun: boolean,
  tradingDate: string,
  env: NodeJS.ProcessEnv,
  clock: Clock,
): Promise<number> {
  const nous = nousOptionsFrom(env);
  const root = composeV2Root({
    tradingDate,
    dryRun,
    ...nous,
    samuraiMode: env.SAMURAI_MODE,
    clock,
  });
  try {
    const report = await runAfterPinCheck(root, () =>
      verifyNousPins({
        dryRun,
        baseUrl: nous.nousBaseUrl,
        apiKey: nous.nousApiKey,
        pins: ALL_PINS,
        logger: STDERR_LOGGER,
      }),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCodeFor(report);
  } finally {
    root.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    });
}
