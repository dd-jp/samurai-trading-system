import { existsSync, readFileSync } from 'node:fs';
import type { BrokerMode, CfdCosts, Sleeve } from '../../../contracts/index.js';
import type {
  AnthropicMessagesClient,
  LlmSpendSink,
  SpendCap,
} from '../../pipeline/debate-engine/index.js';
import { SqliteLlmSpendStore } from '../../pipeline/debate-engine/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import { UsEquityRegularHoursCalendar } from '../../providers/market-data-service/index.js';
import { AlpacaNewsClient } from '../../providers/market-intelligence/index.js';
import type { Clock, Logger } from '../../shared/index.js';
import { describeThrownSafely, SystemClock } from '../../shared/index.js';
import { NousAccountInFlightGate, tryNousEndpoint } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { guardedStore, openSharedStore } from '../../shared/store/index.js';
import { errorStack, runWhenInvoked } from '../../tools/cli-entrypoint.js';
import { type AlertFetch, alertsFor, withAlerts } from './alerts.js';
import { backupFor, type CommandRunner, execRunner, withBackup } from './backup.js';
import { type BarRefresh, barRefreshFor } from './bar-refresh.js';
import { composeCycle } from './compose.js';
import { type CycleReport, runCycle } from './cycle.js';
import { pushDailySummary } from './daily-summary.js';
import {
  AlpacaNewsSource,
  BarsMarketData,
  type BarsSource,
  bothVenuesClosed,
  CFD_CATALOGUE_PATH,
  type CfdCatalogue,
  createVenueRouter,
  currentConstituents,
  loadCfdCatalogue,
  MarketauxClient,
  MarketauxNewsSource,
  MultiVenueBarsSource,
  macroGate,
  type NewsSource,
  NO_NEWS,
  newsForVenue,
  ParquetBarsSource,
  parseBoeGbpUsdCsv,
  SqliteNewsLedger,
  TABLE_VENUE_SESSIONS,
  type VenueSessionGate,
} from './data/index.js';
import type { AlpacaBrokerClient } from './execution/index.js';
import { saxoSessionRefusal, saxoTokenSecrets } from './execution/index.js';
import { heartbeatFor, withHeartbeat } from './heartbeat.js';
import { type FaultLedger, Journal } from './journal/index.js';
import {
  assertArm2RunsBesideDebate,
  assertCapitalShares,
  type CapitalConfigStore,
  type PaperBooks,
} from './risk/index.js';
import { describeHolder, type LeaseWait, RunLease, withRunLease } from './run-lease.js';
import {
  ALL_PINS,
  ARM2_SLEEVE_ID,
  BULLISH_SCRIPT,
  buildLlmPanel,
  CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  cfdEntryRefusal,
  createArm2Sleeve,
  createDebateSleeve,
  createSignalsSleeve,
  DEBATE_SLEEVE_ID,
  declaredCfdCosts,
  isLseInstrument,
  type LlmPanel,
  type ModelPin,
  NousPinnedTransport,
  ScriptedTransport,
  type SecretSource,
  type SleeveRegistry,
  SqliteMonthlySpendCap,
  secretsFromEnv,
  verifyNousPins,
} from './signal/index.js';
import { processDueSignals, type SignalOutcome, signalsDue } from './signals/processor.js';
import type { SignalStore } from './signals/store.js';

export const V2_STORE_PATH = 'data/samurai-v2-paper.sqlite';
export const V2_DRY_RUN_STORE_PATH = 'data/samurai-v2-dry-run.sqlite';
export const CONSTITUENTS_PATH = 'data/bars/sp500-constituents.csv';
export const SPREADS_PATH = 'data/bars/alpaca-spreads.csv';
export const SAXO_SPREADS_PATH = 'data/bars/saxo-spreads.csv';
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
  readonly saxoSpreadsPath?: string | undefined;
  readonly fxPath?: string | undefined;
  readonly cfdCataloguePath?: string | undefined;
  readonly cfdCatalogue?: CfdCatalogue | undefined;
  readonly cfdCosts?: CfdCosts | undefined;
  readonly cfdEntryRefusal?: (() => string | undefined) | undefined;
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
  readonly marketauxApiKey?: string | undefined;
  readonly isUkStock?: ((symbol: string) => boolean) | undefined;
  readonly lseLegRefusal?: string | undefined;
  readonly knownSecrets?: SecretSource | undefined;
  readonly leaseWait?: LeaseWait | undefined;
  readonly sessionCalendar?: { isOpen(instant: Date): boolean } | undefined;
  readonly venueSessions?: VenueSessionGate | undefined;
  readonly runStartedAt?: Date | undefined;
}

