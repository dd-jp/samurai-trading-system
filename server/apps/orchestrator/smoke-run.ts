import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  type ArmComparison,
  type ArmPerformance,
  SqliteArmComparisonSource,
} from '../../pipeline/control-arm/index.js';
import type {
  AssetClass,
  LlmClient,
  LlmRequest,
  LlmResponse,
  PromptTierAlert,
  RateLimiterSnapshot,
} from '../../pipeline/debate-engine/index.js';
import {
  DEBATE_BAR_TIMEFRAME_MS,
  floorToBar,
  MAX_ROUNDS_BY_ASSET_CLASS,
  RateLimiter,
  SqliteLlmSpendStore,
} from '../../pipeline/debate-engine/index.js';
import type {
  AlpacaBrokerClient,
  AlpacaLimitOrderRequest,
  AlpacaOrder,
  AlpacaStopLimitOrderRequest,
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionResult,
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  ReconcileDivergence,
  ReconcileReport,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from '../../pipeline/execution/index.js';
import {
  ALERT_AFTER_CONSECUTIVE_ZERO_SIZE,
  AlpacaBrokerAdapter,
  FILLED_WITH_ZERO_SIZE,
  FilledZeroSizeThrottle,
  SimulatedBrokerAdapter,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
  TERMINAL_SWEEP_AGE_MS,
  UnrecordedVenuePositionThrottle,
} from '../../pipeline/execution/index.js';
import {
  assertKillThresholdsWithinBounds,
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  runArmComparisonCycle,
  runOutsideBenchmarkCycle,
  SqliteArmComparisonSampleStore,
  SqliteFeedbackCycleScheduleStore,
  SqliteOutsideBenchmarkSampleStore,
  SqliteTuningStore,
} from '../../pipeline/feedback-loop/index.js';
import type {
  BenchmarkObservation,
  BenchmarkSeriesSource,
} from '../../pipeline/outside-benchmark/index.js';
import type {
  BreakerConfig,
  RiskConfig,
  RiskDecision,
  SessionBasisByClass,
} from '../../pipeline/risk-manager/index.js';
import {
  CircuitBreakers,
  RiskManagerImpl,
  resolveRiskConfig,
} from '../../pipeline/risk-manager/index.js';
import type {
  ApprovalChannel,
  VerdictConfig,
  VerdictDecision,
} from '../../pipeline/verdict/index.js';
import { VerdictImpl } from '../../pipeline/verdict/index.js';
import type {
  Bar,
  LseMarkClient,
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import {
  AlwaysOpenCalendar,
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import {
  CURATED_MACRO_MARKETS,
  GDELT_MACRO_ENTITY,
  GdeltGkgClient,
  type MarketIntelligenceStore,
  MiArchiveStore,
  POLYMARKET_ASSET_CLASS,
  PolymarketClient,
  PROJECTED_COLUMNS,
  type RawArchiveRow,
  SOURCE_GDELT,
  SOURCE_POLYMARKET,
} from '../../providers/market-intelligence/index.js';
import type {
  ContinueOnFaultEffects,
  ErrorStream as FaultGuardErrorStream,
  StdoutStream as FaultGuardStdoutStream,
  OpenPosition,
  OrderIntent,
  TradingArm,
} from '../../shared/index.js';
import {
  boundFor,
  delay,
  GUARDED_THRESHOLD_NAMES,
  isThresholdBoundViolation,
  SimulatedClock,
  TokenBucket,
  toBrokerFillId,
} from '../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import type { CostConfig, CostModel } from '../../tools/backtest/index.js';
import { CostModelImpl } from '../../tools/backtest/index.js';
import {
  installDashboardContinueOnFault,
  watchDashboardStdout,
} from '../service-api/fault-guard.js';
import { SqliteQueryStore } from '../service-api/sqlite-query-store.js';
import { installSupervisorContinueOnFault, watchSupervisorStdout } from '../supervisor/index.js';
import { loggingAlertChannel } from './alert-catalogue.js';
import type { AlertChannels } from './alert-transport.js';
import {
  FILL_SYNC_POLL_FAILED,
  FILL_SYNC_RECONCILE_FAILED,
  FILL_SYNC_SWEEP_FAILED,
} from './fill-sync.js';
import { installFaultHandlers, runEntrypointLogRetention, startFromEnvironment } from './index.js';
import { buildEntrypointLogger, JsonLogger, type StdoutStream } from './logger.js';
import {
  buildStartingProfileConfigs,
  LIVE_BOOK_SIZING_USD,
  paperStartingProfile,
} from './paper-profile.js';
import type { DataFailoverAlert } from './production/data-failover.js';
import { worstCaseLlmCallsForAssetClass } from './production/debate-adapter.js';
import type { AccountStateProvider } from './production/direct-bind.js';
import { buildExecutionSurface } from './production/direct-bind.js';
import {
  buildProductionComponents,
  buildProductionOrchestrator,
  SMOKE_TEST_UNIVERSE,
} from './production.js';
import type { LogEntry, Logger, UniverseInstrument } from './types.js';

const SMOKE_GDELT_SEED_BUCKETS = 24;
const SMOKE_GDELT_SEED_PER_BUCKET = 2;
const SMOKE_GDELT_SEED_SIGNAL_ROWS = 5;
const SMOKE_GDELT_SEEDED_ROWS =
  SMOKE_GDELT_SEED_BUCKETS * SMOKE_GDELT_SEED_PER_BUCKET + SMOKE_GDELT_SEED_SIGNAL_ROWS;

function seedSmokeGdeltBaseline(archive: MiArchiveStore): void {
  const bar = floorToBar(SMOKE_RUN_INSTANT, DEBATE_BAR_TIMEFRAME_MS);
  const hourMs = 60 * 60 * 1000;
  const line = (tone: number): string => {
    const columns = Array.from({ length: 27 }, () => '');
    columns[0] = 'smoke-seed';
    columns[1] = '20260804120000';
    columns[3] = 'smoke.seed';
    columns[4] = 'https://smoke.test/seed';
    columns[7] = 'ECON_INTEREST_RATES';
    columns[15] = `${tone},2.0,0.5,2.5,20,0.1,400`;
    return PROJECTED_COLUMNS.map((column) => columns[column] ?? '').join('\t');
  };
  const rows: RawArchiveRow[] = [];
  const push = (at: number, tone: number, id: string): void => {
    rows.push({
      source: SOURCE_GDELT,
      native_id: `smoke-seed-${id}`,
      updated_at: new Date(at),
      payload: line(tone),
      ingested_at: new Date(at),
      fidelity: 'live',
    });
  };
  const baselineStart = bar.getTime() - (SMOKE_GDELT_SEED_BUCKETS + 1) * hourMs;
  for (let bucket = 0; bucket < SMOKE_GDELT_SEED_BUCKETS; bucket += 1) {
    for (let n = 0; n < SMOKE_GDELT_SEED_PER_BUCKET; n += 1) {
      push(baselineStart + bucket * hourMs + n * 60_000, 0, `b${bucket}-${n}`);
    }
  }
  for (let n = 0; n < SMOKE_GDELT_SEED_SIGNAL_ROWS; n += 1) {
    push(bar.getTime() - hourMs + n * 60_000, 1, `s${n}`);
  }
  archive.write(rows, []);
}

export const SMOKE_GDELT_EXPECTED_ROWS = SMOKE_GDELT_SEEDED_ROWS + 1;

const SMOKE_GDELT_ASSET_CLASSES: readonly AssetClass[] = [
  ...new Set(SMOKE_TEST_UNIVERSE.map((instrument) => instrument.asset_class)),
];

export const SMOKE_GDELT_EXPECTED_AGGREGATES = SMOKE_GDELT_ASSET_CLASSES.length;

function smokeGdeltClient(): GdeltGkgClient {
  const stamp = '20260804114500';
  const url = `http://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`;
  const lastupdate = [
    `44212 c2b1cae80b87a07106acb37a837c014d http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`,
    `61450 e86d6493d86819b56d5cc413828825df http://data.gdeltproject.org/gdeltv2/${stamp}.mentions.CSV.zip`,
    `3370784 f7c5359b15d09d7e931f8338cd6a7e60 ${url}`,
  ].join('\n');
  const row = (id: string, themes: string, tone: string): string => {
    const columns = Array.from({ length: 27 }, () => '');
    columns[0] = id;
    columns[1] = stamp;
    columns[3] = 'smoke.test';
    columns[4] = 'https://smoke.test/a';
    columns[7] = themes;
    columns[15] = tone;
    return columns.join('\t');
  };
  const csv = [
    row(`${stamp}-1`, 'ECON_STOCKMARKET;EPU_ECONOMY', '1.5,2.0,0.5,2.5,20,0.1,400'),
    row(`${stamp}-2`, 'SOC_GENERALCRIME', '-3.0,0.5,3.5,4.0,18,0.2,250'),
  ].join('\n');

  const name = Buffer.from(`${stamp}.gkg.csv`);
  const uncompressed = Buffer.from(csv);
  const deflated = deflateRawSync(uncompressed);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(uncompressed), 14);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  const archive = Buffer.concat([header, name, deflated]);

  return new GdeltGkgClient({
    fetchImpl: (async (input: string | URL) =>
      String(input).endsWith('lastupdate.txt')
        ? new Response(lastupdate)
        : new Response(archive)) as unknown as typeof fetch,
  });
}

const SMOKE_POLYMARKET_EXPECTED_ITEMS = 1;

function smokePolymarketClient(): PolymarketClient {
  const [healthy, thin] = CURATED_MACRO_MARKETS;
  const marketFor = (slug: string, volume24hr: number): Record<string, unknown> => ({
    slug,
    question: 'Smoke macro market',
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.34", "0.66"]',
    clobTokenIds: '["token-yes", "token-no"]',
    bestBid: 0.65,
    bestAsk: 0.66,
    spread: 0.01,
    volume24hr,
    liquidityNum: 250_000,
    updatedAt: new Date(SMOKE_RUN_INSTANT.getTime() - 5 * 60_000).toISOString(),
    closed: false,
  });

  const eventsFor = (slug: string): unknown[] => {
    if (healthy !== undefined && slug === healthy.eventSlug) {
      return [{ slug, markets: [marketFor(healthy.marketSlug, 533_307)] }];
    }
    if (thin !== undefined && slug === thin.eventSlug) {
      return [{ slug, markets: [marketFor(thin.marketSlug, 5)] }];
    }
    return [];
  };

  const history = Array.from({ length: 25 }, (_, index) => ({
    t: Math.floor((SMOKE_RUN_INSTANT.getTime() - (24 - index) * 60 * 60_000) / 1000),
    p: 0.6 + (0.06 * index) / 24,
  }));

  return new PolymarketClient({
    fetchImpl: (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/prices-history')) {
        return new Response(JSON.stringify({ history }));
      }
      const slug = new URL(url).searchParams.get('slug') ?? '';
      return new Response(JSON.stringify(eventsFor(slug)));
    }) as unknown as typeof fetch,
  });
}

export const SMOKE_RUN_INSTANT = new Date('2026-08-04T12:00:00.000Z');

const SMOKE_INSTRUMENT = SMOKE_TEST_UNIVERSE[0]?.asset ?? 'BTC-USD';

const SMOKE_BAR_SERIES: readonly { timeframe: string; count: number; stepMs: number }[] = [
  { timeframe: '5m', count: 60, stepMs: 5 * 60 * 1_000 },
  { timeframe: '1h', count: 60, stepMs: 60 * 60 * 1_000 },
  { timeframe: '1m', count: 60, stepMs: 60_000 },
  { timeframe: '1d', count: 40, stepMs: 24 * 60 * 60 * 1_000 },
];

const SMOKE_MARK_PRICE = 160;

const SMOKE_CLOSE_CYCLE: readonly number[] = [-2, -2, -3, 3, 3, 3, 3];

export function buildTrendingCloses(count: number, lastClose: number): number[] {
  const length = SMOKE_CLOSE_CYCLE.length;
  const closes = Array.from<number>({ length: count });
  closes[count - 1] = lastClose;

  for (let step = 1; step < count; step += 1) {
    const delta = SMOKE_CLOSE_CYCLE[(((length - step) % length) + length) % length];
    const next = closes[count - step];
    if (delta === undefined || next === undefined) {
      throw new Error(`buildTrendingCloses: no close or delta at step ${step} of ${count}`);
    }
    closes[count - 1 - step] = next - delta;
  }

  return closes;
}

export function buildSmokeFixtureBars(instrument: string = SMOKE_INSTRUMENT): Bar[] {
  return SMOKE_BAR_SERIES.flatMap(({ timeframe, count, stepMs }) => {
    const closes = buildTrendingCloses(count, SMOKE_MARK_PRICE - 1);

    return Array.from({ length: count }, (_, index) => {
      const close_time = new Date(SMOKE_RUN_INSTANT.getTime() - (count - index) * stepMs);
      const close = closes[index];
      if (close === undefined) {
        throw new Error(`buildSmokeFixtureBars: no close at index ${index} of ${count}`);
      }
      return {
        instrument,
        timeframe,
        open_time: new Date(close_time.getTime() - stepMs),
        close_time,
        open: close,
        high: close + 2,
        low: close - 2,
        close,
        volume: 1_000,
        source: 'smoke-fixture',
      };
    });
  });
}

function buildSmokeClockAndDataSource() {
  const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
  const profile = paperStartingProfile('paper');
  const dataSource = new FixtureDataSource(
    buildSmokeFixtureBars(),
    { price: SMOKE_MARK_PRICE, observed_at: SMOKE_RUN_INSTANT, source: 'smoke-fixture' },
    'crypto',
    {
      bid: SMOKE_MARK_PRICE - 0.5,
      ask: SMOKE_MARK_PRICE + 0.5,
      observed_at: SMOKE_RUN_INSTANT,
    },
  );
  return { clock, profile, dataSource };
}

export const SMOKE_LLM_RESPONSE = JSON.stringify({
  stance: 'bullish',
  rationale: 'offline smoke fixture: uptrend intact, structure supports a long entry',
  converged: true,
});

export class ConstantResponseLlmClient implements LlmClient {
  calls = 0;

  constructor(private readonly rawText: string = SMOKE_LLM_RESPONSE) {}

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls += 1;
    const parsed = request.parseResponse(this.rawText);
    if (!parsed.valid) {
      throw new Error(
        `ConstantResponseLlmClient: the fixture response does not satisfy this call site's ` +
          `parser (${parsed.reason}). The stub payload and the debate schema have drifted apart.`,
      );
    }
    return { data: parsed.data, raw_text: this.rawText, latency_ms: 0 };
  }
}

export class FixedAccountStateProvider implements AccountStateProvider {
  constructor(private readonly equity: number = 100_000) {}

  async getAccountState(): Promise<{
    cash: number;
    peak_equity: number;
    daily_basis: SessionBasisByClass;
    consecutive_losses: number;
  }> {
    const flat = { known: true, open_equity: this.equity, realized_pnl: 0 } as const;

    return {
      cash: this.equity,
      peak_equity: this.equity,
      daily_basis: { crypto: flat, stocks: flat, portfolio: flat },
      consecutive_losses: 0,
    };
  }
}

export class UnreachableAlpacaClient implements AlpacaBrokerClient {
  reached = false;

  private refuse(method: string): never {
    this.reached = true;
    throw new Error(
      `UnreachableAlpacaClient.${method} was called during the offline smoke run. This run is ` +
        'credential-free and must make no network call; reaching the Alpaca wire client means ' +
        'the composition root now needs it for something the smoke run overrides. Fix the ' +
        'wiring or supply a real client deliberately — do not soften this into a stub.',
    );
  }

  async submitOrder(): Promise<never> {
    return this.refuse('submitOrder');
  }

  async getOrder(): Promise<never> {
    return this.refuse('getOrder');
  }

  async getOrderByClientOrderId(): Promise<never> {
    return this.refuse('getOrderByClientOrderId');
  }

  async getAccount(): Promise<never> {
    return this.refuse('getAccount');
  }

  async submitMarketOrder(): Promise<never> {
    return this.refuse('submitMarketOrder');
  }

  async submitOcoOrder(): Promise<never> {
    return this.refuse('submitOcoOrder');
  }

  async submitLimitOrder(): Promise<never> {
    return this.refuse('submitLimitOrder');
  }

  async submitStopLimitOrder(): Promise<never> {
    return this.refuse('submitStopLimitOrder');
  }

  async cancelOrder(): Promise<never> {
    return this.refuse('cancelOrder');
  }

  async getPositions(): Promise<never> {
    return this.refuse('getPositions');
  }

  async listOpenOrders(): Promise<never> {
    return this.refuse('listOpenOrders');
  }
}

const EXIT_PATH_INSTRUMENTS = {
  fullExit: 'ETH-USD',
  partialFlatten: 'SOL-USD',
  twoLot: 'AVAX-USD',
  crashRestart: 'DOGE-USD',
  residualSweep: 'LINK-USD',
} as const;

const PARTIAL_FLATTEN_FRACTION = 0.4;
const PRIOR_EXIT_FRACTION = 0.3;

const EXIT_PATH_LOT_SIZE = 10;

const EXIT_PATH_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

class RecordingResidualExposureAlertChannel implements ResidualExposureAlertChannel {
  readonly alerts: ResidualExposureAlert[] = [];

  constructor(private readonly inner?: ResidualExposureAlertChannel) {}

  async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
    this.alerts.push(alert);
    await this.inner?.postResidualExposureAlert(alert);
  }
}

class RecordingFlattenReconcileAlertChannel implements FlattenReconcileAlertChannel {
  readonly alerts: FlattenReconcileAlert[] = [];

  async postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

const FILL_SYNC_FAILURE_MESSAGES = [
  FILL_SYNC_RECONCILE_FAILED,
  FILL_SYNC_POLL_FAILED,
  FILL_SYNC_SWEEP_FAILED,
] as const;

type FillSyncFailureMessage = (typeof FILL_SYNC_FAILURE_MESSAGES)[number];

function isFillSyncFailureMessage(message: string): message is FillSyncFailureMessage {
  return (FILL_SYNC_FAILURE_MESSAGES as readonly string[]).includes(message);
}

export interface FillSyncFailure {
  message: FillSyncFailureMessage;
  error: string;
}

export interface FillSyncFailureEvidence {
  failures: readonly FillSyncFailure[];
}

const TOLERATED_FILL_SYNC_FAILURES: readonly string[] = [];

export function untoleratedFillSyncFailures(
  failures: readonly FillSyncFailure[],
  tolerated: readonly string[] = TOLERATED_FILL_SYNC_FAILURES,
): FillSyncFailure[] {
  const allowed = tolerated.filter((entry) => entry.length > 0);
  return failures.filter((failure) => !allowed.some((entry) => failure.error.includes(entry)));
}

export class FillSyncFailureRecorder implements Logger {
  private readonly failures: FillSyncFailure[] = [];

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.level === 'error' && isFillSyncFailureMessage(entry.message)) {
      this.failures.push({ message: entry.message, error: payloadError(entry.payload) });
    }
    this.inner.log(entry);
  }

  evidence(): FillSyncFailureEvidence {
    return { failures: [...this.failures] };
  }
}

const fillSyncProbe: Probe<'fillSync'> = {
  run({ fillSyncFailures }) {
    return fillSyncFailures.evidence();
  },
  verdict(evidence) {
    const failures: string[] = [];
    const untolerated = untoleratedFillSyncFailures(evidence.failures);
    if (untolerated.length > 0) {
      const distinct = [
        ...new Set(untolerated.map((failure) => `${failure.message}: ${failure.error}`)),
      ];
      failures.push(
        `${untolerated.length} fill-sync poll failure(s) were logged and survived — the loop keeps ` +
          'polling by design, so nothing else in this gate sees a reconcile/ingestFills/sweep path that ' +
          `rejects on every call (#1049). Distinct: ${distinct.join(' | ')}`,
      );
    }
    return failures;
  },
};

export interface MarketDataFetchEvidence {
  fetchCount: number;
  traceIds: string[];
}

export class MarketDataFetchRecorder implements Logger {
  private fetchCount = 0;
  private readonly traceIds = new Set<string>();

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.event === 'market_data_fetch') {
      this.fetchCount += 1;
      this.traceIds.add(entry.trace_id);
    }
    this.inner.log(entry);
  }

  evidence(): MarketDataFetchEvidence {
    return { fetchCount: this.fetchCount, traceIds: [...this.traceIds] };
  }
}

