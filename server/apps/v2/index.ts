import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type {
  AnthropicMessagesClient,
  LlmSpendSink,
  SpendCap,
} from '../../pipeline/debate-engine/index.js';
import { SqliteLlmSpendStore } from '../../pipeline/debate-engine/index.js';
import { AlpacaNewsClient } from '../../providers/market-intelligence/sources/alpaca-news-client.js';
import type { Clock, Logger } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import { NousAccountInFlightGate, tryNousEndpoint } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { type CycleReport, runCycle } from './cycle.js';
import {
  AlpacaNewsSource,
  BarsMarketData,
  type BarsSource,
  CsvBarsSource,
  currentConstituents,
  type NewsSource,
  NO_NEWS,
  parseBoeGbpUsdCsv,
} from './data/index.js';
import {
  type AlpacaBrokerClient,
  alpacaPaperBroker,
  type BrokerAdapter,
  DryRunBrokerAdapter,
  V2OrderExecutor,
} from './execution/index.js';
import { Journal } from './journal/index.js';
import { CapitalConfigStore, PaperBooks, V2RiskGate } from './risk/index.js';
import {
  ALL_PINS,
  BULLISH_SCRIPT,
  buildLlmPanel,
  createDebateSleeve,
  DEBATE_RISK_FRACTION,
  DEBATE_TARGET_ATR_MULTIPLE,
  DEBATE_TIME_STOP_TRADING_DAYS,
  type LlmPanel,
  type ModelPin,
  NousPinnedTransport,
  ScriptedTransport,
  SleeveRegistry,
  SqliteMonthlySpendCap,
  verifyNousPins,
} from './signal/index.js';

export const V2_STORE_PATH = 'data/samurai-v2-paper.sqlite';
export const V2_DRY_RUN_STORE_PATH = 'data/samurai-v2-dry-run.sqlite';
export const BARS_DIRECTORY = 'data/bars/alpaca';
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
  readonly barsDirectory?: string | undefined;
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

function barsSourceFor(options: V2RootOptions): BarsSource {
  return options.bars ?? new CsvBarsSource(options.barsDirectory ?? BARS_DIRECTORY);
}

function simulatedBrokerFor(
  options: V2RootOptions,
  market: BarsMarketData,
  clock: Clock,
): BrokerAdapter {
  return new DryRunBrokerAdapter({
    halfSpreadBps: halfSpreadLookup(options.spreadsPath ?? SPREADS_PATH),
    markPrice: (instrument) => market.lastBarBefore(instrument, options.tradingDate)?.rawClose,
    clock,
  });
}

function executorFor(
  options: V2RootOptions,
  db: StoreHandle,
  market: BarsMarketData,
  clock: Clock,
  logger: Logger,
): V2OrderExecutor {
  const brokers = options.dryRun
    ? {}
    : { alpaca: alpacaPaperBroker({ client: options.alpacaClient, db, clock, logger }) };
  return new V2OrderExecutor({
    brokers,
    simulatedBroker: simulatedBrokerFor(options, market, clock),
    dryRun: options.dryRun,
  });
}

export function composeV2Root(options: V2RootOptions): V2Root {
  refuseLiveMode(options);
  refuseKeylessPaperRun(options);
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? STDERR_LOGGER;
  const news = newsSourceFor(options);
  const db = options.store ?? openSharedStore(storePathFor(options));
  const v2Store = guardedStore(db, 'v2');
  const scripted: ScriptedTransport[] = [];
  const spendSink: LlmSpendSink = new SqliteLlmSpendStore(db, logger, true);
  const spendCap: SpendCap = new SqliteMonthlySpendCap(db, clock, undefined, logger);
  const panel = buildLlmPanel({
    transportFor: transportsFor(options, scripted, logger),
    spendSink,
    spendCap,
    logger,
  });
  const bars = barsSourceFor(options);
  const constituents = options.constituents ?? constituentsFromCsv(options);
  const market = new BarsMarketData(
    bars,
    parseBoeGbpUsdCsv(readFileSync(options.fxPath ?? FX_PATH, 'utf8')),
  );
  const capital = new CapitalConfigStore(v2Store, clock);
  const books = new PaperBooks(v2Store, clock, capital, options.tradingDate);
  const journal = new Journal(v2Store, clock);
  const registry = new SleeveRegistry();
  registry.register(
    createDebateSleeve({
      panel,
      bars,
      constituents,
      venueFor: () => 'alpaca',
      news,
      clock,
      logger,
    }),
  );
  const risk = new V2RiskGate({
    books,
    capital,
    market,
    riskFraction: DEBATE_RISK_FRACTION,
    targetAtrMultiple: DEBATE_TARGET_ATR_MULTIPLE,
  });
  const executor = executorFor(options, db, market, clock, logger);
  return {
    registry,
    books,
    capital,
    journal,
    panel,
    db,
    scriptedTransports: scripted,
    run: () =>
      runCycle(
        {
          registry,
          books,
          journal,
          risk,
          executor,
          market,
          timeStopTradingDays: DEBATE_TIME_STOP_TRADING_DAYS,
          clock,
          dryRun: options.dryRun,
          logger,
        },
        options.tradingDate,
      ),
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

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const clock = new SystemClock();
  const { dryRun, tradingDate } = parseCliArgs(argv, clock.now().toISOString().slice(0, 10));
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