export interface V2Root {
  readonly registry: SleeveRegistry;
  readonly books: PaperBooks;
  readonly capital: CapitalConfigStore;
  readonly journal: Journal;
  readonly faults: FaultLedger;
  readonly panel: LlmPanel;
  readonly db: StoreHandle;
  readonly scriptedTransports: readonly ScriptedTransport[];
  run(): Promise<CycleReport>;
  processSignals(signals: SignalProcessorStore, now: Date): Promise<SignalPass>;
  close(): void;
}

export type SignalProcessorStore = Pick<SignalStore, 'due' | 'appendEvent'>;

export type SignalPass =
  | { readonly ran: true; readonly outcomes: readonly SignalOutcome[] }
  | { readonly ran: false; readonly reason: 'nothing_due' | 'lease_held'; readonly detail: string };

// The 07:30 cycle can wait behind a signals pass (a few LLM calls); well past that, the holder is
// taken to be wedged and the cycle fails loudly instead of running beside it
const CYCLE_LEASE_TIMEOUT_MS = 15 * 60 * 1000;
const CYCLE_LEASE_POLL_MS = 5_000;

const SYSTEM_LEASE_WAIT: LeaseWait = {
  timeoutMs: CYCLE_LEASE_TIMEOUT_MS,
  pollMs: CYCLE_LEASE_POLL_MS,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMs: () => Date.now(),
};

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
      secrets: options.knownSecrets ?? knownSecretsFrom(process.env),
      logger,
    });
}

export function knownSecretsFrom(env: NodeJS.ProcessEnv): SecretSource {
  return () => [...secretsFromEnv(env), ...saxoTokenSecrets()];
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

function addAlpacaSpreads(spreads: Map<string, number>, path: string): void {
  for (const line of readFileSync(path, 'utf8').split('\n').slice(1)) {
    const [symbol, , bps] = line.split(',');
    if (symbol !== undefined && Number(bps) >= 0) spreads.set(symbol.trim(), Number(bps));
  }
}

function addSaxoSpreads(spreads: Map<string, number>, path: string): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  const p25Index = lines[0]?.split(',').indexOf('p25_half_spread_bps') ?? -1;
  if (p25Index < 0) return;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const symbol = cells[0];
    const bps = Number(cells[p25Index]);
    if (symbol !== undefined && bps >= 0) spreads.set(symbol.trim(), bps);
  }
}

export function halfSpreadLookup(
  alpacaPath: string,
  saxoPath: string,
): (instrument: string) => number {
  const spreads = new Map<string, number>();
  addAlpacaSpreads(spreads, alpacaPath);
  addSaxoSpreads(spreads, saxoPath);
  return (instrument) => spreads.get(instrument) ?? DEFAULT_HALF_SPREAD_BPS;
}

function constituentsFromCsv(options: V2RootOptions): (tradingDate: string) => readonly string[] {
  const csv = readFileSync(options.constituentsPath ?? CONSTITUENTS_PATH, 'utf8');
  return (tradingDate) => currentConstituents(csv, tradingDate);
}

function marketauxClientFor(apiKey: string | undefined): MarketauxClient | undefined {
  return apiKey === undefined || apiKey === '' ? undefined : new MarketauxClient(apiKey);
}

export interface NewsWiring {
  readonly news: NewsSource;
  readonly ukNews: MarketauxNewsSource | undefined;
}

