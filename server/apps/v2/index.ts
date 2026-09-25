import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type {
  AnthropicMessagesClient,
  LlmSpendSink,
  SpendCap,
} from '../../pipeline/debate-engine/index.js';
import { SqliteLlmSpendStore } from '../../pipeline/debate-engine/index.js';
import type { AlpacaBrokerClient, BrokerAdapter } from '../../pipeline/execution/index.js';
import {
  AlpacaBrokerAdapter,
  AlpacaHttpBrokerClient,
  SqliteBrokerStateStore,
} from '../../pipeline/execution/index.js';
import type { DailyBar } from '../../pipeline/momentum/index.js';
import { AlpacaNewsClient } from '../../providers/market-intelligence/sources/alpaca-news-client.js';
import type { Clock, Logger } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import { NousAccountInFlightGate, tryNousEndpoint } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { PaperBooks } from './books.js';
import { type CycleReport, runCycle } from './cycle.js';
import { createDebateSleeve } from './debate-sleeve.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { parseBoeGbpUsdCsv, yearStartGbpUsd } from './fx.js';
import { Journal } from './journal.js';
import { buildLlmPanel, type LlmPanel } from './llm-panel.js';
import { NousPinnedTransport } from './llm-transport.js';
import { ALL_PINS, type ModelPin } from './models.js';
import { SqliteMonthlySpendCap } from './monthly-spend-cap.js';
import { AlpacaNewsSource, type NewsSource, NO_NEWS } from './news.js';
import { verifyNousPins } from './nous-pin-check.js';
import {
  DEBATE_RISK_FRACTION,
  DEBATE_TARGET_ATR_MULTIPLE,
  DEBATE_TIME_STOP_TRADING_DAYS,
} from './parameters.js';
import { BULLISH_SCRIPT, ScriptedTransport } from './scripted-transport.js';
import { SleeveRegistry } from './sleeve.js';
import { type BarsSource, barsBefore, CsvBarsSource, currentConstituents } from './universe.js';

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

function alpacaPaperBroker(
  options: V2RootOptions,
  db: StoreHandle,
  clock: Clock,
  logger: Logger,
): BrokerAdapter {
  return new AlpacaBrokerAdapter({
    client: options.alpacaClient ?? new AlpacaHttpBrokerClient({ environment: 'paper' }),
    state: new SqliteBrokerStateStore(db),
    unpricedFillAlerts: {
      postUnpricedFillAlert: (alert) =>
        Promise.resolve(logAlert(logger, 'v2_unpriced_fill', alert)),
    },
    ocoDoubleFillAlerts: {
      postOcoDoubleFillAlert: (alert) =>
        Promise.resolve(logAlert(logger, 'v2_oco_double_fill', alert)),
    },
    clock,
    logger,
  });
}

function lastBarBefore(
  bars: BarsSource,
): (instrument: string, tradingDate: string) => DailyBar | undefined {
  return (instrument, tradingDate) => {
    const series = bars.load(instrument);
    return series === undefined ? undefined : barsBefore(series, tradingDate).at(-1);
  };
}

function constituentsFromCsv(options: V2RootOptions): (tradingDate: string) => readonly string[] {
  const csv = readFileSync(options.constituentsPath ?? CONSTITUENTS_PATH, 'utf8');
  return (tradingDate) => currentConstituents(csv, tradingDate);
}

function newsSourceFor(options: V2RootOptions): NewsSource {
  if (options.newsSource !== undefined) return options.newsSource;
  return options.dryRun ? NO_NEWS : new AlpacaNewsSource(new AlpacaNewsClient());
}

function logAlert(logger: Logger, event: string, alert: unknown): void {
  logger.log({
    trace_id: 'v2-root',
    stage: 'v2',
    level: 'error',
    event,
    message: event,
    payload: alert,
  });
}

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
};

export function composeV2Root(options: V2RootOptions): V2Root {
  if (options.samuraiMode === 'live') {
    throw new Error('v2 root refuses SAMURAI_MODE=live: nothing has passed the gate (doc 66 Q10)');
  }
  refuseKeylessPaperRun(options);
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? STDERR_LOGGER;
  const news = newsSourceFor(options);
  const db = openSharedStore(
    options.storePath ?? (options.dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH),
  );
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
  const bars = options.bars ?? new CsvBarsSource(options.barsDirectory ?? BARS_DIRECTORY);
  const bar = lastBarBefore(bars);
  const constituents = options.constituents ?? constituentsFromCsv(options);
  const fx = parseBoeGbpUsdCsv(readFileSync(options.fxPath ?? FX_PATH, 'utf8'));
  const books = new PaperBooks(v2Store, clock);
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
  const simulatedBroker = new DryRunBrokerAdapter({
    halfSpreadBps: halfSpreadLookup(options.spreadsPath ?? SPREADS_PATH),
    markPrice: (instrument) => bar(instrument, options.tradingDate)?.rawClose,
    clock,
  });
  const brokers = options.dryRun ? {} : { alpaca: alpacaPaperBroker(options, db, clock, logger) };
  return {
    registry,
    books,
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
          brokers,
          simulatedBroker,
          bar,
          gbpUsdAtYearStart: yearStartGbpUsd(fx, Number(options.tradingDate.slice(0, 4))),
          riskFraction: DEBATE_RISK_FRACTION,
          targetAtrMultiple: DEBATE_TARGET_ATR_MULTIPLE,
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
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--date needs a YYYY-MM-DD value');
      tradingDate = value;
      index += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return { dryRun, tradingDate };
}

export function exitCodeFor(report: CycleReport): number {
  return report.dry_run && report.submitted_orders > 0 ? 1 : 0;
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
    await verifyNousPins({
      dryRun,
      baseUrl: nous.nousBaseUrl,
      apiKey: nous.nousApiKey,
      pins: ALL_PINS,
      logger: STDERR_LOGGER,
    });
    const report = await root.run();
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