const marketDataFetchProbe: Probe<'marketDataFetch'> = {
  run({ marketDataFetch }) {
    return marketDataFetch.evidence();
  },
  verdict(evidence, { observations }) {
    const failures: string[] = [];
    if (evidence.fetchCount === 0) {
      failures.push(
        'zero market_data_fetch lines were recorded over the run — the store starts cold, so at ' +
          'least one venue-reaching bar fetch (and therefore one recorded miss) is guaranteed on a ' +
          'correctly wired composition root; a zero count means the `telemetry` argument was dropped ' +
          "from production.ts's primary `MarketDataServiceImpl` construction, and the market-data " +
          'path is back to emitting no telemetry at all (#1082)',
      );
    }

    const tickTraces = new Set(observations.ticks.map((tick) => tick.trace_id));
    const joined = evidence.traceIds.some((trace_id) => tickTraces.has(trace_id));
    if (tickTraces.size > 0 && evidence.fetchCount > 0 && !joined) {
      failures.push(
        'no market_data_fetch line carried a tick trace_id — every recorded fetch fell back to ' +
          "the 'market-data' category label, so the bar path's telemetry joins to no tick in " +
          'audit_log. Either `runWithTraceId` has been dropped from ' +
          'SequentialTickRunner.runInstrument, or the fetch no longer runs inside the tick',
      );
    }
    return failures;
  },
};

function payloadError(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const { error } = payload as { error?: unknown };
  return typeof error === 'string' ? error : '';
}

class ExitPathBrokerAdapter implements BrokerAdapter {
  readonly callSequence: string[] = [];
  private readonly partialFlattenFraction = new Map<string, number>();
  private readonly rearmFailuresOnce = new Set<string>();

  constructor(private readonly delegate: SimulatedBrokerAdapter) {}

  truncateFlattenFill(clientOrderId: string, fraction: number): void {
    this.partialFlattenFraction.set(clientOrderId, fraction);
  }

  failRearmOnce(clientOrderId: string): void {
    this.rearmFailuresOnce.add(clientOrderId);
  }

  private record(action: string, clientOrderId: string): void {
    this.callSequence.push(`${action}:${clientOrderId}`);
  }

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    this.record('submitBracket', order.client_order_id);
    return this.delegate.submitBracket(order);
  }

  async getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    return this.delegate.getOrder(clientOrderId, instrument);
  }

  async resumeFlatten(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null> {
    this.record('resumeFlatten', clientOrderId);
    return this.delegate.resumeFlatten(clientOrderId, instrument);
  }

  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    const fills = await this.delegate.fetchNewFills(since);
    if (this.partialFlattenFraction.size === 0) return fills;

    return fills.map((fill) => {
      const clientOrderId = fill.broker_fill_id.endsWith(':flatten')
        ? fill.broker_fill_id.slice(0, -':flatten'.length)
        : undefined;
      const fraction =
        clientOrderId === undefined ? undefined : this.partialFlattenFraction.get(clientOrderId);
      if (fraction === undefined) return fill;
      return { ...fill, qty: fill.qty * fraction, fee: fill.fee * fraction };
    });
  }

  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    this.record('resizeProtectiveLegs', clientOrderId);
    return this.delegate.resizeProtectiveLegs(clientOrderId, filledQty);
  }

  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    this.record('rearmProtectiveLegs', clientOrderId);
    if (this.rearmFailuresOnce.delete(clientOrderId)) {
      throw new Error(
        `smoke exit-path harness: scripted one-shot re-arm failure for '${clientOrderId}' (#549 scenario 5)`,
      );
    }
    return this.delegate.rearmProtectiveLegs(clientOrderId, instrument, side, qty, stop, target);
  }

  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    this.record('submitFlatten', clientOrderId);
    return this.delegate.submitFlatten(instrument, side, size, clientOrderId);
  }

  async cancel(clientOrderId: string, instrument: string): Promise<void> {
    this.record('cancel', clientOrderId);
    return this.delegate.cancel(clientOrderId, instrument);
  }

  async getOpenPositions(): ReturnType<BrokerAdapter['getOpenPositions']> {
    return this.delegate.getOpenPositions();
  }

  getProtectedQty(clientOrderId: string): number | null {
    return this.delegate.getProtectedQty(clientOrderId);
  }
}

function exitPathOrder(
  instrument: string,
  idempotencyKey: string,
  side: 'buy' | 'sell',
  intentType: 'entry' | 'exit',
  size: number,
  decisionTime: Date,
): OrderIntent {
  return {
    idempotency_key: idempotencyKey,
    instrument,
    asset_class: 'crypto',
    side,
    intent_type: intentType,
    size,
    entry: SMOKE_MARK_PRICE,
    stop: SMOKE_MARK_PRICE - 10,
    target: SMOKE_MARK_PRICE + 20,
    time_in_force: 'gtc',
    decision_timestamp: decisionTime,
    decided_at: decisionTime,
    metadata: {
      debate_id: `debate-${idempotencyKey}`,
      conviction: 0.7,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
      ...(intentType === 'exit' ? { exit_reason: 'flatten' as const } : {}),
    },
  };
}

function approvedRiskDecision(order: OrderIntent): RiskDecision {
  return {
    status: 'approved',
    order_intent: order,
    modifications: null,
    binding_constraint: null,
    reasons: [],
    warnings: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
    next_breaker_state: [],
  };
}

const EXIT_PATH_VERDICT_CONFIG: VerdictConfig = {
  ...buildStartingProfileConfigs().verdictConfig,
  max_mark_age: { crypto: 24 * 60 * 60_000, stocks: 24 * 60 * 60_000 },
};

async function exitPathVerdict(
  order: OrderIntent,
  deps: {
    marketData: MarketDataService;
    positionStore: SqliteExecutionStore;
    clock: SimulatedClock;
  },
  step: string,
): Promise<VerdictDecision> {
  const decision = await new VerdictImpl().decide({
    trace_id: 'smoke-exit-path',
    risk_decision: approvedRiskDecision(order),
    clock: deps.clock,
    marketData: deps.marketData,
    tradingCalendar: new AlwaysOpenCalendar(),
    positionStore: deps.positionStore,
    breakers: {
      portfolio_tripped: false,
      asset_class_tripped: { crypto: false, stocks: false },
      armed_breakers: [],
    },
    config: EXIT_PATH_VERDICT_CONFIG,
    mode: 'paper',
    approvals: { requestApproval: async () => 'approved' as const },
  });

  if (decision.status !== 'go') {
    throw new Error(
      `smoke exit-path harness: '${step}' was refused by Verdict ` +
        `(no_go: ${decision.no_go_reason ?? 'unknown'}) — the order never reached Execution`,
    );
  }

  return decision;
}

function assertSubmitted(result: ExecutionResult, step: string): void {
  if (result.status !== 'submitted') {
    throw new Error(
      `smoke exit-path harness: '${step}' did not submit (status=${result.status}, ` +
        `reason=${result.reason ?? 'none'}) — a scenario precondition is wrong, not the gate`,
    );
  }
}

export interface ExitPathEvidence {
  brokerCallSequence: readonly string[];
  residualAlerts: readonly ResidualExposureAlert[];
  fullExit: { lotKey: string };
  partialFlatten: {
    idempotencyKey: string;
    expectedResidual: number;
    protectedQty: number | null;
  };
  twoLotFlatten: { lotKeys: readonly string[] };
  crashRestart: { lotKey: string; flattenKey: string; reconcileReport: ReconcileReport };
  flattenReconcileAlerts: readonly FlattenReconcileAlert[];
  residualSweep: {
    lotKey: string;
    expectedResidual: number;
    protectedQty: number | null;
    markerCleared: boolean;
    sweepDivergenceAction: ReconcileDivergence['action'] | undefined;
    sweepDivergenceReason: string | undefined;
  };
  terminalSweep: {
    seededKey: string;
    rowPresentAfterSweep: boolean;
    swept: number;
  };
}

export function findSweepDivergence(
  divergences: readonly ReconcileDivergence[],
  lotKey: string,
): ReconcileDivergence | undefined {
  return divergences.find((divergence) => divergence.idempotency_key === lotKey);
}

async function runExitPathScenarios(input: {
  db: StoreHandle;
  clock: SimulatedClock;
  costConfig: CostConfig;
  executionConfig: ExecutionConfig;
  logger: Logger;
}): Promise<ExitPathEvidence> {
  const { db, clock, costConfig, executionConfig, logger } = input;

  const bars = Object.values(EXIT_PATH_INSTRUMENTS).flatMap((instrument) =>
    buildSmokeFixtureBars(instrument),
  );
  const dataSource = new FixtureDataSource(
    bars,
    { price: SMOKE_MARK_PRICE, observed_at: SMOKE_RUN_INSTANT, source: 'smoke-fixture' },
    'crypto',
    { bid: SMOKE_MARK_PRICE - 0.5, ask: SMOKE_MARK_PRICE + 0.5, observed_at: SMOKE_RUN_INSTANT },
  );
  const marketData = new MarketDataServiceImpl(
    dataSource,
    clock,
    'live',
    new SqliteMarketDataStore(db),
  );
  const costModel = new CostModelImpl(costConfig);
  const innerBroker = new SimulatedBrokerAdapter({
    clock,
    costModel,
    marketData,
    config: executionConfig.simulated,
  });
  const broker = new ExitPathBrokerAdapter(innerBroker);
  const residualAlerts = new RecordingResidualExposureAlertChannel();
  const flattenReconcileAlerts = new RecordingFlattenReconcileAlertChannel();
  const execution = buildExecutionSurface(
    {
      clock,
      broker,
      store: new SqliteExecutionStore(db),
      costModel,
      marketData,
      config: executionConfig,
      sessionCalendars: EXIT_PATH_SESSION_CALENDARS,
      residualExposureAlerts: residualAlerts,
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts,
      unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
      unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
      logger,
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    },
    'smoke-exit-path',
  );

  const tick = (): Date => {
    clock.advanceTo(new Date(clock.now().getTime() + 1_000));
    return clock.now();
  };

  const positionStore = new SqliteExecutionStore(db);

  const submit = async (order: OrderIntent, step: string): Promise<void> => {
    const verdict = await exitPathVerdict(order, { marketData, positionStore, clock }, step);
    assertSubmitted(await execution.execute(verdict), step);
  };

  const ctx: ExitPathScenarioContext = {
    db,
    clock,
    costModel,
    marketData,
    executionConfig,
    logger,
    broker,
    execution,
    positionStore,
    residualAlerts,
    flattenReconcileAlerts,
    tick,
    submit,
  };

  const fullExit = await runFullExitScenario(ctx);
  const partialFlatten = await runPartialFlattenScenario(ctx);
  const twoLotFlatten = await runTwoLotFlattenScenario(ctx);
  const crashRestartLot = await enterCrashRestartLotAheadOfResidualSweep(ctx);
  const residualSweep = await runResidualSweepScenario(ctx);
  await exitCrashRestartLotWithoutSweep(ctx, crashRestartLot.exitKey);
  const terminalSweepKey = await seedTerminalSweepRow(ctx);
  const { restarted, restartReconcile } = await restartExecutionAndReconcile(ctx);
  await restarted.ingestFills();

  const lot5MarkerRow = db
    .prepare('SELECT residual_unprotected_since FROM open_positions WHERE idempotency_key = ?')
    .get(residualSweep.lotKey) as { residual_unprotected_since: string | null } | undefined;
  const sweepDivergence = findSweepDivergence(restartReconcile.divergences, residualSweep.lotKey);

  const terminalSweepRow = db
    .prepare('SELECT 1 FROM open_positions WHERE idempotency_key = ?')
    .get(terminalSweepKey);

  return {
    brokerCallSequence: broker.callSequence,
    residualAlerts: residualAlerts.alerts,
    fullExit,
    partialFlatten: {
      idempotencyKey: partialFlatten.idempotencyKey,
      expectedResidual: partialFlatten.expectedResidual,
      protectedQty: broker.getProtectedQty(partialFlatten.idempotencyKey),
    },
    twoLotFlatten,
    crashRestart: {
      lotKey: crashRestartLot.lotKey,
      flattenKey: crashRestartLot.exitKey,
      reconcileReport: restartReconcile,
    },
    flattenReconcileAlerts: flattenReconcileAlerts.alerts,
    residualSweep: {
      lotKey: residualSweep.lotKey,
      expectedResidual: residualSweep.expectedResidual,
      protectedQty: broker.getProtectedQty(residualSweep.lotKey),
      markerCleared:
        lot5MarkerRow !== undefined && lot5MarkerRow.residual_unprotected_since === null,
      sweepDivergenceAction: sweepDivergence?.action,
      sweepDivergenceReason: sweepDivergence?.reason,
    },
    terminalSweep: {
      seededKey: terminalSweepKey,
      rowPresentAfterSweep: terminalSweepRow !== undefined,
      swept: restartReconcile.swept,
    },
  };
}

function exitPathFlattenSubmissionFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  const { flattenSubmissions } = observations;
  if (flattenSubmissions.length === 0) {
    failures.push(
      "no row in flatten_submissions — no exit ever reached executeExit()'s write-ahead journal " +
        "(#508), so #516's cancel-before-flatten guard was never exercised",
    );
  } else {
    const unresolved = flattenSubmissions.filter((row) => row.status !== 'submitted');
    if (unresolved.length > 0) {
      failures.push(
        `flatten_submissions has ${unresolved.length} row(s) not resolved to 'submitted' ` +
          `(${unresolved.map((row) => `${row.idempotency_key}:${row.status}`).join(', ')}) — an ` +
          'exit was journalled but its flatten never reached, or was refused by, the broker',
      );
    }
  }
  return failures;
}

function exitPathCancelBeforeFlattenFailures(evidence: ExitPathEvidence): string[] {
  const failures: string[] = [];
  const { brokerCallSequence } = evidence;
  let sincePreviousFlatten = 0;
  const flattensWithoutPriorCancel: string[] = [];
  for (const [index, call] of brokerCallSequence.entries()) {
    if (!call.startsWith('submitFlatten:')) continue;
    const window = brokerCallSequence.slice(sincePreviousFlatten, index);
    if (!window.some((entry) => entry.startsWith('cancel:'))) {
      flattensWithoutPriorCancel.push(call);
    }
    sincePreviousFlatten = index + 1;
  }
  if (flattensWithoutPriorCancel.length > 0) {
    failures.push(
      `broker call(s) ${flattensWithoutPriorCancel.join(', ')} have no 'cancel' call recorded ` +
        `before them (full sequence: ${brokerCallSequence.join(' -> ') || '(empty)'}) — a resting ` +
        'bracket leg cancelled after the flatten (or never) can fire into the now-flat position ' +
        'and open a reverse one (#516)',
    );
  }
  if (!brokerCallSequence.some((call) => call.startsWith('submitFlatten:'))) {
    failures.push(
      'the exit-path harness recorded no submitFlatten call at all — exits never reached ' +
        'submitFlatten (#508)',
    );
  }
  return failures;
}

function exitPathClosedTradesFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  if (observations.closedTrades.length === 0) {
    failures.push(
      'no row in closed_trades — the exit-path scenarios never round-tripped a lot to flat, so ' +
        "either a flatten's fill was never attributed back to the lot it closed (#517) or " +
        'ingestFills() never reached its round-trip-to-flat branch at all',
    );
  }
  return failures;
}

function exitPathFullExitLotFailures(
  evidence: ExitPathEvidence,
  positions: SmokeObservations['positions'],
): string[] {
  const failures: string[] = [];
  const fullExitLot = positions.find(
    (position) => position.idempotency_key === evidence.fullExit.lotKey,
  );
  if (fullExitLot === undefined || fullExitLot.order_state !== 'closed') {
    failures.push(
      `lot '${evidence.fullExit.lotKey}' (scenario 1's full exit) never reached ` +
        `order_state 'closed' (${
          fullExitLot === undefined
            ? 'no row in open_positions'
            : `state=${fullExitLot.order_state}`
        }) — the #508/#517 exit path did not round-trip it to flat`,
    );
  }
  return failures;
}

function exitPathPartialFlattenFailures(evidence: ExitPathEvidence): string[] {
  const failures: string[] = [];
  const { partialFlatten, residualAlerts, residualSweep } = evidence;
  if (partialFlatten.protectedQty === null) {
    failures.push(
      `lot '${partialFlatten.idempotencyKey}' has no protective legs armed after its partial ` +
        "flatten — the #525 residual re-arm never ran, leaving the lot's residual naked",
    );
  } else if (partialFlatten.protectedQty !== partialFlatten.expectedResidual) {
    failures.push(
      `lot '${partialFlatten.idempotencyKey}' has ${partialFlatten.protectedQty} protected after ` +
        `its partial flatten, expected the residual ${partialFlatten.expectedResidual} — the ` +
        're-arm (#525) sized the wrong quantity',
    );
  }
  const strayResidualAlerts = residualAlerts.filter(
    (alert) => alert.idempotency_key !== residualSweep.lotKey,
  );
  if (strayResidualAlerts.length > 0) {
    failures.push(
      `${strayResidualAlerts.length} residual-exposure alert(s) fired during the smoke run ` +
        `(lot(s): ${strayResidualAlerts.map((alert) => alert.idempotency_key).join(', ')}) — a ` +
        'successful re-arm posts nothing (residual-exposure-alert.ts); an alert here means the ' +
        '#525 re-arm failed on a deterministic offline broker',
    );
  }
  return failures;
}

function exitPathResidualSweepFailures(evidence: ExitPathEvidence): string[] {
  const failures: string[] = [];
  const { residualAlerts, residualSweep } = evidence;
  const scenario5Alerts = residualAlerts.filter(
    (alert) => alert.idempotency_key === residualSweep.lotKey,
  );
  if (scenario5Alerts.length !== 1) {
    failures.push(
      `scenario 5's residual episode alerted ${scenario5Alerts.length} time(s), expected exactly 1 ` +
        "(the observing poll's inline #525 alert) — 0 means the failed re-arm no longer pages at " +
        'all; more than 1 means the once-per-episode dedup (#549/#342, ' +
        'open_positions.residual_rearm_alerted_at) regressed and the sweep re-pages every pass',
    );
  }
  if (residualSweep.sweepDivergenceAction === undefined) {
    failures.push(
      `the restarted Execution's reconcile() report named no divergence for scenario 5's lot ` +
        `'${residualSweep.lotKey}' — the durable residual-protection marker (migration 0024) was ` +
        'never written by the observing poll, or SharedStore.getUnprotectedResidualLots() found ' +
        'nothing, so the #549 sweep either never ran or had nothing to find',
    );
  } else if (residualSweep.sweepDivergenceAction !== 'adopted') {
    failures.push(
      `the restarted Execution's residual-protection sweep settled scenario 5's lot with action ` +
        `'${residualSweep.sweepDivergenceAction}', not 'adopted' — the retry against a healthy ` +
        'deterministic broker should have re-armed and confirmed; anything else means the sweep ' +
        'could not settle a marker it should have (#549)',
    );
  } else if (
    !residualSweep.sweepDivergenceReason?.includes(
      `for residual ${residualSweep.expectedResidual} by the #549 sweep`,
    )
  ) {
    failures.push(
      `the lookup keyed on scenario 5's lot '${residualSweep.lotKey}' returned a divergence ` +
        `reading 'adopted', but its reason ('${residualSweep.sweepDivergenceReason}') does not ` +
        `name the #549 sweep re-arming this lot's OWN residual ` +
        `(${residualSweep.expectedResidual}) — this is the #1285 ` +
        'B2/N3 case: a lookup keyed on the WRONG lot could still land on a divergence reading ' +
        "'adopted' (another scenario's flatten-reconcile, or sweepOne's own coversQty flat-path " +
        "no-op), and binding the match to this lot's own residual quantity closes that even for a " +
        "future scenario adding a second lot through sweepOne's real re-arm branch; only " +
        "sweepOne's re-arm of THIS residual (residual-protection-sweep.ts) can satisfy this text",
    );
  }
  if (!residualSweep.markerCleared) {
    failures.push(
      `scenario 5's residual-protection marker (open_positions.residual_unprotected_since, lot ` +
        `'${residualSweep.lotKey}') is still set after the restarted reconcile() — protection was ` +
        'never CONFIRMED, so the lot would be re-swept forever (#549)',
    );
  }
  if (residualSweep.protectedQty !== residualSweep.expectedResidual) {
    failures.push(
      `lot '${residualSweep.lotKey}' has ${residualSweep.protectedQty ?? 'no'} protected after ` +
        `the #549 sweep's retry, expected the residual ${residualSweep.expectedResidual} — the ` +
        'sweep either never re-armed (the lot is naked) or sized the wrong quantity',
    );
  }
  return failures;
}