export function newsWiringFor(options: V2RootOptions, db: StoreHandle, logger: Logger): NewsWiring {
  if (options.newsSource !== undefined) return { news: options.newsSource, ukNews: undefined };
  const ukNews = options.dryRun
    ? undefined
    : new MarketauxNewsSource({
        client: marketauxClientFor(options.marketauxApiKey),
        ledger: new SqliteNewsLedger(guardedStore(db, 'v2')),
        logger,
      });
  const news = newsForVenue({
    us: options.dryRun ? NO_NEWS : new AlpacaNewsSource(new AlpacaNewsClient()),
    ukStock: ukNews ?? NO_NEWS,
    isUkStock: options.isUkStock ?? (() => false),
    isLseEtf: isLseInstrument,
  });
  return { news, ukNews };
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

function brokerModeFor(options: V2RootOptions): BrokerMode {
  return options.samuraiMode === 'live' ? 'live' : 'paper';
}

function storePathFor(options: V2RootOptions): string {
  return options.storePath ?? (options.dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH);
}

function barsSourceFor(options: V2RootOptions): {
  bars: BarsSource;
  prime: () => Promise<void>;
} {
  if (options.bars !== undefined) return { bars: options.bars, prime: () => Promise.resolve() };
  const root = options.barStoreRoot ?? DEFAULT_BAR_STORE_ROOT;
  const alpaca = new ParquetBarsSource(root, 'alpaca');
  const saxo = new ParquetBarsSource(root, 'saxo', { optional: true });
  return {
    bars: new MultiVenueBarsSource([alpaca, saxo]),
    prime: async () => {
      await alpaca.prime();
      await saxo.prime();
    },
  };
}

export function withoutRefusedLse(sleeve: Sleeve, refusal: string | undefined): Sleeve {
  if (refusal === undefined) return sleeve;
  return {
    ...sleeve,
    universe(context) {
      const universe = sleeve.universe(context);
      return {
        ...universe,
        instruments: universe.instruments.filter((symbol) => !isLseInstrument(symbol)),
      };
    },
  };
}

function journalLseLegRefusal(
  journal: Pick<Journal, 'recordRefusal'>,
  tradingDate: string,
  refusal: string | undefined,
): void {
  if (refusal === undefined) return;
  journal.recordRefusal({
    trading_date: tradingDate,
    scope: 'data',
    parameter: 'SAXO_SESSION',
    ticket: '#1876',
    message: `LSE leg refused: ${refusal}`,
  });
}

function cfdCatalogueFor(options: V2RootOptions, logger: Logger): CfdCatalogue | undefined {
  if (options.cfdCatalogue !== undefined) return options.cfdCatalogue;
  try {
    return loadCfdCatalogue(options.cfdCataloguePath ?? CFD_CATALOGUE_PATH);
  } catch (error) {
    logger.log({
      trace_id: 'v2-root',
      stage: 'v2',
      level: 'warn',
      event: 'v2_cfd_catalogue_unreadable',
      message: `CFD catalogue unreadable, every CFD route refused: ${describeThrownSafely(error)}`,
    });
    return undefined;
  }
}

function cfdCostsFor(options: V2RootOptions): CfdCosts | undefined {
  return options.cfdCosts ?? declaredCfdCosts();
}

function venueSessionsFor(options: V2RootOptions): VenueSessionGate {
  return options.venueSessions ?? TABLE_VENUE_SESSIONS;
}

function quotedBorrowPerDayFrom(
  catalogue: CfdCatalogue | undefined,
): (instrument: string) => number | undefined {
  return (instrument) => catalogue?.lookup(instrument)?.borrowCostPerDay;
}

function cfdGateFor(options: V2RootOptions): () => string | undefined {
  return options.cfdEntryRefusal ?? cfdEntryRefusal;
}

function lastMarkedDate(books: Pick<PaperBooks, 'ids' | 'lastDay'>): string | undefined {
  let latest: string | undefined;
  for (const bookId of books.ids()) {
    const date = books.lastDay(bookId)?.tradingDate;
    if (date !== undefined && (latest === undefined || date > latest)) latest = date;
  }
  return latest;
}

export async function recordingRefusedCycle<T>(
  faults: Pick<FaultLedger, 'record'>,
  tradingDate: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    faults.record({
      kind: 'refused_cycle',
      trading_date: tradingDate,
      code: 'v2_cycle_failed',
      detail: describeThrownSafely(error),
    });
    throw error;
  }
}

