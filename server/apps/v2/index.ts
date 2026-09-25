import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type {
  AnthropicMessagesClient,
  LlmSpendSink,
  SpendCap,
} from '../../pipeline/debate-engine/index.js';
import { SqliteLlmSpendStore } from '../../pipeline/debate-engine/index.js';
import type { BrokerAdapter } from '../../pipeline/execution/index.js';
import { AlpacaBrokerAdapter, AlpacaHttpBrokerClient } from '../../pipeline/execution/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import { NousAccountInFlightGate } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { AnthropicHttpTransport } from './anthropic-transport.js';
import { PaperBooks } from './books.js';
import { type CycleReport, runCycle } from './cycle.js';
import { createDebateSleeve } from './debate-sleeve.js';
import { DryRunBrokerAdapter } from './dry-run-broker.js';
import { parseBoeGbpUsdCsv, yearStartGbpUsd } from './fx.js';
import { Journal } from './journal.js';
import { buildLlmPanel, type LlmPanel } from './llm-panel.js';
import type { ModelPin } from './models.js';
import { SqliteMonthlySpendCap } from './monthly-spend-cap.js';
import { OpenRouterHttpTransport } from './openrouter-transport.js';
import { DEBATE_RISK_FRACTION, DEBATE_TARGET_ATR_MULTIPLE, isSet } from './parameters.js';
import { SaxoPaperBrokerAdapter } from './saxo-paper-adapter.js';
import { BULLISH_SCRIPT, ScriptedTransport } from './scripted-transport.js';
import { SleeveRegistry } from './sleeve.js';
import { type BarsSource, CsvBarsSource, currentConstituents } from './universe.js';

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
  readonly anthropicApiKey?: string | undefined;
  readonly openrouterApiKey?: string | undefined;
  readonly samuraiMode?: string | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
  readonly bars?: BarsSource | undefined;
  readonly constituents?: ((tradingDate: string) => readonly string[]) | undefined;
  readonly transportFor?: ((pin: ModelPin) => AnthropicMessagesClient) | undefined;
  readonly brokers?: Partial<Record<'alpaca' | 'saxo', BrokerAdapter>> | undefined;
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
  return (options.anthropicApiKey ?? '') !== '' && (options.openrouterApiKey ?? '') !== '';
}

function httpTransportFactory(options: V2RootOptions): (pin: ModelPin) => AnthropicMessagesClient {
  const gates = {
    anthropic: new NousAccountInFlightGate({
      maxInFlight: LLM_MAX_IN_FLIGHT_PER_ACCOUNT,
      expectedCallMs: LLM_EXPECTED_CALL_MS,
      logger: options.logger,
    }),
    openrouter: new NousAccountInFlightGate({
      maxInFlight: LLM_MAX_IN_FLIGHT_PER_ACCOUNT,
      expectedCallMs: LLM_EXPECTED_CALL_MS,
      logger: options.logger,
    }),
  };
  return (pin) =>
    pin.provider === 'anthropic'
      ? new AnthropicHttpTransport({
          apiKey: options.anthropicApiKey ?? '',
          pin,
          gate: gates.anthropic,
          logger: options.logger,
        })
      : new OpenRouterHttpTransport({
          apiKey: options.openrouterApiKey ?? '',
          pin,
          gate: gates.openrouter,
          logger: options.logger,
        });
}

function transportsFor(
  options: V2RootOptions,
  scripted: ScriptedTransport[],
): (pin: ModelPin) => AnthropicMessagesClient {
  if (options.transportFor !== undefined) return options.transportFor;
  if (!options.dryRun) {
    if (!llmKeysPresent(options)) {
      throw new Error(
        'v2 root refuses a paper run without ANTHROPIC_API_KEY and OPENROUTER_API_KEY: scripted verdicts never reach a broker',
      );
    }
    return httpTransportFactory(options);
  }
  options.logger?.log({
    trace_id: 'v2-root',
    stage: 'v2',
    level: 'warn',
    event: 'v2_llm_transport_scripted',
    message: 'dry run: LLM transports are scripted, no provider is called',
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

function brokersFor(
  options: V2RootOptions,
  clock: Clock,
  logger: Logger,
): Record<'alpaca' | 'saxo', BrokerAdapter> {
  if (options.dryRun) return { alpaca: new DryRunBrokerAdapter(), saxo: new DryRunBrokerAdapter() };
  const saxo =
    options.brokers?.saxo ??
    new SaxoPaperBrokerAdapter({
      clock,
      halfSpreadBps: halfSpreadLookup(options.spreadsPath ?? SPREADS_PATH),
    });
  const alpaca =
    options.brokers?.alpaca ??
    new AlpacaBrokerAdapter({
      client: new AlpacaHttpBrokerClient({ environment: 'paper' }),
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
  return { alpaca, saxo };
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
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? STDERR_LOGGER;
  const db = openSharedStore(
    options.storePath ?? (options.dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH),
  );
  const v2Store = guardedStore(db, 'v2');
  const scripted: ScriptedTransport[] = [];
  const spendSink: LlmSpendSink = new SqliteLlmSpendStore(db, logger, true);
  const spendCap: SpendCap = new SqliteMonthlySpendCap(db, clock, undefined, logger);
  const panel = buildLlmPanel({
    transportFor: transportsFor(options, scripted),
    spendSink,
    spendCap,
    logger,
  });
  const bars = options.bars ?? new CsvBarsSource(options.barsDirectory ?? BARS_DIRECTORY);
  const constituentsCsv =
    options.constituents === undefined
      ? readFileSync(options.constituentsPath ?? CONSTITUENTS_PATH, 'utf8')
      : '';
  const constituents =
    options.constituents ?? ((date: string) => currentConstituents(constituentsCsv, date));
  const fx = parseBoeGbpUsdCsv(readFileSync(options.fxPath ?? FX_PATH, 'utf8'));
  const books = new PaperBooks(v2Store, clock);
  const journal = new Journal(v2Store, clock);
  const registry = new SleeveRegistry();
  registry.register(
    createDebateSleeve({ panel, bars, constituents, venueFor: () => 'alpaca', clock, logger }),
  );
  const brokers = brokersFor(options, clock, logger);
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
          gbpUsdAtYearStart: yearStartGbpUsd(fx, Number(options.tradingDate.slice(0, 4))),
          riskFraction: isSet(DEBATE_RISK_FRACTION) ? DEBATE_RISK_FRACTION.value : undefined,
          targetAtrMultiple: isSet(DEBATE_TARGET_ATR_MULTIPLE)
            ? DEBATE_TARGET_ATR_MULTIPLE.value
            : undefined,
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

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const clock = new SystemClock();
  const { dryRun, tradingDate } = parseCliArgs(argv, clock.now().toISOString().slice(0, 10));
  const root = composeV2Root({
    tradingDate,
    dryRun,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    samuraiMode: env.SAMURAI_MODE,
    clock,
  });
  try {
    const report = await root.run();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.submitted_orders > 0 && dryRun ? 1 : 0;
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