function exitPathTwoLotFlattenFailures(
  evidence: ExitPathEvidence,
  positions: SmokeObservations['positions'],
): string[] {
  const failures: string[] = [];
  const phantomOpen = evidence.twoLotFlatten.lotKeys.filter((key) => {
    const row = positions.find((position) => position.idempotency_key === key);
    return row === undefined || row.order_state !== 'closed';
  });
  if (phantomOpen.length > 0) {
    failures.push(
      `lot(s) ${phantomOpen.join(', ')} were named by a two-lot flatten but never reached ` +
        "order_state 'closed' — the #571 fill split left quantity unaccounted for on at least " +
        'one sibling lot',
    );
  }
  return failures;
}

function exitPathCrashRestartFailures(
  evidence: ExitPathEvidence,
  positions: SmokeObservations['positions'],
): string[] {
  const failures: string[] = [];
  const { crashRestart, flattenReconcileAlerts: flattenReconcileAlertsFired } = evidence;
  const crashRestartDivergence = crashRestart.reconcileReport.divergences.find(
    (divergence) => divergence.idempotency_key === crashRestart.flattenKey,
  );
  if (crashRestartDivergence === undefined) {
    failures.push(
      `the restarted Execution's reconcile() report named no divergence for scenario 4's ` +
        `flatten '${crashRestart.flattenKey}' (lot '${crashRestart.lotKey}') — ` +
        'SharedStore.getUnresolvedFlattens() found nothing to resolve, so the journal sweep ' +
        '(#519) either never ran or the row was not recognised as unresolved ' +
        `(checked=${crashRestart.reconcileReport.checked}, ` +
        `divergences=${crashRestart.reconcileReport.divergences.length})`,
    );
  } else if (crashRestartDivergence.action !== 'adopted') {
    failures.push(
      `the restarted Execution's reconcile() settled scenario 4's flatten with action ` +
        `'${crashRestartDivergence.action}', not 'adopted' (reason: ` +
        `${crashRestartDivergence.reason}) — the venue genuinely acked this flatten, so anything ` +
        "other than 'adopted' means reconcile() mis-settled a row it should have resolved cleanly",
    );
  }
  const crashRestartLot = positions.find(
    (position) => position.idempotency_key === crashRestart.lotKey,
  );
  if (crashRestartLot === undefined || crashRestartLot.order_state !== 'closed') {
    failures.push(
      `lot '${crashRestart.lotKey}' (scenario 4's crash-restart flatten) never reached ` +
        `order_state 'closed' after the restarted Execution's reconcile() + ingestFills() ` +
        `(${crashRestartLot === undefined ? 'no row in open_positions' : `state=${crashRestartLot.order_state}`}) ` +
        "— reconcile()'s flatten sweep did not re-establish the fill-sweep worklist the way " +
        '#519/#526 require',
    );
  }
  if (flattenReconcileAlertsFired.length > 0) {
    failures.push(
      `${flattenReconcileAlertsFired.length} flatten-reconcile alert(s) fired during the smoke ` +
        `run (flatten(s): ${flattenReconcileAlertsFired.map((alert) => alert.idempotency_key).join(', ')}) ` +
        "— scenario 4's flatten resolves cleanly against a deterministic offline broker; an " +
        'alert here means reconcile() could not settle a row it should have',
    );
  }
  return failures;
}

function exitPathTerminalSweepFailures(evidence: ExitPathEvidence): string[] {
  const failures: string[] = [];
  const { terminalSweep } = evidence;
  if (terminalSweep.rowPresentAfterSweep) {
    failures.push(
      `open_positions row '${terminalSweep.seededKey}' (seeded 'rejected', filled_size 0, ` +
        `decision_timestamp past TERMINAL_SWEEP_AGE_MS) is STILL present after the restarted ` +
        `reconcile() (swept=${terminalSweep.swept}) — the #1088 terminal-row sweep either never ` +
        'ran or no longer deletes what it should; a table this leaves growing forever is the ' +
        'exact defect #1088 closed',
    );
  }
  return failures;
}

const exitPathProbe: Probe<'exitPath'> = {
  async run({ db, clock, profile, logger, tickLoopResidualAlerts }) {
    const harness = await runExitPathScenarios({
      db,
      clock,
      costConfig: profile.costConfig,
      executionConfig: profile.executionConfig,
      logger,
    });
    return {
      ...harness,
      residualAlerts: [...tickLoopResidualAlerts.alerts, ...harness.residualAlerts],
    };
  },
  verdict(evidence, { observations }) {
    const { positions } = observations;
    const failures: string[] = [];
    failures.push(...exitPathFlattenSubmissionFailures(observations));
    failures.push(...exitPathCancelBeforeFlattenFailures(evidence));
    failures.push(...exitPathClosedTradesFailures(observations));
    failures.push(...exitPathFullExitLotFailures(evidence, positions));
    failures.push(...exitPathPartialFlattenFailures(evidence));
    failures.push(...exitPathResidualSweepFailures(evidence));
    failures.push(...exitPathTwoLotFlattenFailures(evidence, positions));
    failures.push(...exitPathCrashRestartFailures(evidence, positions));
    failures.push(...exitPathTerminalSweepFailures(evidence));
    return failures;
  },
};

interface ExitPathScenarioContext {
  readonly db: StoreHandle;
  readonly clock: SimulatedClock;
  readonly costModel: CostModelImpl;
  readonly marketData: MarketDataService;
  readonly executionConfig: ExecutionConfig;
  readonly logger: Logger;
  readonly broker: ExitPathBrokerAdapter;
  readonly execution: ReturnType<typeof buildExecutionSurface>;
  readonly positionStore: SqliteExecutionStore;
  readonly residualAlerts: RecordingResidualExposureAlertChannel;
  readonly flattenReconcileAlerts: RecordingFlattenReconcileAlertChannel;
  readonly tick: () => Date;
  readonly submit: (order: OrderIntent, step: string) => Promise<void>;
}

type PostSweepScenarioContext = Omit<ExitPathScenarioContext, 'execution'>;

async function runFullExitScenario(ctx: ExitPathScenarioContext): Promise<{ lotKey: string }> {
  const lot1 = 'smoke-exit-full-lot';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.fullExit,
      lot1,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 1 entry',
  );
  await ctx.execution.ingestFills();
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.fullExit,
      'smoke-exit-full-exit',
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 1 exit',
  );
  await ctx.execution.ingestFills();

  return { lotKey: lot1 };
}

async function runPartialFlattenScenario(
  ctx: ExitPathScenarioContext,
): Promise<{ idempotencyKey: string; expectedResidual: number }> {
  const lot2 = 'smoke-exit-partial-lot';
  const lot2ExitKey = 'smoke-exit-partial-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.partialFlatten,
      lot2,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 2 entry',
  );
  await ctx.execution.ingestFills();
  ctx.broker.truncateFlattenFill(lot2ExitKey, PARTIAL_FLATTEN_FRACTION);
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.partialFlatten,
      lot2ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 2 exit',
  );
  await ctx.execution.ingestFills();
  const exitFillQty = EXIT_PATH_LOT_SIZE * PARTIAL_FLATTEN_FRACTION;
  const expectedResidual = EXIT_PATH_LOT_SIZE - exitFillQty;

  return { idempotencyKey: lot2, expectedResidual };
}

async function runTwoLotFlattenScenario(
  ctx: ExitPathScenarioContext,
): Promise<{ lotKeys: readonly string[] }> {
  const lot3Older = 'smoke-exit-twolot-older';
  const lot3PriorExitKey = 'smoke-exit-twolot-older-prior-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3Older,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 3 older-lot entry',
  );
  await ctx.execution.ingestFills();
  ctx.broker.truncateFlattenFill(lot3PriorExitKey, PRIOR_EXIT_FRACTION);
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3PriorExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 3 older-lot prior exit',
  );
  await ctx.execution.ingestFills();

  const lot3Newer = 'smoke-exit-twolot-newer';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      lot3Newer,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 3 newer-lot entry',
  );
  await ctx.execution.ingestFills();

  const olderPriorExitFillQty = EXIT_PATH_LOT_SIZE * PRIOR_EXIT_FRACTION;
  const olderHeld = EXIT_PATH_LOT_SIZE - olderPriorExitFillQty;
  const twoLotFlattenSize = olderHeld + EXIT_PATH_LOT_SIZE;
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.twoLot,
      'smoke-exit-twolot-flatten',
      'sell',
      'exit',
      twoLotFlattenSize,
      ctx.tick(),
    ),
    'scenario 3 two-lot flatten',
  );
  await ctx.execution.ingestFills();

  return { lotKeys: [lot3Older, lot3Newer] };
}

async function enterCrashRestartLotAheadOfResidualSweep(
  ctx: ExitPathScenarioContext,
): Promise<{ lotKey: string; exitKey: string }> {
  const lot4 = 'smoke-exit-restart-lot';
  const lot4ExitKey = 'smoke-exit-restart-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.crashRestart,
      lot4,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 4 entry',
  );
  await ctx.execution.ingestFills();

  return { lotKey: lot4, exitKey: lot4ExitKey };
}

async function runResidualSweepScenario(
  ctx: ExitPathScenarioContext,
): Promise<{ lotKey: string; expectedResidual: number }> {
  const lot5 = 'smoke-exit-sweep-lot';
  const lot5ExitKey = 'smoke-exit-sweep-exit';
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.residualSweep,
      lot5,
      'buy',
      'entry',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 5 entry',
  );
  await ctx.execution.ingestFills();
  ctx.broker.truncateFlattenFill(lot5ExitKey, PARTIAL_FLATTEN_FRACTION);
  ctx.broker.failRearmOnce(lot5);
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.residualSweep,
      lot5ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 5 exit',
  );
  await ctx.execution.ingestFills();
  const exitFillQty = EXIT_PATH_LOT_SIZE * PARTIAL_FLATTEN_FRACTION;
  const expectedResidual = EXIT_PATH_LOT_SIZE - exitFillQty;

  return { lotKey: lot5, expectedResidual };
}

async function exitCrashRestartLotWithoutSweep(
  ctx: PostSweepScenarioContext,
  lot4ExitKey: string,
): Promise<void> {
  await ctx.submit(
    exitPathOrder(
      EXIT_PATH_INSTRUMENTS.crashRestart,
      lot4ExitKey,
      'sell',
      'exit',
      EXIT_PATH_LOT_SIZE,
      ctx.tick(),
    ),
    'scenario 4 exit',
  );
}

async function seedTerminalSweepRow(ctx: PostSweepScenarioContext): Promise<string> {
  const terminalSweepKey = 'smoke-terminal-sweep-target';
  const terminalSweepDecisionTimestamp = new Date(
    ctx.clock.now().getTime() - TERMINAL_SWEEP_AGE_MS - 60 * 60 * 1_000,
  );
  await ctx.positionStore.writeAheadPosition({
    idempotency_key: terminalSweepKey,
    debate_id: 'debate-smoke-terminal-sweep',
    instrument: EXIT_PATH_INSTRUMENTS.crashRestart,
    asset_class: 'crypto',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 1,
    target: 2,
    order_state: 'rejected',
    broker_order_ids: [],
    opened_at: terminalSweepDecisionTimestamp,
    decision_timestamp: terminalSweepDecisionTimestamp,
    conviction: 0.5,
    converged: true,
  });

  return terminalSweepKey;
}

async function restartExecutionAndReconcile(ctx: PostSweepScenarioContext): Promise<{
  restarted: ReturnType<typeof buildExecutionSurface>;
  restartReconcile: ReconcileReport;
}> {
  const restarted = buildExecutionSurface(
    {
      clock: ctx.clock,
      broker: ctx.broker,
      store: new SqliteExecutionStore(ctx.db),
      costModel: ctx.costModel,
      marketData: ctx.marketData,
      config: ctx.executionConfig,
      sessionCalendars: EXIT_PATH_SESSION_CALENDARS,
      residualExposureAlerts: ctx.residualAlerts,
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: ctx.flattenReconcileAlerts,
      unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
      unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
      logger: ctx.logger,
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    },
    'smoke-exit-path-restart',
  );
  const restartReconcile = await restarted.reconcile();

  return { restarted, restartReconcile };
}

class CryptoEmulationScenarioClient implements AlpacaBrokerClient {
  private readonly orders = new Map<string, AlpacaOrder>();
  private readonly idsByClientOrderId = new Map<string, string>();
  readonly cancelledOrderIds: string[] = [];
  private nextId = 1;

  private accept(request: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: string;
    client_order_id: string;
  }): AlpacaOrder {
    if (!request.symbol.endsWith('/USD')) {
      throw new Error(
        `smoke crypto-emulation scenario: order for '${request.symbol}' reached the wire in ` +
          'dash form — the adapter boundary stopped converting (#585); the live venue rejects ' +
          'this with 422 "asset not found"',
      );
    }
    const order: AlpacaOrder = {
      id: `scenario-alpaca-${this.nextId++}`,
      client_order_id: request.client_order_id,
      symbol: request.symbol,
      side: request.side,
      qty: request.qty,
      order_class: '',
      status: 'accepted',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    this.orders.set(order.id, order);
    this.idsByClientOrderId.set(request.client_order_id, order.id);
    return { ...order };
  }

  private rejectAdvancedOrderClass(method: string): never {
    throw new Error(
      `smoke crypto-emulation scenario: ${method} sent an advanced order_class for crypto — ` +
        'the live venue rejects this with 422 {"code":42210000,"message":"crypto orders not ' +
        'allowed for advanced order_class"} (verified #550). The adapter must take the ' +
        'emulated path (#586), never this one.',
    );
  }

  async submitOrder(): Promise<never> {
    this.rejectAdvancedOrderClass('submitOrder (order_class: bracket)');
  }

  async submitOcoOrder(): Promise<never> {
    this.rejectAdvancedOrderClass('submitOcoOrder (order_class: oco)');
  }

  async submitLimitOrder(request: AlpacaLimitOrderRequest): Promise<AlpacaOrder> {
    return this.accept(request);
  }

  async submitStopLimitOrder(request: AlpacaStopLimitOrderRequest): Promise<AlpacaOrder> {
    return this.accept(request);
  }

  async submitMarketOrder(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: no flatten is scripted here');
  }

  async cancelOrder(alpacaOrderId: string): Promise<void> {
    this.cancelledOrderIds.push(alpacaOrderId);
    const order = this.orders.get(alpacaOrderId);
    if (order !== undefined && order.status !== 'filled') order.status = 'canceled';
  }

  async getOrder(alpacaOrderId: string): Promise<AlpacaOrder> {
    const order = this.orders.get(alpacaOrderId);
    if (order === undefined) {
      throw new Error(`smoke crypto-emulation scenario: unknown order id '${alpacaOrderId}'`);
    }
    return { ...order };
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null> {
    const id = this.idsByClientOrderId.get(clientOrderId);
    return id === undefined ? null : this.getOrder(id);
  }

  async getPositions(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: getPositions is not scripted here');
  }

  async listOpenOrders(): Promise<AlpacaOrder[]> {
    return [...this.orders.values()]
      .filter((order) => order.status !== 'filled' && order.status !== 'canceled')
      .map((order) => ({ ...order }));
  }

  async getAccount(): Promise<never> {
    throw new Error('smoke crypto-emulation scenario: getAccount is not scripted here');
  }

  fillByClientOrderId(clientOrderId: string, price: number, filledAt: string): void {
    const id = this.idsByClientOrderId.get(clientOrderId);
    const order = id === undefined ? undefined : this.orders.get(id);
    if (order === undefined) {
      throw new Error(
        `smoke crypto-emulation scenario: cannot fill unknown client order id '${clientOrderId}'`,
      );
    }
    order.status = 'filled';
    order.filled_qty = order.qty;
    order.filled_avg_price = String(price);
    order.filled_at = filledAt;
  }

  venueOrderId(clientOrderId: string): string | undefined {
    return this.idsByClientOrderId.get(clientOrderId);
  }
}

export interface CryptoEmulationEvidence {
  journalRow:
    | {
        phase: string;
        asset_class: string | null;
        stop_order_id: string | null;
        target_order_id: string | null;
      }
    | undefined;
  entryFillSeen: boolean;
  stopFillSeen: boolean;
  siblingCancelled: boolean;
}

const CRYPTO_EMULATION_LOT_KEY = 'smoke-crypto-emulated-lot';

async function runCryptoEmulationScenario(
  db: StoreHandle,
  logger: Logger,
): Promise<CryptoEmulationEvidence> {
  const client = new CryptoEmulationScenarioClient();
  const adapter = new AlpacaBrokerAdapter({
    client,
    rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
    state: new SqliteBrokerStateStore(db),
    unpricedFillAlerts: {
      postUnpricedFillAlert: async () => {},
    },
    logger,
    ocoDoubleFillAlerts: {
      postOcoDoubleFillAlert: async (alert) => {
        throw new Error(
          `smoke crypto-emulation scenario: unexpected double-fill alert for ` +
            `'${alert.client_order_id}'`,
        );
      },
    },
  });

  const ack = await adapter.submitBracket({
    client_order_id: CRYPTO_EMULATION_LOT_KEY,
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    size: 0.5,
    entry: 60_000,
    stop: 57_000,
    target: 66_000,
    time_in_force: 'gtc',
  });
  if (ack.order_state !== 'submitted') {
    throw new Error(
      `smoke crypto-emulation scenario: entry ack was '${ack.order_state}', not 'submitted' — ` +
        'a scenario precondition is wrong, not the gate',
    );
  }

  client.fillByClientOrderId(CRYPTO_EMULATION_LOT_KEY, 60_000, '2026-01-02T00:00:00Z');
  const armSweep = await adapter.fetchNewFills(new Date(0));

  client.fillByClientOrderId(`${CRYPTO_EMULATION_LOT_KEY}:stop`, 57_000, '2026-01-02T00:01:00Z');
  const exitSweep = await adapter.fetchNewFills(new Date(0));

  const journalRow = db
    .prepare(
      'SELECT phase, asset_class, stop_order_id, target_order_id FROM broker_brackets ' +
        "WHERE venue = 'alpaca' AND client_order_id = ?",
    )
    .get(CRYPTO_EMULATION_LOT_KEY) as CryptoEmulationEvidence['journalRow'];

  const targetVenueId = client.venueOrderId(`${CRYPTO_EMULATION_LOT_KEY}:target`);
  return {
    journalRow,
    entryFillSeen: armSweep.some(
      (fill) => fill.leg === 'entry' && fill.client_order_id === CRYPTO_EMULATION_LOT_KEY,
    ),
    stopFillSeen: exitSweep.some(
      (fill) => fill.leg === 'stop' && fill.client_order_id === CRYPTO_EMULATION_LOT_KEY,
    ),
    siblingCancelled:
      targetVenueId !== undefined && client.cancelledOrderIds.includes(targetVenueId),
  };
}

const cryptoEmulationProbe: Probe<'cryptoEmulation'> = {
  run({ db, logger }) {
    return runCryptoEmulationScenario(db, logger);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const emulation = evidence;
    if (emulation.journalRow === undefined || emulation.journalRow.asset_class !== 'crypto') {
      failures.push(
        "the emulated-leg journal (broker_brackets, venue 'alpaca') has no crypto row for the " +
          "crypto-emulation scenario's lot — submitBracket stopped journalling the emulated " +
          'bracket (#586), so a crash between the entry and its protective legs leaves a live ' +
          'crypto position nothing knows to protect',
      );
    } else {
      if (
        emulation.journalRow.stop_order_id == null ||
        emulation.journalRow.target_order_id == null
      ) {
        failures.push(
          "the crypto-emulation scenario's journal row is missing protective-leg order ids after " +
            'the entry filled — the legs were never submitted as plain crypto orders (#586), so ' +
            'the filled lot sat naked',
        );
      }
      if (emulation.journalRow.phase !== 'resolved') {
        failures.push(
          `the crypto-emulation scenario's journal row ended in phase ` +
            `'${emulation.journalRow.phase}', expected 'resolved' — the emulated OCO edge ` +
            '(leg fill -> sibling cancel) did not complete (#586)',
        );
      }
    }
    if (!emulation.entryFillSeen) {
      failures.push(
        "the crypto-emulation scenario's entry fill never came back through fetchNewFills — the " +
          'emulation sweep is not polling its plain entry order (#586), so ingestFills would ' +
          'never learn a crypto entry filled',
      );
    }
    if (!emulation.stopFillSeen) {
      failures.push(
        "the crypto-emulation scenario's stop-leg fill never came back through fetchNewFills — " +
          'the emulation sweep is not polling its resting legs (#586), so a stop-out would go ' +
          'unbooked',
      );
    }
    if (!emulation.siblingCancelled) {
      failures.push(
        'the surviving take-profit leg was never cancelled after the stop leg filled — the ' +
          'emulated one-cancels-other edge is not firing (#586), leaving a resting order that ' +
          'can fire into a flat position and open a reverse one',
      );
    }
    return failures;
  },
};

export interface LoggerResilienceEvidence {
  stdoutRetired: boolean;
  degradationRecordedInFile: boolean;
  linesAfterStdoutDeath: number;
  escalatedWhenNothingCouldRecord: boolean;
  lastResortTraceOnStderr: boolean;
  fatalRecordedInFile: boolean;
  fatalExitCode: number | null;
}

class BreakablePipe implements StdoutStream {
  private listener?: (error: Error) => void;
  throwOn?: Error;
  readonly lines: string[] = [];

  write(line: string): boolean {
    if (this.throwOn !== undefined) throw this.throwOn;
    this.lines.push(line);
    return true;
  }

  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }

  breakPipe(): void {
    if (this.listener === undefined) {
      throw new Error(
        'smoke logging-fault scenario: nothing subscribed to stdout errors — ' +
          '`buildEntrypointLogger` stopped calling `watchStdoutErrors` (#714), so a broken ' +
          'pipe would reach `uncaughtException` and end an unattended soak',
      );
    }
    this.listener(new Error('EPIPE: broken pipe'));
  }
}