export function composeV2Root(options: V2RootOptions): V2Root {
  refuseLiveMode(options);
  refuseKeylessPaperRun(options);
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? STDERR_LOGGER;
  const db = options.store ?? openSharedStore(storePathFor(options));
  const { news, ukNews } = newsWiringFor(options, db, logger);
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
  const venueFor = (symbol: string) => (isLseInstrument(symbol) ? 'saxo' : 'alpaca');
  const cfdGate = cfdGateFor(options);
  const catalogue = cfdCatalogueFor(options, logger);
  const router = createVenueRouter({
    catalogue,
    entryRefusal: cfdGate,
    maxBorrowRatePerYear: CFD_SHORT_MAX_BORROW_RATE_PER_YEAR,
  });
  const sleeves = [
    createDebateSleeve({
      panel,
      bars,
      constituents,
      venueFor,
      router,
      market,
      news,
      clock,
      logger,
      lseLegRefusal: options.lseLegRefusal,
    }),
    createArm2Sleeve({
      bars,
      constituents,
      venueFor,
      router,
      market,
      clock,
      lseLegRefusal: options.lseLegRefusal,
    }),
    createSignalsSleeve(),
  ].map((sleeve) => withoutRefusedLse(sleeve, options.lseLegRefusal));
  assertArm2RunsBesideDebate(sleeves, DEBATE_SLEEVE_ID, ARM2_SLEEVE_ID);
  assertCapitalShares(sleeves);
  const cycle = composeCycle({
    db,
    clock,
    logger,
    market,
    sleeves,
    openingDate: options.tradingDate,
    tradingDate: () => options.tradingDate,
    dryRun: options.dryRun,
    halfSpreadBps: halfSpreadLookup(
      options.spreadsPath ?? SPREADS_PATH,
      options.saxoSpreadsPath ?? SAXO_SPREADS_PATH,
    ),
    alpacaClient: options.alpacaClient,
    cfdCosts: cfdCostsFor(options),
    quotedCfdBorrowPerDay: quotedBorrowPerDayFrom(catalogue),
    cfdEntryRefusal: cfdGate,
    brokerMode: brokerModeFor(options),
    venueSessions: venueSessionsFor(options),
    runStartedAt: options.runStartedAt,
  });
  const lease = new RunLease(db, clock);
  return {
    registry: cycle.registry,
    books: cycle.books,
    capital: cycle.capital,
    journal: cycle.journal,
    faults: cycle.faults,
    panel,
    db,
    scriptedTransports: scripted,
    run: () =>
      recordingRefusedCycle(cycle.faults, options.tradingDate, async () => {
        await prime();
        journalLseLegRefusal(cycle.journal, options.tradingDate, options.lseLegRefusal);
        return withRunLease(lease, 'cycle', options.leaseWait ?? SYSTEM_LEASE_WAIT, async () => {
          cycle.faults.recordMissedRuns(
            () => lastMarkedDate(cycle.books),
            options.tradingDate,
            bothVenuesClosed,
          );
          try {
            return await runCycle(cycle, options.tradingDate);
          } finally {
            ukNews?.journalCoverage(options.tradingDate);
          }
        });
      }),
    processSignals: async (signals, now) => {
      const deps = {
        cycle,
        latestReconcile: (date: string, venue: 'alpaca') =>
          cycle.journal.latestReconcile(date, venue),
        signals,
        panel,
        constituents,
        calendar: options.sessionCalendar ?? new UsEquityRegularHoursCalendar(),
      };
      if (!signalsDue(deps, now)) {
        return { ran: false, reason: 'nothing_due', detail: 'market closed or no signal due' };
      }
      const release = lease.tryAcquire('signals');
      if (release === undefined) {
        return { ran: false, reason: 'lease_held', detail: describeHolder(lease.current()) };
      }
      try {
        await prime();
        return { ran: true, outcomes: await processDueSignals(deps, now) };
      } finally {
        release();
      }
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
  fetchImpl: AlertFetch = fetch,
  barRefresh?: BarRefresh,
): Promise<number> {
  const alerts = alertsFor(argv, env, fetchImpl, STDERR_LOGGER);
  const logger = alerts.logger;
  const heartbeat = heartbeatFor(argv, env, fetchImpl, logger);
  return withAlerts(
    () =>
      withHeartbeat(() => {
        const clock = new SystemClock();
        const { dryRun, tradingDate } = parseCliArgs(argv, clock.now().toISOString().slice(0, 10));
        const backup = backupFor(argv, V2_STORE_PATH, env, litestream, logger);
        // barRefresh is constructed lazily, inside the callback withBackup invokes after restore,
        // so a paper run without Alpaca keys still restores the store before it refuses
        return withBackup(
          () =>
            runOnce(
              dryRun,
              tradingDate,
              env,
              clock,
              logger,
              barRefresh ?? barRefreshFor(dryRun, env, tradingDate, CONSTITUENTS_PATH, logger),
              alerts.notify,
            ),
          backup,
        );
      }, heartbeat),
    alerts,
  );
}

export function logNewRefusals(
  journal: Pick<Journal, 'newRefusals'>,
  tradingDate: string,
  logger: Logger,
): void {
  const refusals = journal.newRefusals(tradingDate);
  if (refusals.length === 0) return;
  logger.log({
    trace_id: `v2-${tradingDate}`,
    stage: 'v2',
    level: 'warn',
    event: 'v2_new_refusals',
    message: refusals.map((refusal) => `${refusal.parameter}: ${refusal.message}`).join('\n'),
  });
}

export function logFaultFreeWeeks(
  faults: Pick<FaultLedger, 'faultFreeWeeks'>,
  tradingDate: string,
  logger: Logger,
): void {
  const tally = faults.faultFreeWeeks(tradingDate);
  const last =
    tally.last_fault === undefined ? 'no fault recorded' : `last fault ${tally.last_fault}`;
  logger.log({
    trace_id: `v2-${tradingDate}`,
    stage: 'v2',
    level: 'info',
    event: 'v2_fault_free_weeks',
    message: `${tally.weeks} fault-free weeks (${tally.counted_days} counted days, ${last})`,
    payload: tally,
  });
}

export function rootOptionsFor(
  dryRun: boolean,
  tradingDate: string,
  env: NodeJS.ProcessEnv,
  clock: Clock,
  logger: Logger,
): V2RootOptions {
  return {
    tradingDate,
    dryRun,
    ...nousOptionsFrom(env),
    samuraiMode: env.SAMURAI_MODE,
    marketauxApiKey: env.MARKETAUX_API_KEY,
    clock,
    logger,
    lseLegRefusal: saxoSessionRefusal(clock.now()),
    knownSecrets: knownSecretsFrom(env),
  };
}

function closedDayReport(tradingDate: string, dryRun: boolean): CycleReport {
  return {
    trading_date: tradingDate,
    dry_run: dryRun,
    skipped: true,
    macro: macroGate(tradingDate),
    sleeves: [],
    decisions: 0,
    entries: 0,
    exits: 0,
    fills: 0,
    submitted_orders: 0,
    simulated_orders: 0,
    dry_run_refusals: 0,
    rejected_orders: 0,
    refusals: [`${tradingDate}: US and LSE both closed, cycle skipped`],
    books: [],
  };
}

function skipClosedDay(
  report: CycleReport,
  storePath: string,
  clock: Clock,
  logger: Logger,
): number {
  const db = openSharedStore(storePath);
  try {
    new Journal(guardedStore(db, 'v2'), clock).recordRefusal({
      trading_date: report.trading_date,
      scope: 'cycle',
      parameter: 'venues_closed',
      ticket: '#1933',
      message: report.refusals.join('; '),
    });
  } finally {
    db.close();
  }
  logger.log({
    trace_id: `v2-${report.trading_date}`,
    stage: 'v2',
    level: 'info',
    event: 'v2_cycle_venues_closed',
    message: report.refusals.join('; '),
    payload: report,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCodeFor(report);
}

export async function runOnce(
  dryRun: boolean,
  tradingDate: string,
  env: NodeJS.ProcessEnv,
  clock: Clock,
  logger: Logger,
  barRefresh: BarRefresh,
  notify: (text: string) => Promise<void>,
  compose: (options: V2RootOptions) => V2Root = composeV2Root,
): Promise<number> {
  const runStartedAt = clock.now();
  if (bothVenuesClosed(tradingDate)) {
    const storePath = storePathFor({ tradingDate, dryRun });
    return skipClosedDay(closedDayReport(tradingDate, dryRun), storePath, clock, logger);
  }
  await barRefresh.run();
  const nous = nousOptionsFrom(env);
  const root = compose({
    ...rootOptionsFor(dryRun, tradingDate, env, clock, logger),
    runStartedAt,
  });
  try {
    const report = await runAfterPinCheck(root, () =>
      verifyNousPins({
        dryRun,
        baseUrl: nous.nousBaseUrl,
        apiKey: nous.nousApiKey,
        pins: ALL_PINS,
        logger,
        secrets: knownSecretsFrom(env),
      }),
    );
    logNewRefusals(root.journal, tradingDate, logger);
    logFaultFreeWeeks(root.faults, tradingDate, logger);
    await pushDailySummary(
      {
        db: root.db,
        clock,
        faults: root.faults,
        mode: dryRun ? 'dry-run' : 'paper',
        logger,
        notify,
      },
      report,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCodeFor(report);
  } finally {
    root.close();
  }
}

void runWhenInvoked(import.meta.url, () => main(process.argv.slice(2), process.env), errorStack);