function runLoggerResilienceScenario(): LoggerResilienceEvidence {
  const directory = mkdtempSync(join(tmpdir(), 'samurai-smoke-log-'));
  try {
    const filePath = join(directory, 'orchestrator.log');
    const stdout = new BreakablePipe();
    const logger = buildEntrypointLogger(
      { filePath, maxBytes: 1024 * 1024, maxRotatedFiles: 1 },
      stdout,
    );
    const entry = (message: string) => ({
      trace_id: 'smoke-logging-fault',
      stage: 'orchestrator',
      level: 'info' as const,
      message,
      payload: {},
    });

    logger.log(entry('before the pipe died'));
    stdout.breakPipe();
    logger.log(entry('after the pipe died'));

    const afterPipe = readLogLines(filePath);
    const degradationRecordedInFile = afterPipe.some(
      (line) =>
        (line.payload as { log_stdout_sink?: string } | undefined)?.log_stdout_sink === 'degraded',
    );
    const linesAfterStdoutDeath = afterPipe.filter(
      (line) => line.message === 'after the pipe died',
    ).length;

    let escalatedWhenNothingCouldRecord = false;
    const deadStdout = new BreakablePipe();
    deadStdout.throwOn = new Error('EBADF');
    const stderrLines: string[] = [];
    const sinkless = new JsonLogger(undefined, deadStdout, {
      write: (line) => {
        stderrLines.push(line);
      },
    });
    try {
      sinkless.log(entry('nowhere to go'));
    } catch {
      escalatedWhenNothingCouldRecord = true;
    }
    const lastResortTraceOnStderr = stderrLines.some((line) => line.includes('nowhere to go'));

    const exits: number[] = [];
    const handlers = new Map<string, (error: unknown) => void>();
    installFaultHandlers(logger, {
      exit: (code) => exits.push(code),
      stderr: () => {},
      on: (event, handler) => handlers.set(event, handler),
    });
    handlers.get('uncaughtException')?.(new Error('smoke-injected fault'));

    return {
      stdoutRetired: logger.stdoutRetired,
      degradationRecordedInFile,
      linesAfterStdoutDeath,
      escalatedWhenNothingCouldRecord,
      lastResortTraceOnStderr,
      fatalRecordedInFile: readLogLines(filePath).some((line) =>
        line.message.includes('uncaughtException'),
      ),
      fatalExitCode: exits[0] ?? null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const loggerResilienceProbe: Probe<'loggerResilience'> = {
  run() {
    return runLoggerResilienceScenario();
  },
  verdict(evidence) {
    const failures: string[] = [];
    const logging = evidence;
    if (!logging.stdoutRetired || logging.linesAfterStdoutDeath === 0) {
      failures.push(
        'a dead stdout pipe did not leave the logger degraded-but-running — stdout was not ' +
          `retired (${logging.stdoutRetired}) or nothing reached the file afterwards ` +
          `(${logging.linesAfterStdoutDeath} lines). An unattended soak (#238) dies the moment ` +
          'its terminal closes, which is #714 exactly',
      );
    }
    if (!logging.degradationRecordedInFile) {
      failures.push(
        'stdout failed and nothing recorded it on the surviving sink — the run would continue ' +
          'blind, and a sink that silently stopped working is indistinguishable from a quiet ' +
          'system (#714)',
      );
    }
    if (!logging.escalatedWhenNothingCouldRecord) {
      failures.push(
        'a logger with no sink left to record on swallowed its failure instead of throwing — ' +
          'the degrade in #714 is only honest because it stops when the failure can no longer ' +
          'be written down anywhere',
      );
    }
    if (!logging.lastResortTraceOnStderr) {
      failures.push(
        'a logger with no sink left threw but wrote nothing to stderr — and that throw is raised ' +
          "inside a tick, where tick-loop's catch and safeLog swallow it by design (#573). " +
          'Without the stderr line the run would keep trading with no trace on any stream (#714)',
      );
    }
    if (!logging.fatalRecordedInFile || logging.fatalExitCode !== 1) {
      failures.push(
        'an unhandled fault was not recorded durably and exited with ' +
          `${logging.fatalExitCode ?? 'no code'} rather than 1 — the fault net must record where ` +
          'a soak can find it and STOP. A live-money process that keeps running in an unknown ' +
          'state with open positions is worse than one that dies (#714)',
      );
    }
    return failures;
  },
};

export interface LogRetentionEvidence {
  staleFileRemoved: boolean;
  freshFileKept: boolean;
  protectedFileKeptDespiteAge: boolean;
  liveShapedFileKeptDespiteAge: boolean;
  nonLogFileKeptDespiteAge: boolean;
  oversizedSoakBootTruncatedByDefault: boolean;
  bytesReclaimed: number;
}

function runLogRetentionScenario(): LogRetentionEvidence {
  const directory = mkdtempSync(join(tmpdir(), 'samurai-smoke-log-retention-'));
  try {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const stalePath = join(directory, 'orchestrator-20260101-0000.log');
    const freshPath = join(directory, 'orchestrator-20260904-0000.log');
    const activePath = join(directory, 'orchestrator.log');
    const rotatedPath = `${activePath}.1`;
    const liveShapedPath = join(directory, 'service-api.log');
    const nonLogPath = join(directory, '.env.local');
    const soakBootPath = join(directory, 'soak-boot.out');
    for (const path of [
      stalePath,
      freshPath,
      activePath,
      rotatedPath,
      liveShapedPath,
      nonLogPath,
    ]) {
      writeFileSync(path, 'line\n');
    }
    writeFileSync(soakBootPath, 'x'.repeat(17 * 1024 * 1024));

    const oldSeconds = (Date.now() - 40 * oneDayMs) / 1000;
    const recentSeconds = (Date.now() - oneDayMs) / 1000;
    for (const path of [stalePath, rotatedPath, liveShapedPath, nonLogPath]) {
      utimesSync(path, oldSeconds, oldSeconds);
    }
    utimesSync(freshPath, recentSeconds, recentSeconds);

    const result = runEntrypointLogRetention(
      { filePath: activePath, maxBytes: 1_000_000, maxRotatedFiles: 1 },
      { log: () => {} },
      { SAMURAI_LOG_RETENTION_DAYS: '30' },
    );

    return {
      staleFileRemoved: !existsSync(stalePath),
      freshFileKept: existsSync(freshPath),
      protectedFileKeptDespiteAge: existsSync(rotatedPath),
      liveShapedFileKeptDespiteAge: existsSync(liveShapedPath),
      nonLogFileKeptDespiteAge: existsSync(nonLogPath),
      oversizedSoakBootTruncatedByDefault: statSync(soakBootPath).size === 0,
      bytesReclaimed: result.bytesReclaimed,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const logRetentionProbe: Probe<'logRetention'> = {
  run() {
    return runLogRetentionScenario();
  },
  verdict(evidence) {
    const failures: string[] = [];
    const retention = evidence;
    if (!retention.staleFileRemoved) {
      failures.push(
        'the logs/ retention sweep did not remove a file well outside its retention window — ' +
          'unbounded growth in logs/ on an always-on host is exactly what #1116 exists to bound',
      );
    }
    if (!retention.freshFileKept) {
      failures.push(
        'the logs/ retention sweep removed a file inside its retention window — deleting a ' +
          'file this recent risks deleting evidence of a run still in progress (#1116)',
      );
    }
    if (!retention.protectedFileKeptDespiteAge) {
      failures.push(
        'the logs/ retention sweep removed a path passed as protected despite it being old — ' +
          "the active sink's own rotation set must survive regardless of mtime (#1116)",
      );
    }
    if (!retention.liveShapedFileKeptDespiteAge) {
      failures.push(
        'the logs/ retention sweep removed an undated bare name (the service-api.log shape) — ' +
          'a writer still holding that file open keeps appending to the unlinked inode, so the ' +
          'space is never reclaimed and the content is unrecoverable (#1116)',
      );
    }
    if (!retention.nonLogFileKeptDespiteAge) {
      failures.push(
        'the logs/ retention sweep removed a non-log file — pointed at a directory that is not ' +
          'logs/ this is how it reaches .env.local, and no age window can make that recoverable ' +
          '(#1116)',
      );
    }
    if (!retention.oversizedSoakBootTruncatedByDefault) {
      failures.push(
        'the logs/ retention sweep left an oversized soak-boot.out untouched with no ' +
          'configuration at all — #1206 is supposed to bound it by default (bareTruncateBytes and ' +
          'bareTruncateNames both default on, #1281 review round 2), so an operator who sets ' +
          'nothing is left with the exact unbounded growth this ticket exists to close',
      );
    }
    if (retention.staleFileRemoved && retention.bytesReclaimed <= 0) {
      failures.push(
        'the logs/ retention sweep removed a file but reported 0 bytes reclaimed — the byte ' +
          "accounting a soak's own artefact depends on (#1116) is not tracking what was deleted",
      );
    }
    return failures;
  },
};

export interface EntrypointFaultGuardEvidence {
  entries: {
    name: 'service-api' | 'supervisor';
    faultReportedOnStderr: boolean;
    continuesOnArbitraryFault: boolean;
  }[];
}

class NoListenerBreakablePipe {
  private listener?: (error: Error) => void;
  readonly lines: string[] = [];
  on(_event: 'error', listener: (error: Error) => void): this {
    this.listener = listener;
    return this;
  }
  write(line: string): void {
    this.lines.push(line);
  }
  breakPipe(name: string, streamName: 'stdout' | 'stderr'): void {
    if (this.listener === undefined) {
      throw new Error(
        `smoke entrypoint-fault-guard scenario: nothing subscribed to ${name}'s ${streamName} ` +
          `errors (#764) — a broken pipe would reach uncaughtException${streamName === 'stdout' ? ', same class #714 fixed for the orchestrator' : ' with no report ever landing, defeating the continue-posture at the one moment it exists to cover'}`,
      );
    }
    this.listener(new Error('EPIPE: broken pipe'));
  }
}

function runEntrypointFaultGuardScenario(): EntrypointFaultGuardEvidence {
  function probe(
    name: 'service-api' | 'supervisor',
    watchStdout: (
      stdout: FaultGuardStdoutStream,
      stderr: FaultGuardStdoutStream & FaultGuardErrorStream,
    ) => void,
    install: (effects: ContinueOnFaultEffects) => void,
  ): EntrypointFaultGuardEvidence['entries'][number] {
    const stdoutPipe = new NoListenerBreakablePipe();
    const stderrPipe = new NoListenerBreakablePipe();
    watchStdout(stdoutPipe, stderrPipe);
    stdoutPipe.breakPipe(name, 'stdout');
    stderrPipe.breakPipe(name, 'stderr');
    const stdoutFaultLines = stderrPipe.lines;

    const arbitraryFaultLines: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();
    install({
      stderr: { write: (line) => arbitraryFaultLines.push(line as string) },
      on: (event, handler) => handlers.set(event, handler),
    });
    if (!handlers.has('uncaughtException') || !handlers.has('unhandledRejection')) {
      throw new Error(
        `smoke entrypoint-fault-guard scenario: ${name} did not subscribe to both ` +
          'uncaughtException and unhandledRejection (#764)',
      );
    }
    handlers.get('uncaughtException')?.(new Error('smoke-injected fault'));

    return {
      name,
      faultReportedOnStderr: stdoutFaultLines.length > 0,
      continuesOnArbitraryFault: arbitraryFaultLines.length > 0,
    };
  }

  return {
    entries: [
      probe('service-api', watchDashboardStdout, installDashboardContinueOnFault),
      probe('supervisor', watchSupervisorStdout, installSupervisorContinueOnFault),
    ],
  };
}

const entrypointFaultGuardsProbe: Probe<'entrypointFaultGuards'> = {
  run() {
    return runEntrypointFaultGuardScenario();
  },
  verdict(evidence) {
    const failures: string[] = [];
    for (const guard of evidence.entries) {
      if (guard.faultReportedOnStderr !== true) {
        failures.push(
          `${guard.name} stdout fault was not reported on stderr — a degrade that is not recorded ` +
            'anywhere is indistinguishable from a quiet failure (#764)',
        );
      }
      if (!guard.continuesOnArbitraryFault) {
        failures.push(
          `${guard.name} arbitrary-fault handler did not continue the process — this entrypoint ` +
            'decided CONTINUE, not the orchestrator STOP: exiting takes the other half of the ' +
            'system down through the supervisor rule that either child dying stops the other (#764)',
        );
      }
    }
    return failures;
  },
};

function readLogLines(filePath: string): { message: string; payload?: unknown }[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { message: string; payload?: unknown });
}

interface SmokeTick {
  trace_id: string;
  stages: { stage: string; decision: string }[];
}

export interface SmokeObservations {
  ticks: SmokeTick[];
  debates: {
    debate_id: string;
    instrument: string;
    direction: string;
    rounds: number;
    termination: string | null;
  }[];
  verdicts: {
    trace_id: string;
    instrument: string;
    status: string;
    no_go_reason: string | null;
    no_go_detail_measured_ms: number | null;
    no_go_detail_bound_ms: number | null;
  }[];
  positions: {
    idempotency_key: string;
    instrument: string;
    side: string;
    requested_size: number;
    filled_size: number;
    avg_entry_price: number;
    order_state: string;
    arm: TradingArm;
  }[];
  fills: { idempotency_key: string; leg: string; price: number; qty: number; fee: number }[];
  closedTrades: {
    idempotency_key: string;
    realized_pnl_net: number;
    close_reason: string;
    arm: TradingArm;
  }[];
  flattenSubmissions: { idempotency_key: string; instrument: string; status: string }[];
  gdeltRowsArchived: number;
  gdeltAggregateItems: number;
  polymarketRowsArchived: number;
  polymarketItemsArchived: number;
  polymarketIntelItems: number;
  cosineSetups: { debate_id: string; instrument: string }[];
  riskThresholds: { name: string; value: number }[];
  analystWeights: { analyst_id: string }[];
  traderDecisions: { trace_id: string; instrument: string; intent_type: string | null }[];
  riskDecisions: { trace_id: string; instrument: string; status: string }[];
  breakerStates: { tier: string; tripped: number }[];
}

function readSmokeObservations(
  db: StoreHandle,
  miArchive?: MiArchiveStore,
  marketIntelligence?: MarketIntelligenceStore,
): SmokeObservations {
  const auditRows = db
    .prepare('SELECT trace_id, stage, decision FROM audit_log ORDER BY rowid')
    .all() as { trace_id: string; stage: string; decision: string }[];

  const byTrace = new Map<string, SmokeTick>();
  for (const row of auditRows) {
    const tick = byTrace.get(row.trace_id) ?? { trace_id: row.trace_id, stages: [] };
    tick.stages.push({ stage: row.stage, decision: row.decision });
    byTrace.set(row.trace_id, tick);
  }

  return {
    ticks: [...byTrace.values()],
    debates: db
      .prepare(
        'SELECT debate_id, instrument, direction, rounds, termination FROM debate_log ORDER BY rowid',
      )
      .all() as SmokeObservations['debates'],
    verdicts: db
      .prepare(
        'SELECT trace_id, instrument, status, no_go_reason, no_go_detail_measured_ms, ' +
          'no_go_detail_bound_ms FROM verdict_log ORDER BY rowid',
      )
      .all() as SmokeObservations['verdicts'],
    positions: db
      .prepare(
        'SELECT idempotency_key, instrument, side, requested_size, filled_size, avg_entry_price, ' +
          'order_state, arm FROM open_positions ORDER BY arm, idempotency_key',
      )
      .all() as SmokeObservations['positions'],
    fills: db
      .prepare(
        'SELECT idempotency_key, leg, price, qty, fee FROM fills ' +
          'ORDER BY idempotency_key, leg, rowid',
      )
      .all() as SmokeObservations['fills'],
    closedTrades: db
      .prepare(
        'SELECT idempotency_key, realized_pnl_net, close_reason, arm FROM closed_trades ' +
          'ORDER BY arm, idempotency_key',
      )
      .all() as SmokeObservations['closedTrades'],
    flattenSubmissions: db
      .prepare('SELECT idempotency_key, instrument, status FROM flatten_submissions ORDER BY rowid')
      .all() as SmokeObservations['flattenSubmissions'],
    gdeltRowsArchived: miArchive?.rawRows(SOURCE_GDELT).length ?? 0,
    gdeltAggregateItems: SMOKE_GDELT_ASSET_CLASSES.reduce(
      (total, asset_class) =>
        total +
        (marketIntelligence
          ?.getContext(asset_class, 24 * 60 * 60 * 1000, 'smoke')
          .intel.filter((item) => item.entity === GDELT_MACRO_ENTITY).length ?? 0),
      0,
    ),
    polymarketRowsArchived: miArchive?.rawRows(SOURCE_POLYMARKET).length ?? 0,
    polymarketItemsArchived:
      miArchive?.itemsKnownAt(POLYMARKET_ASSET_CLASS, SMOKE_RUN_INSTANT, [SOURCE_POLYMARKET])
        .length ?? 0,
    polymarketIntelItems:
      marketIntelligence
        ?.getContext(POLYMARKET_ASSET_CLASS, 24 * 60 * 60 * 1000, 'smoke', undefined, 'SPY')
        .intel.filter((item) => item.source === SOURCE_POLYMARKET).length ?? 0,
    cosineSetups: db
      .prepare('SELECT debate_id, instrument FROM cosine_setups')
      .all() as SmokeObservations['cosineSetups'],
    riskThresholds: db
      .prepare('SELECT threshold_name AS name, value FROM risk_thresholds')
      .all() as SmokeObservations['riskThresholds'],
    traderDecisions: db
      .prepare('SELECT trace_id, instrument, intent_type FROM trader_log')
      .all() as SmokeObservations['traderDecisions'],
    riskDecisions: db
      .prepare('SELECT trace_id, instrument, status FROM risk_log')
      .all() as SmokeObservations['riskDecisions'],
    analystWeights: db
      .prepare('SELECT analyst_id FROM analyst_weights')
      .all() as SmokeObservations['analystWeights'],
    breakerStates: db
      .prepare('SELECT tier, tripped FROM breaker_state')
      .all() as SmokeObservations['breakerStates'],
  };
}

export interface SmokeGateResult {
  passed: boolean;
  failures: string[];
}

function makeExitProbeInput(overrides: Partial<OrderIntent> = {}) {
  const intent: OrderIntent = {
    idempotency_key: 'smoke-threshold-clamp-exit-probe',
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'sell',
    intent_type: 'exit',
    size: 1,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: SMOKE_RUN_INSTANT,
    decided_at: SMOKE_RUN_INSTANT,
    metadata: {
      debate_id: 'smoke-threshold-clamp-exit-probe',
      conviction: 0.5,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: 0, no_precedent: true },
    },
    ...overrides,
  };
  return {
    trace_id: 'smoke-threshold-clamp-exit-probe',
    intent,
    clock: { now: () => SMOKE_RUN_INSTANT },
    portfolio: {
      equity: 100_000,
      peak_equity: 100_000,
      drawdown_pct: 0,
      exposure_by_instrument: {},
      exposure_by_class: { crypto: 0, stocks: 0 },
      gross_exposure: 0,
      reserved_exposure_by_instrument: {},
      reserved_exposure_by_class: { crypto: 0, stocks: 0 },
      reserved_gross_exposure: 0,
      daily_pnl: {
        crypto: { known: true as const, pct: 0 },
        stocks: { known: true as const, pct: 0 },
        portfolio: { known: true as const, pct: 0 },
      },
      consecutive_losses: 0,
      unvalued_instruments: [],
    },
    breakers: {
      portfolio_tripped: false,
      asset_class_tripped: { crypto: false, stocks: false },
      armed_breakers: [],
    },
    next_breaker_state: [],
    correlation: { correlations: {}, insufficient_history: [] },
    cii: {},
    mode: 'paper' as const,
  };
}

function probeExitBypassesLiveClamp(riskConfig: RiskConfig): boolean {
  const badThresholds = { getRiskThresholds: () => ({ max_pbo: 0.5 }) };
  const manager = new RiskManagerImpl(riskConfig, badThresholds);

  let exitApproved = false;
  try {
    const decision = manager.evaluate(makeExitProbeInput());
    exitApproved = decision.status === 'approved';
  } catch {
    exitApproved = false;
  }

  const entryStillRefused = refuses(() => {
    manager.evaluate(makeExitProbeInput({ intent_type: 'entry', idempotency_key: 'smoke-entry' }));
  });

  return exitApproved && entryStillRefused;
}

export interface ThresholdClampEvidence {
  probedNames: readonly string[];
  liveReadAccepted: readonly string[];
  writeDoorAccepted: readonly string[];
  breakerConstructionRefused: boolean;
  killLineCheckRefused: boolean;
  shippedConfigAccepted: boolean;
  exitBypassesLiveClamp: boolean;
}

function outOfBoundValueFor(name: string): number {
  const bound = boundFor(name);
  if (bound === undefined) {
    throw new Error(`smoke threshold-clamp probe: '${name}' has no bound — the table changed`);
  }
  if (bound.max !== undefined) return bound.max + 1;
  if (bound.min !== undefined) return bound.min - 1;
  throw new Error(`smoke threshold-clamp probe: '${name}' states neither edge`);
}

function refuses(probe: () => void): boolean {
  try {
    probe();
    return false;
  } catch (error) {
    return isThresholdBoundViolation(error);
  }
}

function runThresholdClampScenario(
  breakerConfig: BreakerConfig,
  riskConfig: RiskConfig,
): ThresholdClampEvidence {
  const db = openSharedStore(':memory:');
  try {
    const store = new SqliteTuningStore(db, new SimulatedClock(SMOKE_RUN_INSTANT));
    const liveReadAccepted: string[] = [];
    const writeDoorAccepted: string[] = [];

    for (const name of GUARDED_THRESHOLD_NAMES) {
      const bad = outOfBoundValueFor(name);
      if (!refuses(() => resolveRiskConfig(riskConfig, { [name]: bad }))) {
        liveReadAccepted.push(name);
      }
      if (!refuses(() => store.setRiskThreshold(name, bad))) {
        writeDoorAccepted.push(name);
      }
    }

    return {
      probedNames: [...GUARDED_THRESHOLD_NAMES],
      liveReadAccepted,
      writeDoorAccepted,
      breakerConstructionRefused: refuses(
        () =>
          new CircuitBreakers({
            ...breakerConfig,
            max_drawdown_pct: 0.95,
            auto_rearm: { ...breakerConfig.auto_rearm, recovery_drawdown_pct: 0.9 },
          }),
      ),
      killLineCheckRefused: refuses(() =>
        assertKillThresholdsWithinBounds(
          {
            max_pbo: 0.5,
            min_oos_sharpe: 0.5,
            min_deflated_sharpe: 0.95,
            max_live_backtest_divergence: 0.5,
          },
          'smoke threshold-clamp probe',
        ),
      ),
      shippedConfigAccepted: !refuses(() => new CircuitBreakers(breakerConfig)),
      exitBypassesLiveClamp: probeExitBypassesLiveClamp(riskConfig),
    };
  } finally {
    db.close();
  }
}

const THRESHOLD_CLAMP_FAILURE_CHECKS: ReadonlyArray<{
  failed: (clamp: ThresholdClampEvidence) => boolean;
  message: (clamp: ThresholdClampEvidence) => string;
}> = [
  {
    failed: (clamp) => clamp.liveReadAccepted.length > 0,
    message: (clamp) =>
      `the LIVE risk_thresholds read accepted out-of-bound values for ` +
      `${clamp.liveReadAccepted.join(', ')} — RiskManagerImpl.evaluate() re-resolves its ` +
      'config from that table on every call, so this is the path the Feedback Loop moves a ' +
      'dial on between two ticks, with no boot in between (#638/ADR-0013)',
  },
  {
    failed: (clamp) => clamp.writeDoorAccepted.length > 0,
    message: (clamp) =>
      `the Feedback Loop write door accepted out-of-bound values for ` +
      `${clamp.writeDoorAccepted.join(', ')} — ADR-0013 requires every dial change to be ` +
      'rejected in code if it would cross a hard bound, and after #736 there is nobody in ' +
      'the path at all (#638)',
  },
  {
    failed: (clamp) => !clamp.breakerConstructionRefused,
    message: () =>
      'the breaker constructor accepted a 0.95/0.90 drawdown pair — the pre-existing check is ' +
      'a relative ordering test only, so this boots a system whose hard drawdown breaker ' +
      'can never fire (#638)',
  },
  {
    failed: (clamp) => !clamp.killLineCheckRefused,
    message: () =>
      'the kill-line boot check accepted a PBO threshold of 0.5 — CONTEXT.md states 0.10 as a ' +
      'bright line and the Feedback Loop holds the only mutable copy of it (#638)',
  },
  {
    failed: (clamp) => !clamp.shippedConfigAccepted,
    message: () =>
      'the shipped paper breaker configuration is itself refused by the clamp — the bound is ' +
      'wrong, not the config, and every negative probe above would still pass (#638)',
  },
  {
    failed: (clamp) => !clamp.exitBypassesLiveClamp,
    message: () =>
      'with a live risk_thresholds row out of bounds, an exit intent did not reach ' +
      "RiskManagerImpl.evaluate()'s approved bypass while an entry intent was still refused — " +
      "either the exit/flatten path is stranded behind #638's clamp (a materially worse " +
      "defect than #766 was filed for: ADR-0014's flat-by-close invariant has no session-end " +
      'job to catch a missed flatten) or the clamp stopped refusing entries at all (#766)',
  },
];

const thresholdClampProbe: Probe<'thresholdClamp'> = {
  run({ profile }) {
    return runThresholdClampScenario(profile.breakerConfig, profile.riskConfig);
  },
  verdict(evidence) {
    const clamp = evidence;
    const failures: string[] = [];
    const missingFromProbe = GUARDED_THRESHOLD_NAMES.filter(
      (name) => !clamp.probedNames.includes(name),
    );
    if (
      missingFromProbe.length > 0 ||
      clamp.probedNames.length !== GUARDED_THRESHOLD_NAMES.length
    ) {
      failures.push(
        `the threshold-clamp probe covered ${clamp.probedNames.length} of ` +
          `${GUARDED_THRESHOLD_NAMES.length} guarded thresholds (missing: ` +
          `${missingFromProbe.join(', ') || 'none'}) — a bounds-table entry that nothing probes ` +
          'is a limit nobody has seen enforced (#638)',
      );
    }
    for (const check of THRESHOLD_CLAMP_FAILURE_CHECKS) {
      if (check.failed(clamp)) {
        failures.push(check.message(clamp));
      }
    }
    return failures;
  },
};

export interface ApprovalFallbackEvidence {
  refusedFabricatedConsent: boolean;
  message: string | null;
}

async function runApprovalFallbackScenario(
  channel: ApprovalChannel,
): Promise<ApprovalFallbackEvidence> {
  const orderIntent = exitPathOrder(
    'BTC-USD',
    'smoke-approval-fallback-probe',
    'buy',
    'entry',
    1,
    SMOKE_RUN_INSTANT,
  );
  try {
    await channel.requestApproval({
      order_intent: orderIntent,
      risk_decision: approvedRiskDecision(orderIntent),
      trace_id: 'smoke-approval-fallback-probe',
      timeout_ms: 1_000,
    });
    return { refusedFabricatedConsent: false, message: null };
  } catch (error) {
    return {
      refusedFabricatedConsent: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const approvalFallbackProbe: Probe<'approvalFallback'> = {
  run({ approvals }) {
    return runApprovalFallbackScenario(approvals);
  },
  verdict(approvalFallback) {
    const failures: string[] = [];
    if (!approvalFallback.refusedFabricatedConsent) {
      failures.push(
        "the composition root's approvals fallback did NOT refuse Verdict's HITL gate (6) — it " +
          'answered instead of throwing, which is the auto-approving shape this fallback must ' +
          'never take (#1152)',
      );
    } else if (!(approvalFallback.message ?? '').includes('no ApprovalChannel is wired')) {
      failures.push(
        'the approvals fallback rejected, but not with the expected refusal (got: ' +
          `${approvalFallback.message}) — a different exception could be masking a fallback that ` +
          'no longer refuses on purpose (#1152)',
      );
    }
    return failures;
  },
};

export interface ArmComparisonEvidence {
  live: ArmPerformance | null;
  control: ArmPerformance | null;
  persistedRows: number;
  persistedBothDrawdowns: boolean;
  diverged: boolean;
  alerts: number;
  comparison: ArmComparison;
}

export interface OutsideBenchmarkEvidence {
  measured: number;
  persistedRows: number;
  persistedBothColumns: boolean;
  windowsMatchArmComparison: boolean;
  unmeasured: readonly string[];
}

function feedbackCycleScheduleWasWritten(db: StoreHandle): boolean {
  return new SqliteFeedbackCycleScheduleStore(db).lastBoundary() !== null;
}

const feedbackCycleScheduleWrittenProbe: Probe<'feedbackCycleScheduleWritten'> = {
  run({ db }) {
    return feedbackCycleScheduleWasWritten(db);
  },
  verdict(evidence) {
    const failures: string[] = [];
    if (!evidence) {
      failures.push(
        'no row in `feedback_cycle_schedule` after the run — either `scheduleFeedbackCycle` was ' +
          "dropped from production.ts's composition root, or `paperStartingProfile`'s `feedback` " +
          "block stopped reaching `start()`. This is exactly #1110's defect: a mechanism that " +
          'every unit test exercises directly but the real composition root never calls, so a ' +
          'soak restarted more often than once a day would go back to accumulating zero ' +
          '`arm_comparison_samples` rows for its whole life',
      );
    }
    return failures;
  },
};

export type SizingCeilingEvidence = {
  configuredCeiling: number | undefined;
  rows: number;
  allMatchConfiguredCeiling: boolean;
};

function readSizingCeilingStamps(
  db: StoreHandle,
  expected: number | undefined,
): SizingCeilingEvidence {
  const rows = db
    .prepare(
      `SELECT sizing_capital_ceiling FROM open_positions WHERE instrument = 'BTC-USD'
       UNION ALL
       SELECT sizing_capital_ceiling FROM closed_trades WHERE instrument = 'BTC-USD'`,
    )
    .all() as { sizing_capital_ceiling: number | null }[];

  return {
    configuredCeiling: expected,
    rows: rows.length,
    allMatchConfiguredCeiling:
      expected !== undefined && rows.every((row) => row.sizing_capital_ceiling === expected),
  };
}

const sizingCeilingProbe: Probe<'sizingCeiling', 'armComparison'> = {
  after: ['armComparison'],
  run({ db, profile }) {
    return readSizingCeilingStamps(db, profile.capitalCeilingUsd);
  },
  verdict(evidence, { prior }) {
    const failures: string[] = [];
    const { configuredCeiling, rows, allMatchConfiguredCeiling } = evidence;
    if (configuredCeiling === undefined) {
      failures.push(
        "`paperStartingProfile('paper')` no longer sets `capitalCeilingUsd` — the Trader is back " +
          "to sizing off the paper broker's funded equity rather than the declared book (#1112)",
      );
    } else if (rows === 0) {
      failures.push(
        'no BTC-USD row in `open_positions` or `closed_trades` after the run, so the ' +
          '`sizing_capital_ceiling` stamp has no evidence either way — the six-stage tick loop ' +
          'took no position at all (#1112)',
      );
    } else if (!allMatchConfiguredCeiling) {
      failures.push(
        `a BTC-USD row carries a \`sizing_capital_ceiling\` other than this run's configured ` +
          `${configuredCeiling} — \`production.ts\` stopped passing \`config.capitalCeilingUsd\` ` +
          'into `new SqliteExecutionStore(...)`, so a `closed_trades` window could once again ' +
          'silently mix rows sized under two different equity bases (#1112)',
      );
    }

    if (
      configuredCeiling !== undefined &&
      prior.armComparison.comparison.basis !== configuredCeiling
    ) {
      failures.push(
        `the arm comparison divided both arms by ${prior.armComparison.comparison.basis} while this run sized ` +
          `against ${configuredCeiling} — the Feedback Loop's basis and the Trader's capital ` +
          'ceiling have come apart, so every persisted `return_pct` is measured against capital ' +
          'the arms were never sized on (#1112 AC3, #1180)',
      );
    }
    return failures;
  },
};

function readPublishedLlmCap(db: StoreHandle): {
  capUsd: number | null;
  capArmedAt: string | null;
} {
  const spend = new SqliteQueryStore(db).getLlmSpend(SMOKE_RUN_INSTANT);
  return { capUsd: spend.cap_usd, capArmedAt: spend.cap_armed_at };
}

const llmSpendCapProbe: Probe<'llmSpendCap'> = {
  run({ db, profile }) {
    const published = readPublishedLlmCap(db);
    return {
      publishedCapUsd: published.capUsd,
      configuredBudgetUsd: profile.llmBudgetUsd,
      capArmedAt: published.capArmedAt,
    };
  },
  verdict(evidence) {
    const failures: string[] = [];
    if (evidence.publishedCapUsd !== (evidence.configuredBudgetUsd ?? null)) {
      failures.push(
        `the dashboard's LLM cap reads ${evidence.publishedCapUsd ?? 'null'} while this run ` +
          `armed its spend cap at ${evidence.configuredBudgetUsd ?? 'null'} — ` +
          '`publishedSpendCap.arm(...)` is no longer beside the `SqliteSpendCap` construction in ' +
          'production.ts, so the rail measures spend against a cap nobody is enforcing (#1140)',
      );
    }

    if (evidence.capArmedAt === null) {
      failures.push(
        "the dashboard's LLM cap reports `cap_armed_at: null` on a run that booted and armed its " +
          'spend cap — `SqliteQueryStore.getLlmSpend` (or `SqliteLlmSpendCapStore.read`) stopped ' +
          'reading `armed_at`, so the rail cannot tell this run apart from one where nothing ever ' +
          'armed (#1196)',
      );
    }
    return failures;
  },
};

export function runArmComparisonProbe(db: StoreHandle): ArmComparisonEvidence {
  let alerts = 0;
  const samples = new SqliteArmComparisonSampleStore(db);
  const sample = runArmComparisonCycle({
    clock: new SimulatedClock(SMOKE_RUN_INSTANT),
    trades: new SqliteArmComparisonSource(db),
    samples,
    alerts: {
      postArmDivergenceAlert: () => {
        alerts += 1;
      },
    },
    basis: LIVE_BOOK_SIZING_USD,
    window_ms: DEFAULT_ARM_COMPARISON_WINDOW_MS,
    thresholds: DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  });

  const persisted = samples.getRecent(5, SMOKE_RUN_INSTANT);
  return {
    live: sample.comparison.live,
    control: sample.comparison.control,
    persistedRows: persisted.length,
    persistedBothDrawdowns: persisted.every(
      (row) =>
        Number.isFinite(row.comparison.live.max_drawdown_pct) &&
        Number.isFinite(row.comparison.control.max_drawdown_pct),
    ),
    diverged: sample.divergence.diverged,
    alerts,
    comparison: sample.comparison,
  };
}

const armComparisonProbe: Probe<'armComparison'> = {
  run({ db }) {
    return runArmComparisonProbe(db);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const arms = evidence;
    if (arms.live === null || arms.control === null) {
      failures.push(
        'the arm-comparison cycle produced no comparison — `runArmComparisonCycle` (#971) could ' +
          'not derive both arms from `closed_trades`, so the Feedback Loop has nothing to persist ' +
          'and the dashboard panel has nothing to show',
      );
    }
    if (arms.persistedRows === 0) {
      failures.push(
        'the arm-comparison cycle wrote no row to `arm_comparison_samples` — either migration 0034 ' +
          'did not apply or `SqliteArmComparisonSampleStore.append` stopped being called. The ' +
          'dashboard panel (#913 surface 2) reads FL persisted samples and nothing else, so a soak ' +
          'in this state shows "no comparison computed yet" for its whole duration',
      );
    }
    if (!arms.persistedBothDrawdowns) {
      failures.push(
        'an `arm_comparison_samples` row came back without a finite drawdown on both arms — ' +
          'the persisted comparison has become a return-only view, which is exactly what doc 12 D4 ' +
          'rules out and what `ArmPerformance.max_drawdown_pct` being required exists to prevent',
      );
    }
    if (arms.diverged !== arms.alerts > 0) {
      failures.push(
        `the arm comparison reported diverged=${String(arms.diverged)} but posted ${arms.alerts} ` +
          'alert(s) — the divergence verdict and the escalation have come apart, so either a ' +
          'divergence reaches nobody or an alert fires on a comparison that did not diverge (#971)',
      );
    }
    return failures;
  },
};

const SMOKE_BENCHMARK_DAY_MS = 24 * 60 * 60 * 1000;

class FixtureBenchmarkSeriesSource implements BenchmarkSeriesSource {
  private static readonly DRIFT: Record<string, number> = { SPY: 0.001, AGG: 0.0002 };

  async getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]> {
    const start = from.getTime() - 3 * SMOKE_BENCHMARK_DAY_MS;
    const drift = FixtureBenchmarkSeriesSource.DRIFT[instrument] ?? 0.0005;
    const observations: BenchmarkObservation[] = [];
    let close = 100;
    for (let t = start; t <= to.getTime(); t += SMOKE_BENCHMARK_DAY_MS) {
      const step = observations.length === 7 ? -0.01 : drift;
      close *= 1 + step;
      observations.push({ close_time: new Date(t), close });
    }
    return observations;
  }
}

async function runOutsideBenchmarkProbe(
  db: StoreHandle,
  comparison: ArmComparison,
): Promise<OutsideBenchmarkEvidence> {
  const samples = new SqliteOutsideBenchmarkSampleStore(db);
  const result = await runOutsideBenchmarkCycle({
    clock: new SimulatedClock(SMOKE_RUN_INSTANT),
    comparison,
    series: new FixtureBenchmarkSeriesSource(),
    samples,
  });

  const persisted = samples.getRecent(10, SMOKE_RUN_INSTANT);
  return {
    measured: result.measured.length,
    persistedRows: persisted.length,
    persistedBothColumns: persisted.every(
      (row) =>
        Number.isFinite(row.performance.buy_and_hold_return_pct) &&
        Number.isFinite(row.performance.max_drawdown_pct),
    ),
    windowsMatchArmComparison:
      persisted.length > 0 &&
      persisted.every(
        (row) =>
          row.from.getTime() === comparison.from.getTime() &&
          row.to.getTime() === comparison.to.getTime(),
      ),
    unmeasured: result.unmeasured.map((entry) => `${entry.benchmark}: ${entry.reason}`),
  };
}

const outsideBenchmarksProbe: Probe<'outsideBenchmarks', 'armComparison'> = {
  after: ['armComparison'],
  run({ db }, prior) {
    return runOutsideBenchmarkProbe(db, prior.armComparison.comparison);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const benchmarks = evidence;
    if (benchmarks.measured === 0) {
      failures.push(
        'the outside-benchmark cycle measured nothing — `runOutsideBenchmarkCycle` (#981) produced ' +
          'no benchmark at all, so the dashboard has no market context beside the arm comparison. ' +
          `Reasons given: ${benchmarks.unmeasured.join('; ') || '(none reported)'}`,
      );
    }
    if (benchmarks.persistedRows === 0) {
      failures.push(
        'the outside-benchmark cycle wrote no row to `outside_benchmark_samples` — either migration ' +
          '0036 did not apply or `SqliteOutsideBenchmarkSampleStore.append` stopped being called, ' +
          'and the panel reads FL persisted samples and nothing else (#981)',
      );
    }
    if (!benchmarks.persistedBothColumns) {
      failures.push(
        'an `outside_benchmark_samples` row came back without BOTH a finite return and a finite ' +
          'drawdown — the persisted benchmark has become a return-only view, which is what doc 12 ' +
          'D4 rules out and what the two NOT NULL columns exist to prevent (#981)',
      );
    }
    if (!benchmarks.windowsMatchArmComparison) {
      failures.push(
        'a persisted outside benchmark does not cover the SAME window the arm comparison was ' +
          'measured over — #636: a benchmark on an approximate window is not a risk-adjusted ' +
          'comparison, it is noise. The window is meant to be inherited from the `ArmComparison`, ' +
          'so this means it stopped being (#981)',
      );
    }
    return failures;
  },
};

export interface DataFailoverEvidence {
  storedSources: readonly string[];
  storedOpenTimes: readonly string[];
  alerts: readonly DataFailoverAlert[];
  readError: string | null;
}

const FAILOVER_FIXTURE_OPEN_TIMES = [
  '2026-08-03T09:00:00.000Z',
  '2026-08-03T18:00:00.000Z',
  '2026-08-03T19:00:00.000Z',
] as const;

export const FAILOVER_IN_SESSION_OPEN_TIMES: readonly string[] =
  FAILOVER_FIXTURE_OPEN_TIMES.slice(1);

async function runDataFailoverScenario(logger: Logger): Promise<DataFailoverEvidence> {
  const db = openSharedStore(':memory:');
  try {
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const profile = paperStartingProfile('paper');
    const alerts: DataFailoverAlert[] = [];

    const orchestrator = buildProductionOrchestrator({
      ...profile,
      db,
      clock,
      logger,
      universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      tradingCalendar: new UsEquityRegularHoursCalendar(),
      stocksTradingWindow: () => true,
      alpacaDataClient: {
        getBars: async () => {
          throw new Error('alpaca 503 (smoke failover probe)');
        },
        getLatestQuote: async () => ({ t: SMOKE_RUN_INSTANT.toISOString(), ap: 100, bp: 99 }),
      },
      equitiesFallbackBarFetcher: async (symbol, window) =>
        FAILOVER_FIXTURE_OPEN_TIMES.map((openTime): Bar => {
          const open_time = new Date(openTime);
          return {
            instrument: symbol,
            timeframe: window.timeframe,
            open_time,
            close_time: new Date(open_time.getTime() + 3_600_000),
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 1_000,
            source: 'polygon',
          };
        }),
      dataFailoverAlerts: {
        postDataFailoverAlert: async (alert) => {
          alerts.push(alert);
        },
      },
      miArchive: new MiArchiveStore(),
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient: new UnreachableAlpacaClient(),
      llmClient: new ConstantResponseLlmClient(),
    });

    let readError: string | null = null;
    try {
      await orchestrator.marketData.getBars(
        'SPY',
        { timeframe: '1h', lookback: 2 },
        SMOKE_RUN_INSTANT,
      );
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }

    const stored = db
      .prepare('SELECT open_time, source FROM bars WHERE instrument = ? ORDER BY open_time')
      .all('SPY') as { open_time: string; source: string }[];

    return {
      storedSources: stored.map((row) => row.source),
      storedOpenTimes: stored.map((row) => new Date(row.open_time).toISOString()),
      alerts,
      readError,
    };
  } finally {
    db.close();
  }
}

const dataFailoverProbe: Probe<'dataFailover'> = {
  run({ logger }) {
    return runDataFailoverScenario(logger);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const failover = evidence;
    if (failover.readError !== null) {
      failures.push(
        `the composition root's equities bar read threw instead of failing over: ` +
          `${failover.readError} — a stalled primary must degrade to the fallback vendor, not ` +
          'stop the tick. The root is not building a FailoverDataSource at all (#562)',
      );
    }
    if (!failover.storedSources.every((source) => source === 'polygon')) {
      failures.push(
        `the bars the fallback served were stamped [${failover.storedSources.join(', ')}] in the ` +
          "store rather than all 'polygon' — provenance is the only thing that makes a " +
          'fallback-sourced row detectable after the stall, and nothing re-derives it (#562)',
      );
    }
    if (failover.storedSources.length === 0) {
      failures.push(
        'no bars row landed from the fallback vendor — the failover produced nothing durable, so ' +
          'a stage reading bars on the next tick still has no data (#562)',
      );
    }
    if (
      failover.storedOpenTimes.length !== FAILOVER_IN_SESSION_OPEN_TIMES.length ||
      !failover.storedOpenTimes.every(
        (openTime, i) => openTime === FAILOVER_IN_SESSION_OPEN_TIMES[i],
      )
    ) {
      failures.push(
        `the fallback persisted bars at [${failover.storedOpenTimes.join(', ')}] where the ` +
          `session-normalized set is [${FAILOVER_IN_SESSION_OPEN_TIMES.join(', ')}] — the primary ` +
          'is a NormalizingDataSource and drops out-of-session candles, so a raw fallback puts a ' +
          'different window behind the same lookback and an ATR spans extended hours instead of ' +
          'regular sessions, permanently (#562)',
      );
    }
    if (failover.alerts.length === 0) {
      failures.push(
        'the failover served bars but raised nothing on the DataFailoverAlertChannel — an ' +
          'unattended soak that silently switched vendors is a stall nobody learns about (#562)',
      );
    }
    return failures;
  },
};

export interface DataSourceFactoryEvidence {
  alpacaStoredSources: readonly string[];
  lseStoredSources: readonly string[];
  error: string | null;
}

export const SMOKE_LSE_VENDOR = 'smoke-lse-vendor';

const FACTORY_US_OPEN_TIMES = ['2026-08-03T18:00:00.000Z', '2026-08-03T19:00:00.000Z'] as const;
const FACTORY_LSE_OPEN_TIMES = ['2026-08-03T09:00:00.000Z', '2026-08-03T10:00:00.000Z'] as const;

function factoryProbeBars(openTimes: readonly string[]) {
  return openTimes.map((openTime) => ({
    open_time: new Date(openTime),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1_000,
  }));
}

async function runDataSourceFactoryScenario(logger: Logger): Promise<DataSourceFactoryEvidence> {
  const profile = paperStartingProfile('paper');

  const storedSourcesFor = async (
    universe: readonly UniverseInstrument[],
    instrument: string,
    overrides: Partial<Parameters<typeof buildProductionOrchestrator>[0]>,
  ): Promise<{ sources: string[]; error: string | null }> => {
    const db = openSharedStore(':memory:');
    try {
      const orchestrator = buildProductionOrchestrator({
        ...profile,
        db,
        clock: new SimulatedClock(SMOKE_RUN_INSTANT),
        logger,
        universe,
        tradingCalendar: new UsEquityRegularHoursCalendar(),
        stocksTradingWindow: () => true,
        miArchive: new MiArchiveStore(),
        accountState: new FixedAccountStateProvider(),
        alpacaBrokerClient: new UnreachableAlpacaClient(),
        llmClient: new ConstantResponseLlmClient(),
        ...overrides,
      });

      await orchestrator.marketData.getBars(
        instrument,
        { timeframe: '1h', lookback: 2 },
        SMOKE_RUN_INSTANT,
      );

      const stored = db
        .prepare('SELECT source FROM bars WHERE instrument = ? ORDER BY open_time')
        .all(instrument) as { source: string }[];
      return { sources: stored.map((row) => row.source), error: null };
    } catch (error) {
      return { sources: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      db.close();
    }
  };

  const alpaca = await storedSourcesFor([{ asset: 'SPY', asset_class: 'stocks' }], 'SPY', {
    alpacaDataClient: {
      getBars: async () =>
        FACTORY_US_OPEN_TIMES.map((openTime) => ({
          t: openTime,
          o: 100,
          h: 101,
          l: 99,
          c: 100.5,
          v: 1_000,
        })),
      getLatestQuote: async () => ({ t: SMOKE_RUN_INSTANT.toISOString(), ap: 100, bp: 99 }),
    },
  });

  const lseClient: LseMarkClient = {
    vendor: SMOKE_LSE_VENDOR,
    getBars: async () => ({
      currency: 'GBX',
      candles: factoryProbeBars(FACTORY_LSE_OPEN_TIMES),
    }),
    getLatestQuote: async () => ({
      price: 100,
      currency: 'GBX',
      observed_at: SMOKE_RUN_INSTANT,
    }),
  };
  const lse = await storedSourcesFor([{ asset: 'LQQ3', asset_class: 'stocks' }], 'LQQ3', {
    lseMarkClient: lseClient,
  });

  return {
    alpacaStoredSources: alpaca.sources,
    lseStoredSources: lse.sources,
    error: alpaca.error ?? lse.error,
  };
}

const dataSourceFactoryProbe: Probe<'dataSourceFactory'> = {
  run({ logger }) {
    return runDataSourceFactoryScenario(logger);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const factory = evidence;
    if (factory.error !== null) {
      failures.push(
        `a factory-resolved market-data source refused to build or read: ${factory.error} — ` +
          '`production/defaults.ts` resolves both surviving arms through `createDataSource`, so a ' +
          'broken arm takes the whole market-data path down at boot (#1151)',
      );
    }
    if (
      factory.alpacaStoredSources.length === 0 ||
      !factory.alpacaStoredSources.every((source) => source === 'alpaca')
    ) {
      failures.push(
        `the Alpaca arm persisted [${factory.alpacaStoredSources.join(', ')}] rather than a ` +
          "non-empty run of 'alpaca' — `createDataSource({ kind: 'alpaca' })` is what " +
          '`buildAlpacaDataSource` resolves every non-LSE universe through, so nothing durable ' +
          'here means the tick loop has no bars at all (#1151)',
      );
    }
    if (
      factory.lseStoredSources.length === 0 ||
      !factory.lseStoredSources.every((source) => source === SMOKE_LSE_VENDOR)
    ) {
      failures.push(
        `the LSE arm persisted [${factory.lseStoredSources.join(', ')}] rather than a non-empty ` +
          `run of '${SMOKE_LSE_VENDOR}' — the live equity leg's only mark path is ` +
          "`createDataSource({ kind: 'lse' })`, and it is kept precisely so #895/#1034 can land " +
          'as a config change; unreached, it is the unwired arm this ticket deleted two of (#1151)',
      );
    }
    return failures;
  },
};

export interface AnalystFailureCauseEvidence {
  debugPayloads: readonly Record<string, unknown>[];
  failureKinds: readonly string[];
}

class AnalystDebugRecorder implements Logger {
  private readonly payloads: Record<string, unknown>[] = [];

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.stage === 'analysts' && entry.level === 'debug') {
      this.payloads.push((entry.payload ?? {}) as Record<string, unknown>);
    }
    this.inner.log(entry);
  }

  evidence(failureKinds: readonly string[]): AnalystFailureCauseEvidence {
    return { debugPayloads: [...this.payloads], failureKinds };
  }
}

async function runAnalystFailureCauseScenario(
  logger: Logger,
): Promise<AnalystFailureCauseEvidence> {
  const db = openSharedStore(':memory:');
  const recorder = new AnalystDebugRecorder(logger);
  try {
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const profile = paperStartingProfile('paper');
    const signal = { asset: 'SPY', asset_class: 'stocks' as const };

    const orchestrator = buildProductionOrchestrator({
      ...profile,
      db,
      clock,
      logger: recorder,
      universe: [{ asset: signal.asset, asset_class: signal.asset_class }],
      tradingCalendar: new UsEquityRegularHoursCalendar(),
      stocksTradingWindow: () => true,
      alpacaDataClient: {
        getBars: async () => {
          throw new Error('alpaca down (smoke analyst-failure-cause probe, #1114)');
        },
        getLatestQuote: async () => ({ t: SMOKE_RUN_INSTANT.toISOString(), ap: 100, bp: 99 }),
      },
      equitiesFallbackBarFetcher: async () => {
        throw new Error('polygon down too (smoke analyst-failure-cause probe, #1114)');
      },
      dataFailoverAlerts: {
        postDataFailoverAlert: async () => {},
      },
      miArchive: new MiArchiveStore(),
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient: new UnreachableAlpacaClient(),
      llmClient: new ConstantResponseLlmClient(),
    });

    const result = await orchestrator.analysts.runAnalysts(
      'smoke-analyst-failure-cause',
      signal,
      clock,
      SMOKE_RUN_INSTANT,
    );

    return recorder.evidence(result.failures.map((failure) => failure.kind));
  } finally {
    db.close();
  }
}

const analystFailureCauseProbe: Probe<'analystFailureCause'> = {
  run({ logger }) {
    return runAnalystFailureCauseScenario(logger);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const failureCause = evidence;
    if (!failureCause.failureKinds.includes('other')) {
      failures.push(
        "the analyst failure-cause probe's double-failed data source did not produce a genuine " +
          `(non-timeout) analyst rejection (kinds observed: ${JSON.stringify(failureCause.failureKinds)}) ` +
          '— the probe itself is broken, not the mechanism it exists to gate (#1114/#1394)',
      );
    } else if (failureCause.debugPayloads.length === 0) {
      failures.push(
        'a genuine analyst rejection happened and no `stage: "analysts", level: "debug"` line was ' +
          'recorded for it — `production.ts` is not wiring its `logger` into `new ' +
          'AnalystOrchestrator({...})` (or the orchestrator fell back to its internal NOOP_LOGGER), ' +
          'so the cause behind a stage failure is back to the verdict-only line #1114 was filed ' +
          'against',
      );
    } else {
      const withCause = failureCause.debugPayloads.find(
        (payload) =>
          payload.analyst_type === 'technical' &&
          typeof payload.cause === 'string' &&
          typeof payload.name === 'string' &&
          typeof payload.message === 'string',
      );
      if (withCause === undefined) {
        failures.push(
          `debug lines were recorded (${JSON.stringify(failureCause.debugPayloads)}) but none carried ` +
            'the rendered name/message/cause a non-timeout rejection is supposed to keep — ' +
            '`renderErrorDetail` (pipeline/analysts/orchestrator.ts) stopped rendering the caught ' +
            'error, or stopped being called (#1114)',
        );
      }
    }
    return failures;
  },
};

export interface FilledZeroSizeWedgeEvidence {
  warnings: readonly {
    idempotency_key: string;
    instrument: string;
    order_state: string;
    consecutive: number;
    stuck_ms: number;
  }[];
}

const FILLED_ZERO_SIZE_WEDGE_LOT_KEY = 'smoke-filled-zero-size-wedge';
const FILLED_ZERO_SIZE_WEDGE_INSTRUMENT = 'AAPL';
const FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS = 60 * 60_000;
const FILLED_ZERO_SIZE_WEDGE_DECISION_BEFORE_OPENED_MS = 5_000;

class FilledZeroSizeWarningRecorder implements Logger {
  private readonly warnings: FilledZeroSizeWedgeEvidence['warnings'][number][] = [];

  constructor(private readonly inner: Logger) {}

  log(entry: LogEntry): void {
    if (entry.message === FILLED_WITH_ZERO_SIZE) {
      this.warnings.push(entry.payload as FilledZeroSizeWedgeEvidence['warnings'][number]);
    }
    this.inner.log(entry);
  }

  evidence(): FilledZeroSizeWedgeEvidence {
    return { warnings: [...this.warnings] };
  }
}

class SmokeWedgedLotBroker implements BrokerAdapter {
  constructor(
    private readonly order: NormalizedOrder,
    private readonly scriptedFills: NormalizedFill[],
  ) {}

  async submitBracket(): Promise<BrokerAck> {
    throw new Error(
      'SmokeWedgedLotBroker.submitBracket: this scenario seeds its position directly',
    );
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return this.order;
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.scriptedFills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('SmokeWedgedLotBroker.resizeProtectiveLegs: no new fill is ever ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error(
      'SmokeWedgedLotBroker.rearmProtectiveLegs: no partial flatten in this scenario',
    );
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    throw new Error(
      'SmokeWedgedLotBroker.resumeFlatten: reconcile() has nothing unresolved to sweep',
    );
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('SmokeWedgedLotBroker.submitFlatten: this scenario never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('SmokeWedgedLotBroker.cancel: this scenario never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

async function runFilledZeroSizeWedgeScenario(
  logger: Logger,
): Promise<FilledZeroSizeWedgeEvidence> {
  const db = openSharedStore(':memory:');
  try {
    const recorder = new FilledZeroSizeWarningRecorder(logger);
    const clock = new SimulatedClock(SMOKE_RUN_INSTANT);
    const openedAt = new Date(
      SMOKE_RUN_INSTANT.getTime() - FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS,
    );
    const brokerOrderIds = [
      `${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}:entry`,
      `${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}:stop`,
      `${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}:target`,
    ];
    const broker = new SmokeWedgedLotBroker(
      {
        client_order_id: FILLED_ZERO_SIZE_WEDGE_LOT_KEY,
        broker_order_ids: brokerOrderIds,
        order_state: 'filled',
        filled_qty: 10,
      },
      [
        {
          client_order_id: FILLED_ZERO_SIZE_WEDGE_LOT_KEY,
          broker_fill_id: toBrokerFillId('smoke-wedge-fill'),
          leg: 'entry',
          qty: 10,
          price: 100,
          fee: 1,
          timestamp: new Date(openedAt.getTime() - 1),
        },
      ],
    );
    const store = new SqliteExecutionStore(db);
    const position: OpenPosition = {
      idempotency_key: FILLED_ZERO_SIZE_WEDGE_LOT_KEY,
      debate_id: 'smoke-filled-zero-size-wedge-debate',
      instrument: FILLED_ZERO_SIZE_WEDGE_INSTRUMENT,
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10,
      filled_size: 0,
      avg_entry_price: 0,
      stop: 95,
      target: 110,
      order_state: 'submitted',
      broker_order_ids: brokerOrderIds,
      opened_at: openedAt,
      decision_timestamp: new Date(
        openedAt.getTime() - FILLED_ZERO_SIZE_WEDGE_DECISION_BEFORE_OPENED_MS,
      ),
      conviction: 0.7,
      converged: true,
    };
    await store.writeAheadPosition(position);

    const execution = buildExecutionSurface(
      {
        clock,
        broker,
        store,
        costModel: {} as unknown as CostModel,
        marketData: {} as unknown as MarketDataService,
        config: paperStartingProfile('paper').executionConfig,
        sessionCalendars: EXIT_PATH_SESSION_CALENDARS,
        residualExposureAlerts: {
          postResidualExposureAlert: async () => {
            throw new Error('SmokeWedgedLotBroker: this scenario never partially flattens');
          },
        },
        flattenOverfillAlerts: {
          postFlattenOverfillWarning: async () => {
            throw new Error('SmokeWedgedLotBroker: this scenario never flattens');
          },
        },
        flattenReconcileAlerts: {
          postFlattenReconcileAlert: async () => {
            throw new Error('SmokeWedgedLotBroker: this scenario never flattens');
          },
        },
        unrecordedVenuePositionAlerts: {
          postUnrecordedVenuePositionAlert: async () => {
            throw new Error('SmokeWedgedLotBroker: the venue holds only the wedged lot');
          },
        },
        unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
        logger: recorder,
        filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      },
      'smoke-filled-zero-size-wedge',
    );

    await execution.reconcile();
    for (let poll = 0; poll < ALERT_AFTER_CONSECUTIVE_ZERO_SIZE; poll += 1) {
      await execution.ingestFills();
    }

    return recorder.evidence();
  } finally {
    db.close();
  }
}

const filledZeroSizeWedgeProbe: Probe<'filledZeroSizeWedge'> = {
  run({ logger }) {
    return runFilledZeroSizeWedgeScenario(logger);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const wedge = evidence;
    if (wedge.warnings.length !== 1) {
      failures.push(
        `the FILLED_WITH_ZERO_SIZE wedge scenario produced ${wedge.warnings.length} warning(s), ` +
          "expected exactly 1 — either the scenario's wedged lot never reached the throttle's " +
          'first-warning threshold (ALERT_AFTER_CONSECUTIVE_ZERO_SIZE consecutive zero-filled-size ' +
          "polls), ingest-fills.ts's own no-new-fills zero-filled-size warning branch has been " +
          "removed or stopped firing, or execution.reconcile() no longer adopts the broker's " +
          "'filled' order_state onto this lot (that branch is guarded on " +
          "order_state === 'filled' || 'partially_filled' — if reconcile's adopt semantics change " +
          "so the lot stays 'submitted', this branch is never reached and zero warnings fire even " +
          'though it is fully intact) (#1125)',
      );
    } else {
      const [warning] = wedge.warnings;
      if (
        warning === undefined ||
        warning.idempotency_key !== FILLED_ZERO_SIZE_WEDGE_LOT_KEY ||
        warning.instrument !== FILLED_ZERO_SIZE_WEDGE_INSTRUMENT ||
        warning.order_state !== 'filled' ||
        warning.consecutive !== ALERT_AFTER_CONSECUTIVE_ZERO_SIZE ||
        warning.stuck_ms !== FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS
      ) {
        failures.push(
          `the FILLED_WITH_ZERO_SIZE warning fired with an unexpected shape ` +
            `(${JSON.stringify(warning)}) — expected idempotency_key ` +
            `'${FILLED_ZERO_SIZE_WEDGE_LOT_KEY}', instrument '${FILLED_ZERO_SIZE_WEDGE_INSTRUMENT}', ` +
            `order_state 'filled', consecutive ${ALERT_AFTER_CONSECUTIVE_ZERO_SIZE} and stuck_ms ` +
            `${FILLED_ZERO_SIZE_WEDGE_OPENED_BEFORE_MS} (#1125)`,
        );
      }
    }
    return failures;
  },
};

export interface RiskCriticEvidence {
  loggedVerdicts: readonly string[];
  stepError: string | null;
  conditionStates: readonly string[];
  bindingConstraint: string | null;
}

class SmokeLlmClient implements LlmClient {
  readonly #debate = new ConstantResponseLlmClient();

  get calls(): number {
    return this.#debate.calls;
  }

  async complete<T>(request: LlmRequest<T>): Promise<LlmResponse<T>> {
    if (request.context.attribution?.stage !== 'risk_critic') {
      return this.#debate.complete(request);
    }
    const rawText = JSON.stringify({
      verdict: 'pass',
      max_notional: null,
      reasoning: 'smoke fixture: no narrative risk, one falsifying condition',
      conditions: [
        {
          id: 'smoke-thesis-needs-price-above-threshold',
          observable: { kind: 'mark' },
          comparator: '<',
          threshold: SMOKE_MARK_PRICE + 1,
          rationale: 'below this the breakout that justified the entry has already failed',
        },
      ],
    });
    const parsed = request.parseResponse(rawText);
    if (!parsed.valid) {
      throw new Error(
        `SmokeLlmClient: the critic fixture no longer satisfies the critic parser ` +
          `(${parsed.reason}) — the stub payload and the critic schema have drifted apart.`,
      );
    }
    return { data: parsed.data, raw_text: rawText, latency_ms: 0 };
  }
}

async function runRiskCriticScenario(logger: Logger): Promise<RiskCriticEvidence> {
  const db = openSharedStore(':memory:');
  try {
    const { clock, profile, dataSource } = buildSmokeClockAndDataSource();

    const components = buildProductionComponents({
      ...profile,
      db,
      clock,
      logger,
      universe: SMOKE_TEST_UNIVERSE,
      tradingCalendar: new AlwaysOpenCalendar(),
      stocksTradingWindow: () => true,
      dataSource,
      miArchive: new MiArchiveStore(),
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient: new UnreachableAlpacaClient(),
      llmClient: new SmokeLlmClient(),
    });

    const intent = exitPathOrder(
      SMOKE_INSTRUMENT,
      'smoke-risk-critic-entry',
      'buy',
      'entry',
      1,
      SMOKE_RUN_INSTANT,
    );

    let stepError: string | null = null;
    let bindingConstraint: string | null = null;
    try {
      const decision = await components.steps.risk({
        trace_id: 'smoke-risk-critic',
        intent,
        clock,
      });
      bindingConstraint = decision.binding_constraint;
    } catch (error) {
      stepError = error instanceof Error ? error.message : String(error);
    }

    const logged = db
      .prepare('SELECT verdict, conditions_json FROM risk_critic_log ORDER BY rowid')
      .all() as { verdict: string; conditions_json: string | null }[];

    return {
      loggedVerdicts: logged.map((row) => row.verdict),
      stepError,
      conditionStates: logged.flatMap((row) => readSmokeConditionStates(row.conditions_json)),
      bindingConstraint,
    };
  } finally {
    db.close();
  }
}

const riskCriticProbe: Probe<'riskCritic'> = {
  run({ logger }) {
    return runRiskCriticScenario(logger);
  },
  verdict(evidence) {
    const failures: string[] = [];
    const critic = evidence;
    if (critic.stepError !== null) {
      failures.push(
        `the risk step threw while consulting the critic: ${critic.stepError} — step 7 is ` +
          'specified to FAIL OPEN (a decision proceeds on the mechanical steps with ' +
          'risk_critic: skipped), so a throw here turns an unreachable model into a dead tick ' +
          'in front of an order (#957, ADR-0003)',
      );
    }
    if (critic.loggedVerdicts.length === 0) {
      failures.push(
        'a viable entry reached the risk stage through the real composition root and no ' +
          'risk_critic_log row was written — the critic producer is not wired at all, so ' +
          'check-pipeline step 7 is back to the never-run state review F-5 recorded, and every ' +
          'decision silently records risk_critic: skipped while looking healthy (#957)',
      );
    }

    if (!critic.conditionStates.includes('breached')) {
      failures.push(
        'the risk critic emitted a well-formed invalidation condition and no persisted ' +
          `condition measured \`breached\` (states: ${JSON.stringify(critic.conditionStates)}) — ` +
          'the deterministic evaluator did not run over the fixture feed, so the typed ' +
          'invalidation half is emitted and measured by nothing (#994)',
      );
    } else if (critic.bindingConstraint !== 'risk_critic:invalidated') {
      failures.push(
        'a measured BREACHED invalidation condition did not reject the intent (binding ' +
          `constraint: ${critic.bindingConstraint ?? 'none'}) — \`evaluate()\` holds that ` +
          'authority (#997 Q2b), so a breach that only gets logged is a checklist with no ' +
          'teeth (#994)',
      );
    }
    return failures;
  },
};

export interface PromptTierWarningEvidence {
  alertsFired: number;
  spendRows: number;
  costUsd: number | null;
}

function runPromptTierWarningScenario(): PromptTierWarningEvidence {
  const db = openSharedStore(':memory:');
  try {
    const alerts: PromptTierAlert[] = [];
    const store = new SqliteLlmSpendStore(db, undefined, false, {
      postPromptTierAlert: (alert) => {
        alerts.push(alert);
      },
    });

    const crossingUsage = { input_tokens: 200_001, output_tokens: 1_000 };
    const record = () =>
      store.record({
        trace_id: 'smoke-prompt-tier',
        stage: 'debate',
        model: 'x-ai/grok-4.5',
        usage: crossingUsage,
        latency_ms: 10,
        timestamp: SMOKE_RUN_INSTANT,
      });

    record();
    record();

    const rows = db.prepare('SELECT cost_usd FROM llm_spend ORDER BY id').all() as {
      cost_usd: number | null;
    }[];

    return {
      alertsFired: alerts.length,
      spendRows: rows.length,
      costUsd: rows[0]?.cost_usd ?? null,
    };
  } finally {
    db.close();
  }
}

const promptTierWarningProbe: Probe<'promptTierWarning'> = {
  run() {
    return runPromptTierWarningScenario();
  },
  verdict(promptTierWarning) {
    const failures: string[] = [];
    if (promptTierWarning.spendRows !== 2) {
      failures.push(
        `the prompt-tier scenario's two metered calls wrote ${promptTierWarning.spendRows} ` +
          '`llm_spend` row(s), not 2 — the scenario itself is broken, not the mechanism it exists ' +
          'to gate (#1155)',
      );
    } else if (promptTierWarning.costUsd === null || promptTierWarning.costUsd < 0.8) {
      failures.push(
        `the crossing call priced at $${String(promptTierWarning.costUsd)}, not at x-ai/grok-4.5's ` +
          "large-prompt TIER rate (~$0.812) — the scenario's own fixture usage does not actually " +
          'cross the tier, so its alert count proves nothing about #1155',
      );
    } else if (promptTierWarning.alertsFired !== 1) {
      failures.push(
        `two consecutive calls that cross the SAME model's prompt tier produced ` +
          `${promptTierWarning.alertsFired} alert(s), not exactly 1 — either \`crossesPromptTier\` ` +
          '(pricing.ts) is not being consulted inside `SqliteLlmSpendStore.record` at all (0 ' +
          'alerts: the exact silent-2.5x-step #1155 was filed against), or the crossing is not ' +
          'throttled (2 alerts: a retrieval-heavy model would page on every single call)',
      );
    }
    return failures;
  },
};

function readSmokeConditionStates(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String((entry as { state?: unknown }).state));
  } catch {
    return [];
  }
}

interface TickLoopEvidence {
  minTicks: number;
  alpacaWireClientReached: boolean;
}

interface LlmSpendCapEvidence {
  publishedCapUsd: number | null;
  configuredBudgetUsd: number | undefined;
  capArmedAt: string | null;
}

export interface SmokeEvidence {
  tickLoop: TickLoopEvidence;
  llmRateLimiterSnapshot: RateLimiterSnapshot;
  exitPath: ExitPathEvidence;
  cryptoEmulation: CryptoEmulationEvidence;
  loggerResilience: LoggerResilienceEvidence;
  logRetention: LogRetentionEvidence;
  entrypointFaultGuards: EntrypointFaultGuardEvidence;
  thresholdClamp: ThresholdClampEvidence;
  approvalFallback: ApprovalFallbackEvidence;
  dataFailover: DataFailoverEvidence;
  dataSourceFactory: DataSourceFactoryEvidence;
  riskCritic: RiskCriticEvidence;
  promptTierWarning: PromptTierWarningEvidence;
  analystFailureCause: AnalystFailureCauseEvidence;
  filledZeroSizeWedge: FilledZeroSizeWedgeEvidence;
  armComparison: ArmComparisonEvidence;
  outsideBenchmarks: OutsideBenchmarkEvidence;
  feedbackCycleScheduleWritten: boolean;
  sizingCeiling: SizingCeilingEvidence;
  llmSpendCap: LlmSpendCapEvidence;
  fillSync: FillSyncFailureEvidence;
  marketDataFetch: MarketDataFetchEvidence;
}

type ProbeId = keyof SmokeEvidence;

interface ProbeRunContext {
  db: StoreHandle;
  clock: SimulatedClock;
  profile: ReturnType<typeof paperStartingProfile>;
  logger: Logger;
  targetTicks: number;
  approvals: ApprovalChannel;
  alpacaBrokerClient: UnreachableAlpacaClient;
  llmRateLimiter: RateLimiter;
  tickLoopResidualAlerts: RecordingResidualExposureAlertChannel;
  fillSyncFailures: FillSyncFailureRecorder;
  marketDataFetch: MarketDataFetchRecorder;
}

interface VerdictContext<After extends ProbeId> {
  observations: SmokeObservations;
  prior: Pick<SmokeEvidence, After>;
}

interface Probe<Id extends ProbeId, After extends ProbeId = never> {
  after?: readonly After[];
  run(
    ctx: ProbeRunContext,
    prior: Pick<SmokeEvidence, After>,
  ): SmokeEvidence[Id] | Promise<SmokeEvidence[Id]>;
  verdict(evidence: SmokeEvidence[Id], ctx: VerdictContext<After>): string[];
  report?(evidence: SmokeEvidence[Id], observations: SmokeObservations): string[];
}

function summariseVerdicts(verdicts: SmokeObservations['verdicts']): string {
  if (verdicts.length === 0) return 'none';
  return verdicts
    .map((verdict) => `${verdict.status}${verdict.no_go_reason ? `:${verdict.no_go_reason}` : ''}`)
    .join(', ');
}

function tickLoopWireAndTickFailures(
  evidence: TickLoopEvidence,
  observations: SmokeObservations,
): string[] {
  const failures: string[] = [];
  const { ticks } = observations;
  if (evidence.alpacaWireClientReached) {
    failures.push(
      'the Alpaca wire client was reached during an offline run — this run is credential-free ' +
        'and must make no network call. The composition root now needs the wire client for ' +
        'something the smoke run overrides; see UnreachableAlpacaClient',
    );
  }

  if (ticks.length < evidence.minTicks) {
    failures.push(
      `the tick loop completed ${ticks.length} of ${evidence.minTicks} expected ticks — the ` +
        'loop, the scheduler or the shutdown drain did not behave over repeated ticks',
    );
  }

  const pastAnalysts = ticks.filter((tick) =>
    tick.stages.some((entry) => entry.stage !== 'analysts'),
  );
  if (pastAnalysts.length === 0) {
    failures.push(
      'no tick got past Analysts — every pass short-circuited at the quorum gate, so Debate, ' +
        'Trader, Risk, Verdict and Execution were never exercised at all (this is exactly what ' +
        'a credential-less real run does today, and the reason #350 exists)',
    );
  }
  return failures;
}

function tickLoopDebateLogFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  const { debates } = observations;
  if (debates.length === 0) {
    failures.push(
      'no row in debate_log — a tick got past Analysts but no resolved debate was persisted, so ' +
        "the Feedback Loop's weight attribution (attribution.ts joins closed_trades.debate_id " +
        'against debate_log) has no input and the debate itself is unreconstructable after the ' +
        'fact (audit_log holds digests only). This is the #364 defect exactly',
    );
  }

  const unclassified = debates.filter((debate) => debate.termination == null);
  if (debates.length > 0 && unclassified.length > 0) {
    failures.push(
      `${unclassified.length} of ${debates.length} debate_log row(s) have a NULL termination — ` +
        'buildDebateLog (debate-log-store.ts) stopped setting it. That reopens #1081: a debate ' +
        'the latency budget truncated becomes indistinguishable, in the stored record, from one ' +
        'the analysts genuinely could not agree on.',
    );
  }
  return failures;
}

function tickLoopControlArmFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  const { ticks, positions } = observations;
  const transactedThisRun = ticks.some((tick) =>
    tick.stages.some((entry) => entry.stage === 'execution'),
  );
  if (transactedThisRun) {
    const controlLots = positions.filter((position) => position.arm === 'control');
    if (controlLots.length === 0) {
      failures.push(
        "a tick reached Execution but not one `open_positions` row carries `arm = 'control'` — " +
          'falsifier arm 2 (#753) did not run against the tape the live arm just traded. Either ' +
          '`TickSteps.controlArm` is unbound in the composition root or the control arm threw ' +
          'and was swallowed; a soak in this state produces a live track with no matched ' +
          'control, which ADR-0014 amendment 2 and ADR-0017 both require',
      );
    }
    const liveKeys = new Set(
      positions.filter((position) => position.arm === 'live').map((row) => row.idempotency_key),
    );
    const collided = controlLots.filter((row) => liveKeys.has(row.idempotency_key));
    if (collided.length > 0) {
      failures.push(
        `${collided.length} control lot(s) share an idempotency key with a live lot — \`arm\` has ` +
          'stopped being a hash input to `computeIdempotencyKey`, so on every bar the two arms ' +
          "agree on, Execution's `findByKey` gate silently drops the control order. The " +
          'comparison would then be biased on exactly the subset it is most sensitive to',
      );
    }
  }
  return failures;
}

const TICK_LOOP_DOWNSTREAM_CHECKS: ReadonlyArray<{
  failed: (observations: SmokeObservations) => boolean;
  message: string;
}> = [
  {
    failed: (observations) =>
      observations.debates.length > 0 && observations.cosineSetups.length === 0,
    message:
      'a debate resolved and reached the Trader, but no row in cosine_setups — `decide()` did ' +
      'not write the setup it embedded, so cosine retrieval has nothing to find and every ' +
      'position takes the permanent 0.75x no-precedent haircut. This is the #432 defect ' +
      'exactly: retrieval (#75) and the store (#198) both existed and `decide()` called ' +
      'neither, while the whole unit suite passed',
  },
  {
    failed: (observations) => observations.riskThresholds.length === 0,
    message:
      'no row in risk_thresholds — the composition root did not seed the dials, so ' +
      "`autoTighten` has no current value to step from and the Feedback Loop's defensive " +
      'response to a kill-line breach tightens nothing. This is the #433 defect: the write ' +
      'end existed and the read end did not, and nothing failed',
  },
  {
    failed: (observations) =>
      observations.debates.length > 0 && observations.traderDecisions.length === 0,
    message:
      'a debate resolved and reached the Trader, but no row in trader_log — the decision ' +
      'record is not wired, so why a size came out at N (or why nothing traded at all) is ' +
      'reconstructable only from an `audit_log` digest and ephemeral stdout. Note the ' +
      'Trader writes on a SKIP too, so this cannot be explained by a quiet tick',
  },
  {
    failed: (observations) =>
      observations.traderDecisions.length > 0 && observations.riskDecisions.length === 0,
    message:
      'the Trader produced an intent but no row in risk_log — Risk evaluated it and left no ' +
      'record of what portfolio state it sized against or which gate bound. A rejected ' +
      'intent never reaches Verdict, so with this unwired a rejection has no durable ' +
      'record anywhere in the system',
  },
  {
    failed: (observations) => observations.analystWeights.length === 0,
    message:
      'no row in analyst_weights — the startup seeder did not run, so `runDailyCycle` skips ' +
      'every analyst it cannot find a row for and the loop attributes nothing while reporting ' +
      'a clean run. This is the #371 defect',
  },
  {
    failed: (observations) => {
      const breakerTiers = new Set(observations.breakerStates.map((row) => row.tier));
      return !breakerTiers.has('portfolio_drawdown') || !breakerTiers.has('kill_switch');
    },
    message:
      'breaker_state is missing a tier row — the tick path never persisted the sticky ' +
      "breakers' state, so a tripped hard-drawdown breaker or kill switch re-arms itself on " +
      'restart. Under ADR-0007 the breakers are the only remaining stop; this table sat ' +
      'unwritten behind a doc comment claiming "the caller persists this" (review 2026-08-06 B1)',
  },
];

function tickLoopDownstreamRecordFailures(observations: SmokeObservations): string[] {
  return TICK_LOOP_DOWNSTREAM_CHECKS.filter((check) => check.failed(observations)).map(
    (check) => check.message,
  );
}

function tickLoopVerdictFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  const { verdicts } = observations;
  const undetailedStaleness = verdicts.filter(
    (verdict) =>
      (verdict.no_go_reason === 'staleness' || verdict.no_go_reason === 'stale_feed') &&
      (verdict.no_go_detail_measured_ms == null || verdict.no_go_detail_bound_ms == null),
  );
  if (undetailedStaleness.length > 0) {
    failures.push(
      `${undetailedStaleness.length} verdict_log row(s) refused on staleness/stale_feed without ` +
        `recording what was measured (${undetailedStaleness
          .map((verdict) => `${verdict.instrument}:${verdict.no_go_reason}`)
          .join(', ')}) — the cause is unrecoverable from the row, which is what #1111 fixed`,
    );
  }

  if (!verdicts.some((verdict) => verdict.status === 'go')) {
    failures.push(
      `no GO verdict was recorded in verdict_log (${verdicts.length} verdict row(s): ` +
        `${summariseVerdicts(verdicts)}) — the pipeline never authorised a trade`,
    );
  }
  return failures;
}

function tickLoopExecutionFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  const { ticks, positions, fills } = observations;
  const submitted = ticks.flatMap((tick) =>
    tick.stages.filter((entry) => entry.stage === 'execution' && entry.decision === 'submitted'),
  );
  if (submitted.length === 0) {
    failures.push(
      'no tick reached Execution with a `submitted` result — nothing was ever handed to the ' +
        'broker adapter',
    );
  }

  if (positions.length === 0) {
    failures.push(
      'no row in open_positions — Execution never wrote a lot ahead of the broker call, so ' +
        'there is nothing for reconcile() or the fill poll to advance',
    );
  }

  if (!fills.some((fill) => fill.leg === 'entry')) {
    failures.push(
      'no entry fill in fills — the order was submitted but no fill was ever ingested, so the ' +
        'fill-sync poll (ingestFills) is not draining the venue feed',
    );
  }
  return failures;
}

function tickLoopGdeltFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  if (observations.gdeltRowsArchived !== SMOKE_GDELT_EXPECTED_ROWS) {
    failures.push(
      `GDELT archived ${observations.gdeltRowsArchived} macro rows, expected exactly ` +
        `${SMOKE_GDELT_EXPECTED_ROWS} — ` +
        `${SMOKE_GDELT_SEEDED_ROWS} means the poller never ran from the composition root, ` +
        `${SMOKE_GDELT_EXPECTED_ROWS + 1} means the theme filter matched both canned rows and ` +
        'is no longer filtering (#556)',
    );
  }

  if (observations.gdeltAggregateItems !== SMOKE_GDELT_EXPECTED_AGGREGATES) {
    failures.push(
      `GDELT scoring derived ${observations.gdeltAggregateItems} macro aggregates, expected ` +
        `exactly ${SMOKE_GDELT_EXPECTED_AGGREGATES} (one per asset class) — 0 means the ` +
        'scoring pass never ran from the composition root, or refused on a baseline the seed ' +
        'was supposed to have filled (#1086)',
    );
  }
  return failures;
}

function tickLoopPolymarketFailures(observations: SmokeObservations): string[] {
  const failures: string[] = [];
  if (observations.polymarketRowsArchived !== SMOKE_POLYMARKET_EXPECTED_ITEMS) {
    failures.push(
      `Polymarket archived ${observations.polymarketRowsArchived} macro rows, expected exactly ` +
        `${SMOKE_POLYMARKET_EXPECTED_ITEMS} — 0 means the startup refresh never ran from the ` +
        'composition root, more means the fail-closed guard stopped refusing the thin-volume ' +
        'market the fixture serves (#504)',
    );
  }
  if (observations.polymarketItemsArchived !== SMOKE_POLYMARKET_EXPECTED_ITEMS) {
    failures.push(
      `Polymarket archived ${observations.polymarketItemsArchived} items in mi_items, expected ` +
        `exactly ${SMOKE_POLYMARKET_EXPECTED_ITEMS} — 0 with rows archived means the source is ` +
        'back to writing raw bytes with no items, which makes it unreplayable as items (#835)',
    );
  }
  if (observations.polymarketIntelItems !== SMOKE_POLYMARKET_EXPECTED_ITEMS) {
    failures.push(
      `Polymarket put ${observations.polymarketIntelItems} items in the intel bucket, expected ` +
        `exactly ${SMOKE_POLYMARKET_EXPECTED_ITEMS} — 0 with rows archived means the items ` +
        'never reached MarketIntelligenceStore, were dropped by the entity filter, or were ' +
        'stamped outside the debate bar the analysts query. This read is ENTITY-SCOPED like ' +
        "every analyst read, so an item that lost `scope: 'asset_class'` reads 0 here with " +
        'a row archived: filed under a macro series name, it matches no ticker (#914/#960), ' +
        "and #1164's routing (`scope: 'asset_class'` -> `intel`, not `news`) would also read " +
        '0 here if that predicate broke. Items also carry the INGEST INSTANT (#782), and ' +
        'getContext floors its window to the hour, so this count depends on SMOKE_RUN_INSTANT ' +
        'being exactly hour-aligned — a smoke clock that drifts off the hour before the ' +
        'startup refresh lands would read 0 here with a row archived (#504, #782)',
    );
  }
  return failures;
}

const tickLoopProbe: Probe<'tickLoop'> = {
  run({ targetTicks, alpacaBrokerClient }) {
    return { minTicks: targetTicks, alpacaWireClientReached: alpacaBrokerClient.reached };
  },
  verdict(evidence, { observations }) {
    const failures: string[] = [];
    failures.push(...tickLoopWireAndTickFailures(evidence, observations));
    failures.push(...tickLoopDebateLogFailures(observations));
    failures.push(...tickLoopControlArmFailures(observations));
    failures.push(...tickLoopDownstreamRecordFailures(observations));
    failures.push(...tickLoopVerdictFailures(observations));
    failures.push(...tickLoopExecutionFailures(observations));
    failures.push(...tickLoopGdeltFailures(observations));
    failures.push(...tickLoopPolymarketFailures(observations));
    return failures;
  },
  report(_evidence, observations) {
    const lines: string[] = [`ticks completed: ${observations.ticks.length}`];

    for (const [index, tick] of observations.ticks.entries()) {
      const reached = tick.stages.map((entry) => `${entry.stage}:${entry.decision}`).join(' -> ');
      lines.push(`  tick ${index + 1} [${tick.trace_id}] ${reached}`);
    }

    lines.push('', `debates logged: ${observations.debates.length}`);
    for (const debate of observations.debates) {
      lines.push(
        `  ${debate.instrument} ${debate.direction} rounds=${debate.rounds} [${debate.debate_id}]`,
      );
    }

    lines.push('', `verdicts recorded: ${observations.verdicts.length}`);
    for (const verdict of observations.verdicts) {
      lines.push(
        `  ${verdict.instrument} ${verdict.status}${
          verdict.no_go_reason ? ` (${verdict.no_go_reason})` : ''
        } [${verdict.trace_id}]`,
      );
    }

    lines.push('', `lots submitted to the broker: ${observations.positions.length}`);
    for (const position of observations.positions) {
      lines.push(
        `  ${position.instrument} ${position.side} requested=${position.requested_size} ` +
          `filled=${position.filled_size} @ ${position.avg_entry_price} ` +
          `state=${position.order_state} [${position.idempotency_key}]`,
      );
    }

    lines.push('', `fills ingested: ${observations.fills.length}`);
    for (const fill of observations.fills) {
      lines.push(
        `  ${fill.leg} qty=${fill.qty} @ ${fill.price} fee=${fill.fee} [${fill.idempotency_key}]`,
      );
    }

    lines.push('', `closed trades: ${observations.closedTrades.length}`);
    for (const trade of observations.closedTrades) {
      lines.push(
        `  ${trade.close_reason} realized_pnl_net=${trade.realized_pnl_net} [${trade.idempotency_key}]`,
      );
    }

    lines.push('', `flatten submissions journalled: ${observations.flattenSubmissions.length}`);
    for (const row of observations.flattenSubmissions) {
      lines.push(`  ${row.instrument} status=${row.status} [${row.idempotency_key}]`);
    }

    lines.push('', `GDELT macro rows archived: ${observations.gdeltRowsArchived}`);
    lines.push(`GDELT macro aggregates derived: ${observations.gdeltAggregateItems}`);
    lines.push(
      `Polymarket macro rows archived: ${observations.polymarketRowsArchived}, ` +
        `items archived: ${observations.polymarketItemsArchived}, ` +
        `intel items served: ${observations.polymarketIntelItems}`,
    );

    return lines;
  },
};

const llmRateLimiterSnapshotProbe: Probe<'llmRateLimiterSnapshot'> = {
  run({ llmRateLimiter }) {
    return llmRateLimiter.snapshot();
  },
  verdict(evidence, { observations }) {
    const failures: string[] = [];
    const { debates } = observations;
    if (debates.length > 0) {
      const totals = Object.values(evidence);
      const llmCallsUsed = totals.reduce((sum, entry) => sum + entry.llmCallsUsed, 0);
      const debatesUsed = totals.reduce((sum, entry) => sum + entry.debatesUsed, 0);
      if (debatesUsed === 0 || llmCallsUsed === 0) {
        failures.push(
          `debates resolved (${debates.length} row(s) in debate_log) but the LLM RateLimiter ` +
            `metered ${debatesUsed} debate(s) and ${llmCallsUsed} call(s) — so it is constructed ` +
            'beside the LLM path rather than in it. This is the #388 defect exactly: the ' +
            'component was implemented, tested and exported while nothing in production ever ' +
            'called it, and the whole unit suite passed the entire time',
        );
      }
    }

    const smokeAssetClass = new Map<string, AssetClass>(
      SMOKE_TEST_UNIVERSE.map((entry) => [entry.asset, entry.asset_class]),
    );
    const overCap = debates.filter((debate) => {
      const assetClass = smokeAssetClass.get(debate.instrument) ?? 'crypto';
      return debate.rounds > MAX_ROUNDS_BY_ASSET_CLASS[assetClass];
    });
    if (overCap.length > 0) {
      failures.push(
        `${overCap.length} debate_log row(s) ran more rounds than their asset class's cap ` +
          '(#581) — the per-asset-class round cap is no longer reaching `runDebate` from the ' +
          'composition root, so live crypto debates are back to blowing their latency budget ' +
          'on every tick',
      );
    }
    for (const assetClass of ['crypto', 'stocks'] as const satisfies readonly AssetClass[]) {
      const entry = evidence[assetClass];
      if (entry === undefined) continue;
      const perDebateBound = worstCaseLlmCallsForAssetClass(assetClass);
      if (entry.debatesUsed > 0 && entry.llmCallsUsed > entry.debatesUsed * perDebateBound) {
        failures.push(
          `the ${assetClass} limiter metered ${entry.llmCallsUsed} LLM call(s) across ` +
            `${entry.debatesUsed} debate(s), above the per-debate worst case of ` +
            `${perDebateBound} (#581) — a debate is spending calls its reservation never ` +
            'booked, so admission control is under-reserving',
        );
      }
    }
    return failures;
  },
};

const PROBES: { [K in ProbeId]: Probe<K, ProbeId> } = {
  tickLoop: tickLoopProbe,
  llmRateLimiterSnapshot: llmRateLimiterSnapshotProbe,
  exitPath: exitPathProbe,
  cryptoEmulation: cryptoEmulationProbe,
  loggerResilience: loggerResilienceProbe,
  logRetention: logRetentionProbe,
  entrypointFaultGuards: entrypointFaultGuardsProbe,
  thresholdClamp: thresholdClampProbe,
  approvalFallback: approvalFallbackProbe,
  dataFailover: dataFailoverProbe,
  dataSourceFactory: dataSourceFactoryProbe,
  riskCritic: riskCriticProbe,
  promptTierWarning: promptTierWarningProbe,
  analystFailureCause: analystFailureCauseProbe,
  filledZeroSizeWedge: filledZeroSizeWedgeProbe,
  armComparison: armComparisonProbe,
  outsideBenchmarks: outsideBenchmarksProbe,
  feedbackCycleScheduleWritten: feedbackCycleScheduleWrittenProbe,
  sizingCeiling: sizingCeilingProbe,
  llmSpendCap: llmSpendCapProbe,
  fillSync: fillSyncProbe,
  marketDataFetch: marketDataFetchProbe,
};

type MissingFrom<Order extends readonly ProbeId[]> = Exclude<ProbeId, Order[number]>;

function everyProbeOnce<const Order extends readonly ProbeId[]>(
  order: Order & ([MissingFrom<Order>] extends [never] ? unknown : { missing: MissingFrom<Order> }),
): Order {
  if (new Set(order).size !== order.length) {
    throw new Error(`a probe is listed twice in [${order.join(', ')}]`);
  }
  return order;
}

const PROBE_RUN_ORDER = everyProbeOnce([
  'tickLoop',
  'exitPath',
  'cryptoEmulation',
  'loggerResilience',
  'logRetention',
  'entrypointFaultGuards',
  'thresholdClamp',
  'approvalFallback',
  'dataFailover',
  'dataSourceFactory',
  'riskCritic',
  'promptTierWarning',
  'analystFailureCause',
  'filledZeroSizeWedge',
  'armComparison',
  'outsideBenchmarks',
  'llmRateLimiterSnapshot',
  'feedbackCycleScheduleWritten',
  'sizingCeiling',
  'llmSpendCap',
  'fillSync',
  'marketDataFetch',
]);

const PROBE_VERDICT_ORDER = everyProbeOnce([
  'tickLoop',
  'llmRateLimiterSnapshot',
  'armComparison',
  'feedbackCycleScheduleWritten',
  'sizingCeiling',
  'llmSpendCap',
  'outsideBenchmarks',
  'loggerResilience',
  'logRetention',
  'entrypointFaultGuards',
  'thresholdClamp',
  'approvalFallback',
  'dataFailover',
  'dataSourceFactory',
  'riskCritic',
  'promptTierWarning',
  'analystFailureCause',
  'filledZeroSizeWedge',
  'exitPath',
  'cryptoEmulation',
  'fillSync',
  'marketDataFetch',
]);

async function runProbes(ctx: ProbeRunContext): Promise<SmokeEvidence> {
  const gathered: Partial<SmokeEvidence> = {};
  const runOne = async <Id extends ProbeId>(id: Id): Promise<void> => {
    const probe = PROBES[id];
    for (const dependency of probe.after ?? []) {
      if (gathered[dependency] === undefined) {
        throw new Error(
          `probe '${id}' runs after '${dependency}', which comes later in PROBE_RUN_ORDER`,
        );
      }
    }
    gathered[id] = await probe.run(ctx, gathered as SmokeEvidence);
  };
  for (const id of PROBE_RUN_ORDER) await runOne(id);
  return gathered as SmokeEvidence;
}

function probeVerdict<Id extends ProbeId>(
  id: Id,
  evidence: SmokeEvidence,
  observations: SmokeObservations,
): string[] {
  return PROBES[id].verdict(evidence[id], { observations, prior: evidence });
}

function probeReport<Id extends ProbeId>(
  id: Id,
  evidence: SmokeEvidence,
  observations: SmokeObservations,
): string[] {
  return PROBES[id].report?.(evidence[id], observations) ?? [];
}

export function evaluateSmokeGate(
  observations: SmokeObservations,
  evidence: SmokeEvidence,
): SmokeGateResult {
  const failures = PROBE_VERDICT_ORDER.flatMap((id) => probeVerdict(id, evidence, observations));
  return { passed: failures.length === 0, failures };
}

export function formatSmokeReport(
  observations: SmokeObservations,
  evidence: SmokeEvidence,
  gate: SmokeGateResult,
): string[] {
  const lines: string[] = [
    '',
    '=== Samurai offline end-to-end smoke run (#350) ===',
    'mode=paper  broker=SimulatedBrokerAdapter  data=FixtureDataSource  llm=ConstantResponseLlmClient',
    `no credentials, no network, no money. Clock frozen at ${SMOKE_RUN_INSTANT.toISOString()}`,
    '',
  ];
  for (const id of PROBE_VERDICT_ORDER) lines.push(...probeReport(id, evidence, observations));

  lines.push('');
  if (gate.passed) {
    lines.push('GATE: PASS — the pipeline transacted end to end in a real process.');
  } else {
    lines.push('GATE: FAIL — the pipeline did not transact end to end:');
    for (const failure of gate.failures) lines.push(`  - ${failure}`);
  }
  lines.push('');

  return lines;
}

export interface SmokeRunOptions {
  ticks?: number;
  tickIntervalMs?: number;
  fillPollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  deadlineMs?: number;
  logger?: Logger;
}

const DEFAULT_SMOKE_TICKS = 3;
const DEFAULT_SMOKE_TICK_INTERVAL_MS = 250;
const DEFAULT_SMOKE_FILL_POLL_INTERVAL_MS = 100;
const DEFAULT_SMOKE_HEARTBEAT_INTERVAL_MS = 100;
const DEFAULT_SMOKE_DEADLINE_MS = 30_000;
const FILL_GRACE_MS = 2_000;
const OBSERVE_INTERVAL_MS = 25;
const SMOKE_TRADING_ARMS: readonly TradingArm[] = ['live', 'control'];

async function waitUntil(check: () => boolean, deadline: number): Promise<void> {
  while (Date.now() < deadline && !check()) {
    await delay(OBSERVE_INTERVAL_MS);
  }
}

export interface SmokeRunResult {
  observations: SmokeObservations;
  gate: SmokeGateResult;
  report: string[];
}

export async function runSmoke(options: SmokeRunOptions = {}): Promise<SmokeRunResult> {
  const targetTicks = options.ticks ?? DEFAULT_SMOKE_TICKS;
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_SMOKE_TICK_INTERVAL_MS;
  const fillPollIntervalMs = options.fillPollIntervalMs ?? DEFAULT_SMOKE_FILL_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_SMOKE_HEARTBEAT_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_SMOKE_DEADLINE_MS;
  const fillSyncFailures = new FillSyncFailureRecorder(options.logger ?? new JsonLogger());
  const marketDataFetch = new MarketDataFetchRecorder(fillSyncFailures);
  const logger: Logger = marketDataFetch;
  const db = openSharedStore(':memory:');

  try {
    const { clock, profile, dataSource } = buildSmokeClockAndDataSource();

    const marketDataForBroker = new MarketDataServiceImpl(
      dataSource,
      clock,
      'live',
      new SqliteMarketDataStore(db),
    );
    const broker = new SimulatedBrokerAdapter({
      clock,
      costModel: new CostModelImpl(profile.costConfig),
      marketData: marketDataForBroker,
      config: profile.executionConfig.simulated,
    });
    const alpacaBrokerClient = new UnreachableAlpacaClient();
    const llmRateLimiter = new RateLimiter(clock, profile.rateLimiterConfig);
    const tickLoopResidualAlerts = new RecordingResidualExposureAlertChannel(
      loggingAlertChannel('residualExposureAlerts', logger),
    );
    const smokeMiArchive = new MiArchiveStore();
    seedSmokeGdeltBaseline(smokeMiArchive);

    const smokeAlertChannels = {
      heartbeatChannel: loggingAlertChannel('heartbeatChannel', logger),
      orphanAlerts: loggingAlertChannel('orphanAlerts', logger),
      unpricedFillAlerts: loggingAlertChannel('unpricedFillAlerts', logger),
      ocoDoubleFillAlerts: loggingAlertChannel('ocoDoubleFillAlerts', logger),
      breachAlerts: loggingAlertChannel('breachAlerts', logger),
      loosenNotices: loggingAlertChannel('loosenNotices', logger),
      analystSkipAlerts: loggingAlertChannel('analystSkipAlerts', logger),
      residualExposureAlerts: tickLoopResidualAlerts,
      flattenReconcileAlerts: loggingAlertChannel('flattenReconcileAlerts', logger),
      verdictAlerts: { notify: async () => {} },
      traderDiagnosticAlerts: { postTraderDiagnosticAlert: async () => {} },
      miCoverageAlerts: loggingAlertChannel('miCoverageAlerts', logger),
      thresholdClampAlerts: { postThresholdClampAlert: () => {} },
      dataFailoverAlerts: loggingAlertChannel('dataFailoverAlerts', logger),
      exitValuationAlerts: { postExitValuationDegradedAlert: () => {} },
      calendarFallbackAlerts: loggingAlertChannel('calendarFallbackAlerts', logger),
      armDivergenceAlerts: loggingAlertChannel('armDivergenceAlerts', logger),
      tickSkipAlerts: { postTickSkipAlert: async () => {} },
      promptTierAlerts: loggingAlertChannel('promptTierAlerts', logger),
      lseCalendarCoverageAlerts: loggingAlertChannel('lseCalendarCoverageAlerts', logger),
      llmFailureRateAlerts: loggingAlertChannel('llmFailureRateAlerts', logger),
      gateRefusalRateAlerts: loggingAlertChannel('gateRefusalRateAlerts', logger),
      legResizeAlerts: loggingAlertChannel('legResizeAlerts', logger),
      dormantLegsAlerts: loggingAlertChannel('dormantLegsAlerts', logger),
      priceUnitAlerts: loggingAlertChannel('priceUnitAlerts', logger),
      saxoSessionLostAlerts: { postSaxoSessionLostAlert: () => {} },
      saxoWeeklyReminderAlerts: loggingAlertChannel('saxoWeeklyReminderAlerts', logger),
      nonSterlingFeeAlerts: { postNonSterlingFeeAlert: async () => {} },
      unattributedFlattenFillAlerts: { postUnattributedFlattenFillAlert: async () => {} },
      unrecordedVenuePositionAlerts: loggingAlertChannel('unrecordedVenuePositionAlerts', logger),
    } satisfies Required<AlertChannels>;

    const orchestrator = await startFromEnvironment({
      ...profile,
      traderConfig: {
        ...profile.traderConfig,
        asset_class_risk_multiplier: {
          ...profile.traderConfig.asset_class_risk_multiplier,
          crypto: 3.5,
        },
      },
      db,
      miArchive: smokeMiArchive,
      gdeltClient: smokeGdeltClient(),
      polymarketClient: smokePolymarketClient(),
      clock,
      logger,
      universe: SMOKE_TEST_UNIVERSE,
      tradingCalendar: new AlwaysOpenCalendar(),
      stocksTradingWindow: () => true,
      broker,
      dataSource,
      llmClient: new ConstantResponseLlmClient(),
      llmRateLimiter,
      accountState: new FixedAccountStateProvider(),
      alpacaBrokerClient,
      ...smokeAlertChannels,
      tickIntervalMs,
      fillPollIntervalMs,
      heartbeatIntervalMs,
      maxConcurrentInstruments: 1,
    });

    const deadline = Date.now() + deadlineMs;
    try {
      await waitUntil(() => readSmokeObservations(db).ticks.length >= targetTicks, deadline);
      const expectedOpenPositions = SMOKE_TEST_UNIVERSE.length * SMOKE_TRADING_ARMS.length;
      await waitUntil(
        () => {
          const observations = readSmokeObservations(db);
          return (
            observations.positions.length === expectedOpenPositions &&
            observations.positions.every((position) => position.filled_size > 0)
          );
        },
        Math.min(Date.now() + FILL_GRACE_MS, deadline),
      );
    } finally {
      await orchestrator.stop();
    }

    const evidence = await runProbes({
      db,
      clock,
      profile,
      logger,
      targetTicks,
      approvals: orchestrator.approvals,
      alpacaBrokerClient,
      llmRateLimiter,
      tickLoopResidualAlerts,
      fillSyncFailures,
      marketDataFetch,
    });

    const observations = readSmokeObservations(db, smokeMiArchive, orchestrator.marketIntelligence);
    const gate = evaluateSmokeGate(observations, evidence);
    return { observations, gate, report: formatSmokeReport(observations, evidence, gate) };
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { report, gate } = await runSmoke();
    process.stdout.write(`${report.join('\n')}\n`);
    process.exit(gate.passed ? 0 : 1);
  } catch (error) {
    process.stderr.write(
      `offline smoke run failed to complete: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }
}
