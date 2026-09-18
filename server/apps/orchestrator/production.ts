import { AnalystOrchestrator } from '../../pipeline/analysts/index.js';
import type { ArmComparison } from '../../pipeline/control-arm/index.js';
import { SqliteArmComparisonSource } from '../../pipeline/control-arm/index.js';
import type { LlmClient, SpendCap } from '../../pipeline/debate-engine/index.js';
import {
  PromptTierCrossingThrottle,
  RateLimiter,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
  SqliteSpendCap,
  UNCAPPED_SPEND,
} from '../../pipeline/debate-engine/index.js';
import type {
  AlpacaBrokerClient,
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
} from '../../pipeline/execution/index.js';
import {
  AlpacaBrokerAdapter,
  FilledZeroSizeThrottle,
  SimulatedBrokerAdapter,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
  UnrecordedVenuePositionThrottle,
} from '../../pipeline/execution/index.js';
import type {
  ArmDivergenceAlertChannel,
  BreachAlertChannel,
  DailyMetricsSource,
  FeedbackConfig,
} from '../../pipeline/feedback-loop/index.js';
import {
  assertKillThresholdsWithinBounds,
  computeMetrics,
  currentBoundary,
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  isBoundaryDue,
  nextBoundary,
  runArmComparisonCycle,
  runDailyCycle,
  runOutsideBenchmarkCycle,
  SqliteAdjustmentLog,
  SqliteArmComparisonSampleStore,
  SqliteClosedTradeStore,
  SqliteFeedbackCycleScheduleStore,
  SqliteOutsideBenchmarkSampleStore,
  SqliteTuningStore,
  seedAnalystWeights,
} from '../../pipeline/feedback-loop/index.js';
import type { BenchmarkSeriesSource } from '../../pipeline/outside-benchmark/index.js';
import {
  BENCHMARK_COMPOSITION,
  MarketDataBenchmarkSeriesSource,
} from '../../pipeline/outside-benchmark/index.js';
import {
  buildRiskCriticProducer,
  CircuitBreakers,
  riskThresholdsFrom,
  SqliteBreakerStateStore,
  SqliteRiskCriticStore,
} from '../../pipeline/risk-manager/index.js';
import { assertTraderConfigSound, SqliteSetupStore } from '../../pipeline/trader/index.js';
import {
  type ApprovalChannel,
  assertAutomationLevelSupported,
} from '../../pipeline/verdict/index.js';
import type { MarketDataService } from '../../providers/market-data-service/index.js';
import {
  ALPACA_BARS_RETRY_CONFIG,
  ALPACA_BARS_TIMEOUT_MS,
  AlwaysOpenCalendar,
  LseRegularHoursCalendar,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import {
  AlpacaNewsClient,
  CiiConsumer,
  GdeltGkgClient,
  GdeltIngestAgent,
  GdeltScoringPass,
  GROK_REFRESH_MS,
  GrokAgent,
  MarketIntelligenceStore,
  type MiArchiveStore,
  MiIngestAgent,
  NousSentimentClient,
  PolymarketAgent,
  PolymarketClient,
  X_SEARCH_MODEL,
  XSearchClient,
} from '../../providers/market-intelligence/index.js';
import type { AssetClass, Clock, TuningStore } from '../../shared/index.js';
import {
  deriveAnalystTimeoutMs,
  isThresholdBoundViolation,
  logCaughtFailure,
  resolveVenuePacing,
  TokenBucket,
  worstCaseFetchMs,
} from '../../shared/index.js';
import type { LlmInFlightGate } from '../../shared/llm/index.js';
import { NousAccountInFlightGate, tryNousCredentials } from '../../shared/llm/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import {
  guardedStore,
  pruneLlmCallLog,
  SqliteLlmSpendCapStore,
  SqliteRiskLogStore,
  SqliteTraderLogStore,
} from '../../shared/store/index.js';
import { CostModelImpl, SqliteStage2SelectionStore } from '../../tools/backtest/index.js';
import { type AlertPort, loggingAlertChannel } from './alert-catalogue.js';
import { SqliteAlertDeliveryLog } from './alert-delivery-log.js';
import { AnalystSkipKindRelay } from './analysts-decision.js';
import { LLM_SPEND_CAP_BREACH } from './breach-text.js';
import {
  LoggingAnalystTelemetry,
  LoggingFlattenOverfillAlertChannel,
  LoggingMiCoverageTelemetry,
  ParkedCiiScoreProvider,
  UnwiredApprovalChannel,
} from './console-channels.js';
import { DebateBarDecisionGate, type DecisionGate } from './decision-bar-gate.js';
import {
  FILL_SYNC_TRACE_ID,
  RECONCILE_TRACE_ID,
  runStartupReconcile,
  startFillSync,
} from './fill-sync.js';
import { orderHeldFirst } from './flatten-tail-priority.js';
import { Heartbeat } from './heartbeat.js';
import { JsonLogger } from './logger.js';
import type { OrphanGoVerdict, OrphanVerdictScanner } from './orphan-verdict-scan.js';
import { LIVE_BOOK_SIZING_USD } from './paper-profile.js';
import { alpacaFunding, BrokerAccountStateProvider } from './production/account-state.js';
import { buildAnalystsStep, composeMarketIntelligence } from './production/analysts-adapter.js';
import { prefetchBars } from './production/bar-prefetch.js';
import { toCapitalCeilingUsd } from './production/capital-ceiling.js';
import { buildCarriedLotReporter } from './production/carried-lot-alert.js';
import {
  buildControlBookAnchorResolver,
  ControlArmAccountStateProvider,
} from './production/control-account-state.js';
import {
  buildControlArmWiring,
  CONTROL_FILL_SYNC_TRACE_ID,
  CONTROL_RECONCILE_TRACE_ID,
  type ControlArmWiring,
  InMemoryBreakerStatePersistence,
} from './production/control-arm-wiring.js';
import { buildFailoverDataSource } from './production/data-failover.js';
import { buildDebateStep } from './production/debate-adapter.js';
import {
  buildExecutionStep,
  buildExecutionSurface,
  buildPersistence,
  buildRiskStep,
  buildTraderSteps,
  buildVerdictStep,
  type ExecutionStepDeps,
  type PersistenceInstances,
  type PortfolioSnapshot,
  type RiskStepDeps,
  type TraderStepDeps,
  type VerdictStepDeps,
} from './production/direct-bind.js';
import { type ProductionEnvironment, readProductionEnvironment } from './production/environment.js';
import {
  assertFlattenGraceWithinMarkAge,
  assertFlattenWindowCoversTickInterval,
} from './production/flatten-tick-coupling.js';
import { GateRefusalRateMonitor } from './production/gate-refusal-rate-guard.js';
import { LlmFailureRateMonitor } from './production/llm-failure-rate-guard.js';
import { assertLseCalendarCoverage } from './production/lse-calendar-coverage-guard.js';
import { MiCoverageMonitor } from './production/mi-coverage.js';
import { MiRefreshQueue } from './production/mi-refresh-queue.js';
import { withOnTradeClose } from './production/on-trade-close-hookup.js';
import { postCloseFlattenTail, withFlattenTail } from './production/stocks-tick-window.js';
import {
  reportTickSkip,
  type TickSkipAlertChannel,
  TickSkipThrottle,
} from './production/tick-skip-alert.js';
import { MarketDataVolatilityReadingProvider } from './production/volatility-reading-provider.js';
import { UniverseScheduler } from './scheduler.js';
import { CONTROL_BOOK_ANCHOR_KEY, SqliteAccountStateStore } from './sqlite-account-state-store.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';
import { SqliteSessionEquityStore } from './sqlite-session-equity-store.js';
import { runTickPlan } from './tick-loop.js';
import { SequentialTickRunner } from './tick-runner.js';
import type { Logger, Scheduler, TickRunner, TickSteps, UniverseInstrument } from './types.js';
import { subclassOfUniverse } from './types.js';

export const SMOKE_TEST_UNIVERSE: readonly UniverseInstrument[] = [
  { asset: 'BTC-USD', asset_class: 'crypto' },
];

export const BENCHMARK_INSTRUMENTS: ReadonlySet<string> = new Set(
  Object.values(BENCHMARK_COMPOSITION).flatMap((legs) =>
    legs.map((leg) => leg.instrument.toUpperCase()),
  ),
);

export type {
  AlertChannelSlots,
  DailyMetricsConfig,
  FeedbackCycleConfig,
  ProductionConfig,
} from './production/config.js';

import type {
  DailyMetricsConfig,
  FeedbackCycleConfig,
  ProductionConfig,
} from './production/config.js';
import { resolveBacktestReferenceSharpe, resolveDailyMetricsSource } from './production/config.js';
import {
  DEFAULT_STAGE2_MAX_AGE_DAYS,
  usableRevalidationSelections,
} from './production/daily-equity-metrics-source.js';

export {
  buildAlpacaDataSource,
  buildBenchmarkDataSource,
  buildDefaultAlpacaBrokerClient,
  buildDefaultLlmClient,
  DEFAULT_EXPECTED_NOUS_CALL_MS,
  DEFAULT_FEEDBACK_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_CLIENT_CONFIG,
  DEFAULT_LLM_RATE_LIMIT_CONFIG,
  DEFAULT_MAX_IN_FLIGHT_LLM_CALLS,
  universeAssetClasses,
} from './production/defaults.js';

import { describeThrownSafely } from '../../shared/index.js';
import {
  buildAlpacaDataSource,
  buildBenchmarkDataSource,
  buildDefaultAlpacaBrokerClient,
  buildDefaultLlmClient,
  DEFAULT_EXPECTED_NOUS_CALL_MS,
  DEFAULT_FEEDBACK_INTERVAL_MS,
  DEFAULT_FILL_POLL_INTERVAL_MS,
  DEFAULT_GDELT_POLL_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_RATE_LIMIT_CONFIG,
  DEFAULT_MAX_IN_FLIGHT_LLM_CALLS,
  DEFAULT_POLYMARKET_POLL_INTERVAL_MS,
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_VOLATILITY_INDICATOR,
  universeAssetClasses,
} from './production/defaults.js';

export interface ProductionOrchestrator {
  tickRunner: SequentialTickRunner;
  scheduler: UniverseScheduler;
  heartbeat: Heartbeat;
  orphanScanner: OrphanVerdictScanner;
  persistence: PersistenceInstances;
  marketData: MarketDataService;
  broker: BrokerAdapter;
  analysts: AnalystOrchestrator;
  logger: Logger;
  approvals: ApprovalChannel;
  marketIntelligenceCoverage: MiCoverageMonitor;
  marketIntelligenceRefresh: MiRefreshQueue | undefined;
  marketIntelligence: MarketIntelligenceStore;
  universe: readonly UniverseInstrument[];
  start(): Promise<OrphanGoVerdict[]>;
  stop(): Promise<void>;
}

export interface ProductionComponents {
  steps: TickSteps;
  breachAlerts: BreachAlertChannel;
  armDivergenceAlerts: ArmDivergenceAlertChannel;
  tuning: TuningStore;
  marketData: MarketDataService;
  benchmarkSeries: BenchmarkSeriesSource;
  broker: BrokerAdapter;
  analysts: AnalystOrchestrator;
  circuitBreakers: CircuitBreakers;
  approvals: ApprovalChannel;
  executionStore: ExecutionSharedStore;
  executionDeps: ExecutionStepDeps;
  controlArmWiring: ControlArmWiring;
  llmRateLimiter: RateLimiter;
  llmInFlightGate: LlmInFlightGate;
  gdeltIngestAgent: GdeltIngestAgent | undefined;
  gdeltScoringPass: GdeltScoringPass | undefined;
  polymarketAgent: PolymarketAgent;
  marketIntelligenceCoverage: MiCoverageMonitor;
  marketIntelligence: MarketIntelligenceStore;
  marketIntelligenceRefresh: MiRefreshQueue | undefined;
  universe: readonly UniverseInstrument[];
  debateLog: SqliteDebateLogStore;
  environment: ProductionEnvironment;
}

const MAX_SET_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

function pruneLlmCallLogWithLog(
  db: StoreHandle,
  maxRows: number,
  logger: Logger,
  trigger: 'startup' | 'daily',
): void {
  try {
    const deleted = pruneLlmCallLog(guardedStore(db, 'debate-engine'), maxRows);
    if (deleted === 0) return;
    logger.log({
      trace_id: trigger === 'startup' ? 'startup' : 'feedback-cycle',
      stage: 'orchestrator',
      level: 'info',
      message: `pruned llm_call_log to its ${maxRows}-row ceiling`,
      payload: { deleted, max_rows: maxRows, trigger },
    });
  } catch (error) {
    logger.log({
      trace_id: trigger === 'startup' ? 'startup' : 'feedback-cycle',
      stage: 'orchestrator',
      event: 'llm_call_log_prune_failed',
      level: 'warn',
      message:
        'llm_call_log prune failed — captured prompts and responses are unaffected, but the ' +
        'table is not bounded until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error), trigger },
    });
  }
}

function pruneMiArchiveWithLog(
  archive: MiArchiveStore | undefined,
  retentionDays: number,
  clock: Clock,
  logger: Logger,
  trigger: 'startup' | 'daily',
): void {
  if (archive === undefined) return;
  try {
    const cutoff = new Date(clock.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const { rawDeleted, itemsDeleted } = archive.purgeOlderThan(cutoff);
    if (rawDeleted === 0 && itemsDeleted === 0) return;
    logger.log({
      trace_id: trigger === 'startup' ? 'startup' : 'feedback-cycle',
      stage: 'orchestrator',
      level: 'info',
      message: `purged MI archive rows older than the ${retentionDays}-day retention window`,
      payload: { rawDeleted, itemsDeleted, retention_days: retentionDays, trigger },
    });
  } catch (error) {
    logger.log({
      trace_id: trigger === 'startup' ? 'startup' : 'feedback-cycle',
      stage: 'orchestrator',
      event: 'mi_archive_purge_failed',
      level: 'warn',
      message:
        'MI archive purge failed — archived rows are unaffected, but the archive is not bounded ' +
        'until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error), trigger },
    });
  }
}

function pruneAlertDeliveryFailuresWithLog(
  db: StoreHandle,
  retentionDays: number,
  clock: Clock,
  logger: Logger,
  trigger: 'startup' | 'daily',
): void {
  try {
    const cutoff = new Date(clock.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = new SqliteAlertDeliveryLog(guardedStore(db, 'orchestrator')).pruneOlderThan(
      cutoff,
    );
    if (deleted === 0) return;
    logger.log({
      trace_id: trigger === 'startup' ? 'startup' : 'feedback-cycle',
      stage: 'orchestrator',
      level: 'info',
      message: `pruned alert_delivery_failures rows older than the ${retentionDays}-day retention window`,
      payload: { deleted, retention_days: retentionDays, trigger },
    });
  } catch (error) {
    logger.log({
      trace_id: trigger === 'startup' ? 'startup' : 'feedback-cycle',
      stage: 'orchestrator',
      event: 'alert_delivery_failure_prune_failed',
      level: 'warn',
      message:
        'alert_delivery_failures prune failed — recorded failures are unaffected, but the table ' +
        'is not bounded until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error), trigger },
    });
  }
}

export function resolveApprovalsChannel(
  config: Pick<ProductionConfig, 'approvals'>,
): ApprovalChannel {
  return config.approvals ?? new UnwiredApprovalChannel();
}

function resolveProductionBootConfig(
  config: ProductionConfig,
  clock: Clock,
): {
  ceiling: ReturnType<typeof toCapitalCeilingUsd> | undefined;
  environment: ProductionEnvironment;
  universe: readonly UniverseInstrument[];
  tradingCalendar: TradingCalendar;
} {
  assertAutomationLevelSupported(config.verdictConfig);

  assertTraderConfigSound(config.traderConfig);

  assertFlattenWindowCoversTickInterval(
    config.traderConfig,
    config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
  );

  assertFlattenGraceWithinMarkAge(config.traderConfig, config.verdictConfig.max_mark_age.stocks);

  if (config.feedback !== undefined) {
    assertKillThresholdsWithinBounds(
      config.feedback.config.kill_thresholds,
      'buildProductionComponents',
    );
  }

  const ceiling =
    config.capitalCeilingUsd === undefined
      ? undefined
      : toCapitalCeilingUsd(config.capitalCeilingUsd, 'ProductionConfig.capitalCeilingUsd');
  if (config.mode === 'live' && ceiling === undefined) {
    throw new Error(
      'Orchestrator cannot start: mode "live" requires ProductionConfig.capitalCeilingUsd, and ' +
        'it is undefined. It is the ceiling every position size in a live run is derived from ' +
        '(sizingEquity, production/direct-bind.ts) — build the config through ' +
        'liveStartingProfile() rather than assembling ProductionConfig by hand, or set the ' +
        'field explicitly. Refusing to size a live run off unclamped equity.',
    );
  }

  const environment = readProductionEnvironment(config);

  const universe = config.universe ?? SMOKE_TEST_UNIVERSE;

  const tradingCalendar = equityCalendarFor(config);
  if (tradingCalendar.constructor !== UsEquityRegularHoursCalendar) {
    const collidingInstrument = universe.find((instrument) =>
      BENCHMARK_INSTRUMENTS.has(instrument.asset.toUpperCase()),
    );
    if (collidingInstrument !== undefined) {
      throw new Error(
        'Orchestrator cannot start: the resolved trading calendar ' +
          '(equityCalendarFor(config)) is not UsEquityRegularHoursCalendar and ' +
          `'${collidingInstrument.asset}' is still directly in ProductionConfig.universe. ` +
          'That collides with the outside-benchmark path (#989): ' +
          "buildBenchmarkDataSource's fixed benchmark port always normalizes against " +
          'UsEquityRegularHoursCalendar — the two writers would target the same ' +
          '(instrument, timeframe, open_time) row in the bars table under different ' +
          `calendars. Safe once #751's LSE-only cutover lands (${collidingInstrument.asset} ` +
          'becomes a non-tradeable screening instrument, per LseMarkDataSource#assertTradeable), ' +
          `once this universe drops '${collidingInstrument.asset}', or once ` +
          'config.tradingCalendar resolves to UsEquityRegularHoursCalendar.',
      );
    }
  }

  if (tradingCalendar instanceof LseRegularHoursCalendar) {
    assertLseCalendarCoverage({
      now: clock.now(),
      calendar: tradingCalendar,
      logger: config.logger ?? new JsonLogger(),
      alertChannel: config.lseCalendarCoverageAlerts,
    });
  }

  return { ceiling, environment, universe, tradingCalendar };
}

function buildMacroIntelligenceLayer(deps: {
  config: ProductionConfig;
  marketIntelligence: MarketIntelligenceStore;
  clock: Clock;
  logger: Logger;
  universe: readonly UniverseInstrument[];
}): {
  gdeltIngestAgent: GdeltIngestAgent | undefined;
  gdeltScoringPass: GdeltScoringPass | undefined;
  polymarketAgent: PolymarketAgent;
} {
  const { config, marketIntelligence, clock, logger, universe } = deps;

  const gdeltIngestAgent =
    config.miArchive === undefined
      ? undefined
      : new GdeltIngestAgent({
          archive: config.miArchive,
          client: config.gdeltClient ?? new GdeltGkgClient({}),
          clock,
          logger,
        });

  const gdeltScoringPass =
    config.miArchive === undefined
      ? undefined
      : new GdeltScoringPass({
          archive: config.miArchive,
          store: marketIntelligence,
          clock,
          assetClasses: [...new Set(universe.map((instrument) => instrument.asset_class))],
          logger,
        });

  const polymarketAgent = new PolymarketAgent({
    client: config.polymarketClient ?? new PolymarketClient(),
    store: marketIntelligence,
    clock,
    logger,
    ...(config.miArchive === undefined ? {} : { archive: config.miArchive }),
  });

  return { gdeltIngestAgent, gdeltScoringPass, polymarketAgent };
}

function buildSentimentGrokAgent(deps: {
  sentimentCredentials: ReturnType<typeof tryNousCredentials>;
  sentimentRetrieval: boolean;
  xMaxSearchResults: number;
  llmInFlightGate: LlmInFlightGate;
  marketIntelligence: MarketIntelligenceStore;
  spendCap: SpendCap;
  config: ProductionConfig;
  logger: Logger;
  captureLlmText: boolean;
  promptTierAlerts: AlertPort<'promptTierAlerts'>;
  promptTierThrottle: PromptTierCrossingThrottle;
  clock: Clock;
}): GrokAgent | undefined {
  const {
    sentimentCredentials,
    sentimentRetrieval,
    xMaxSearchResults,
    llmInFlightGate,
    marketIntelligence,
    spendCap,
    config,
    logger,
    captureLlmText,
    promptTierAlerts,
    promptTierThrottle,
    clock,
  } = deps;

  if (sentimentCredentials === undefined) {
    if (sentimentRetrieval) {
      logger.log({
        trace_id: 'boot',
        stage: 'market_intelligence',
        event: 'sentiment_credentials_absent',
        level: 'warn',
        message:
          'SAMURAI_SENTIMENT_RETRIEVAL=on but no sentiment credentials are configured, so no ' +
          'sentiment agent was built at all. `social` will be empty for this run and the ' +
          'analysts will report NO DATA — the retrieval switch is doing nothing.',
      });
    }
    return undefined;
  }

  return new GrokAgent({
    client: sentimentRetrieval
      ? new XSearchClient({
          ...sentimentCredentials,
          gate: llmInFlightGate,
          model: X_SEARCH_MODEL,
          maxSearchResults: xMaxSearchResults,
          windowMs: GROK_REFRESH_MS,
          logger,
        })
      : new NousSentimentClient({ ...sentimentCredentials, logger, gate: llmInFlightGate }),
    store: marketIntelligence,
    spendCap,
    spendSink: new SqliteLlmSpendStore(
      guardedStore(config.db, 'debate-engine'),
      logger,
      captureLlmText,
      promptTierAlerts,
      promptTierThrottle,
    ),
    clock,
    logger,
    archive: config.miArchive,
  });
}

function buildSentimentIntelligenceLayer(deps: {
  config: ProductionConfig;
  clock: Clock;
  logger: Logger;
  environment: ProductionEnvironment;
  marketIntelligence: MarketIntelligenceStore;
  spendCap: SpendCap;
  universe: readonly UniverseInstrument[];
}): {
  llmInFlightGate: LlmInFlightGate;
  llmClient: LlmClient;
  marketIntelligenceRefresh: MiRefreshQueue | undefined;
} {
  const { config, clock, logger, environment, marketIntelligence, spendCap, universe } = deps;

  const sentimentEnabled = environment.sentimentEnabled;

  const captureLlmText = environment.captureLlmText;

  const sentimentCredentials = sentimentEnabled ? tryNousCredentials('sentiment') : undefined;
  const promptTierAlerts =
    config.promptTierAlerts ?? loggingAlertChannel('promptTierAlerts', logger);
  const promptTierThrottle = new PromptTierCrossingThrottle();
  const llmInFlightGate = new NousAccountInFlightGate({
    maxInFlight: config.maxInFlightLlmCalls ?? DEFAULT_MAX_IN_FLIGHT_LLM_CALLS,
    expectedCallMs: config.expectedLlmCallMs ?? DEFAULT_EXPECTED_NOUS_CALL_MS,
    logger,
  });
  const llmClient =
    config.llmClient ??
    buildDefaultLlmClient(
      logger,
      llmInFlightGate,
      new SqliteLlmSpendStore(
        guardedStore(config.db, 'debate-engine'),
        logger,
        captureLlmText,
        promptTierAlerts,
        promptTierThrottle,
      ),
    );

  const { sentimentRetrieval, xMaxSearchResults } = environment;

  const grokAgent = buildSentimentGrokAgent({
    sentimentCredentials,
    sentimentRetrieval,
    xMaxSearchResults,
    llmInFlightGate,
    marketIntelligence,
    spendCap,
    config,
    logger,
    captureLlmText,
    promptTierAlerts,
    promptTierThrottle,
    clock,
  });

  const miIngestAgent = buildMiIngestAgent({
    archive: config.miArchive,
    hasScoringCredentials: sentimentCredentials !== undefined,
    store: marketIntelligence,
    llmClient,
    spendCap,
    clock,
    logger,
    assetClasses: universeAssetClasses(universe),
  });

  const marketIntelligenceRefresh = ((): MiRefreshQueue | undefined => {
    const composed = composeMarketIntelligence([miIngestAgent, grokAgent]);
    return composed === undefined
      ? undefined
      : new MiRefreshQueue({ refresher: composed, spendCap, logger });
  })();

  if (grokAgent === undefined) {
    logger.log({
      trace_id: 'startup',
      stage: 'market_intelligence',
      event: 'mi_agent_absent',
      level: 'warn',
      message:
        (sentimentEnabled
          ? 'Nous is not configured for the sentiment role, so no market-intelligence agent is running. '
          : 'SAMURAI_SENTIMENT=off, so no market-intelligence agent is running. ') +
        '`sentiment` and `fundamental` will report NO DATA on every tick — crypto debates run ' +
        '1 real analyst of 2 and equity debates 1 of 3. See #436/#464.',
      payload: {},
    });
  }

  return {
    llmInFlightGate,
    llmClient,
    marketIntelligenceRefresh,
  };
}

function buildLlmAndMarketIntelligenceLayer(deps: {
  config: ProductionConfig;
  clock: Clock;
  logger: Logger;
  environment: ProductionEnvironment;
  marketIntelligence: MarketIntelligenceStore;
  spendCap: SpendCap;
  universe: readonly UniverseInstrument[];
}): {
  llmInFlightGate: LlmInFlightGate;
  llmClient: LlmClient;
  marketIntelligenceRefresh: MiRefreshQueue | undefined;
  gdeltIngestAgent: GdeltIngestAgent | undefined;
  gdeltScoringPass: GdeltScoringPass | undefined;
  polymarketAgent: PolymarketAgent;
} {
  const { config, clock, logger, environment, marketIntelligence, spendCap, universe } = deps;

  const { llmCallLogMaxRows, miArchiveRetentionDays, alertDeliveryFailureRetentionDays } =
    environment;
  pruneLlmCallLogWithLog(config.db, llmCallLogMaxRows, logger, 'startup');

  pruneMiArchiveWithLog(config.miArchive, miArchiveRetentionDays, clock, logger, 'startup');
  pruneAlertDeliveryFailuresWithLog(
    config.db,
    alertDeliveryFailureRetentionDays,
    clock,
    logger,
    'startup',
  );
  const { llmInFlightGate, llmClient, marketIntelligenceRefresh } = buildSentimentIntelligenceLayer(
    { config, clock, logger, environment, marketIntelligence, spendCap, universe },
  );
  const { gdeltIngestAgent, gdeltScoringPass, polymarketAgent } = buildMacroIntelligenceLayer({
    config,
    marketIntelligence,
    clock,
    logger,
    universe,
  });

  return {
    llmInFlightGate,
    llmClient,
    marketIntelligenceRefresh,
    gdeltIngestAgent,
    gdeltScoringPass,
    polymarketAgent,
  };
}

function buildBreakerStateDeps(deps: {
  config: ProductionConfig;
  logger: Logger;
  brokerClient: () => AlpacaBrokerClient;
  marketData: MarketDataService;
  universe: readonly UniverseInstrument[];
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  circuitBreakers: CircuitBreakers;
  breakerStateStore: SqliteBreakerStateStore;
  getOpenPositions: () => ReturnType<SqliteExecutionStore['getOpenPositions']>;
}) {
  const {
    config,
    logger,
    brokerClient,
    marketData,
    universe,
    sessionCalendars,
    circuitBreakers,
    breakerStateStore,
    getOpenPositions,
  } = deps;
  return {
    marketData,
    circuitBreakers,
    maxMarkAge: config.riskConfig.max_mark_age,
    breakerState: breakerStateStore,
    portfolioSnapshots: new Map<string, PortfolioSnapshot>(),
    ...(config.exitValuationAlerts === undefined
      ? {}
      : { exitValuationAlerts: config.exitValuationAlerts }),
    logger,
    accountState:
      config.accountState ??
      new BrokerAccountStateProvider({
        funding: config.accountFunding ?? alpacaFunding(brokerClient()),
        store: new SqliteAccountStateStore(guardedStore(config.db, 'orchestrator')),
        sessionEquity: new SqliteSessionEquityStore(guardedStore(config.db, 'orchestrator')),
        dailyEquity: new SqliteDailyEquityStore(guardedStore(config.db, 'orchestrator')),
        closedTrades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop')),
        calendars: sessionCalendars,
        mode: config.mode,
        startedAt: config.clock.now(),
        logger: config.logger ?? new JsonLogger(),
      }),
    volatility:
      config.volatility ??
      new MarketDataVolatilityReadingProvider({
        marketData,
        universe,
        volatility_indicator: config.volatilityIndicator ?? DEFAULT_VOLATILITY_INDICATOR,
        calendars: sessionCalendars,
        logger: config.logger ?? new JsonLogger(),
      }),
    getOpenPositions,
    mode: config.mode,
  };
}

function buildExecutionStepDeps(deps: {
  config: ProductionConfig;
  clock: Clock;
  logger: Logger;
  broker: BrokerAdapter;
  marketData: MarketDataService;
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  executionStore: ReturnType<typeof withOnTradeClose>;
}): ExecutionStepDeps {
  const { config, clock, logger, broker, marketData, sessionCalendars, executionStore } = deps;
  return {
    clock,
    broker,
    sessionCalendars,
    store: executionStore,
    costModel: new CostModelImpl(config.costConfig),
    marketData,
    config: config.executionConfig,
    residualExposureAlerts:
      config.residualExposureAlerts ?? loggingAlertChannel('residualExposureAlerts', logger),
    flattenOverfillAlerts: new LoggingFlattenOverfillAlertChannel(logger),
    flattenReconcileAlerts:
      config.flattenReconcileAlerts ?? loggingAlertChannel('flattenReconcileAlerts', logger),
    unrecordedVenuePositionAlerts:
      config.unrecordedVenuePositionAlerts ??
      loggingAlertChannel('unrecordedVenuePositionAlerts', logger),
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
    logger,
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    ...(config.nonSterlingFeeAlerts === undefined
      ? {}
      : { nonSterlingFeeAlerts: config.nonSterlingFeeAlerts }),
    ...(config.unattributedFlattenFillAlerts === undefined
      ? {}
      : { unattributedFlattenFillAlerts: config.unattributedFlattenFillAlerts }),
  };
}

function buildExecutionAndRiskInfra(deps: {
  config: ProductionConfig;
  clock: Clock;
  logger: Logger;
  setupStore: SqliteSetupStore;
  brokerClient: () => AlpacaBrokerClient;
  alpacaBucket: TokenBucket;
  marketData: MarketDataService;
  universe: readonly UniverseInstrument[];
  sessionCalendars: Record<AssetClass, TradingCalendar>;
}) {
  const {
    config,
    clock,
    logger,
    setupStore,
    brokerClient,
    alpacaBucket,
    marketData,
    universe,
    sessionCalendars,
  } = deps;
  const executionStore = withOnTradeClose(
    new SqliteExecutionStore(
      guardedStore(config.db, 'execution'),
      'live',
      config.capitalCeilingUsd,
    ),
    { setup_store: setupStore },
    logger,
  );
  const broker =
    config.broker ??
    new AlpacaBrokerAdapter({
      client: brokerClient(),
      rateLimiter: alpacaBucket,
      state: new SqliteBrokerStateStore(guardedStore(config.db, 'execution')),
      unpricedFillAlerts:
        config.unpricedFillAlerts ?? loggingAlertChannel('unpricedFillAlerts', logger),
      ocoDoubleFillAlerts:
        config.ocoDoubleFillAlerts ?? loggingAlertChannel('ocoDoubleFillAlerts', logger),
      logger,
      ...(config.unpricedFillAgeOutMs === undefined
        ? {}
        : { unpricedFillAgeOutMs: config.unpricedFillAgeOutMs }),
      clock,
    });
  const breakerStateStore = new SqliteBreakerStateStore(guardedStore(config.db, 'risk'));
  const circuitBreakers = new CircuitBreakers(
    config.breakerConfig,
    config.initialBreakerState ?? breakerStateStore.load(),
  );
  const ciiConsumer = new CiiConsumer(
    config.ciiScoreProvider ?? new ParkedCiiScoreProvider(),
    clock,
    config.ciiConsumerConfig,
  );

  const breakerStateDeps = buildBreakerStateDeps({
    config,
    logger,
    brokerClient,
    marketData,
    universe,
    sessionCalendars,
    circuitBreakers,
    breakerStateStore,
    getOpenPositions: () => executionStore.getOpenPositions(),
  });

  const executionDeps = buildExecutionStepDeps({
    config,
    clock,
    logger,
    broker,
    marketData,
    sessionCalendars,
    executionStore,
  });

  return { executionStore, broker, circuitBreakers, ciiConsumer, breakerStateDeps, executionDeps };
}
function buildMarketDataAndSpendLayer(deps: {
  config: ProductionConfig;
  clock: Clock;
  universe: readonly UniverseInstrument[];
  tradingCalendar: TradingCalendar;
  alpacaBucket: TokenBucket;
  logger: Logger;
  venuePacing: ReturnType<typeof resolveVenuePacing>;
  sessionCalendars: Record<AssetClass, TradingCalendar>;
}) {
  const {
    config,
    clock,
    universe,
    tradingCalendar,
    alpacaBucket,
    logger,
    venuePacing,
    sessionCalendars,
  } = deps;

  const dataSource =
    config.dataSource ??
    buildFailoverDataSource({
      primary: buildAlpacaDataSource(config, universe, tradingCalendar, alpacaBucket),
      universe,
      calendar: tradingCalendar,
      equitiesFallbackBarFetcher: config.equitiesFallbackBarFetcher,
      fallbackPacing: config.fallbackPacing,
      alertChannel: config.dataFailoverAlerts ?? loggingAlertChannel('dataFailoverAlerts', logger),
      logger,
      now: () => clock.now(),
    });
  const marketDataMode = config.mode === 'backtest' ? 'backtest' : 'live';
  const marketDataStore = new SqliteMarketDataStore(guardedStore(config.db, 'market-data'));
  const marketData: MarketDataService = new MarketDataServiceImpl(
    dataSource,
    clock,
    marketDataMode,
    marketDataStore,
    5_000,
    { logger },
  );

  const benchmarkMarketDataStore = new SqliteMarketDataStore(
    guardedStore(config.db, 'market-data'),
  );
  const benchmarkSeries: BenchmarkSeriesSource =
    config.benchmarkSeriesSource ??
    new MarketDataBenchmarkSeriesSource(
      new MarketDataServiceImpl(
        buildBenchmarkDataSource({ rateLimiter: alpacaBucket }),
        clock,
        marketDataMode,
        benchmarkMarketDataStore,
      ),
    );

  const marketIntelligence = new MarketIntelligenceStore(clock);

  const miCoverageMonitor = new MiCoverageMonitor();

  const llmFailureRateMonitor = new LlmFailureRateMonitor();
  const gateRefusalRateMonitor = new GateRefusalRateMonitor();
  const debateLogStore = new SqliteDebateLogStore(guardedStore(config.db, 'debate-engine'));

  const alpacaFetchBoundMs = worstCaseFetchMs(ALPACA_BARS_TIMEOUT_MS, ALPACA_BARS_RETRY_CONFIG);
  const analystTimeoutMs = deriveAnalystTimeoutMs(
    venuePacing.alpaca,
    universe.length,
    alpacaFetchBoundMs,
  );

  const analysts = new AnalystOrchestrator(
    {
      market_intelligence: marketIntelligence,
      market_data: marketData,
      sessionCalendars,
      telemetry: new LoggingAnalystTelemetry(logger),
      logger,
    },
    undefined,
    { timeout_ms: analystTimeoutMs },
  );

  const setupStore = new SqliteSetupStore(guardedStore(config.db, 'trader'));

  const tuningStore = new SqliteTuningStore(guardedStore(config.db, 'feedback-loop'), clock);

  const breachAlerts = config.breachAlerts ?? loggingAlertChannel('breachAlerts', logger);

  const armDivergenceAlerts =
    config.armDivergenceAlerts ?? loggingAlertChannel('armDivergenceAlerts', logger);

  const publishedSpendCap = new SqliteLlmSpendCapStore(guardedStore(config.db, 'orchestrator'));

  let spendCap: SpendCap;
  if (config.llmBudgetUsd === undefined) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'llm_budget_uncapped',
      level: 'warn',
      message:
        'ProductionConfig.llmBudgetUsd is not set — LLM spend is UNCAPPED. Nothing will ' +
        'stop this process billing without bound; the rate limiter bounds calls per ' +
        'window, not total dollars, and it refills. Correct for a short attended run; an ' +
        'unattended soak (#238) must set a budget.',
      payload: { llm_budget_usd: null },
    });
    publishedSpendCap.arm(null, clock.now());
    spendCap = UNCAPPED_SPEND;
  } else {
    const cap = new SqliteSpendCap(
      guardedStore(config.db, 'debate-engine'),
      config.llmBudgetUsd,
      logger,
      () =>
        breachAlerts.postBreachAlert({
          breaches: [LLM_SPEND_CAP_BREACH],
          reported_at: clock.now(),
        }),
    );
    spendCap = cap;
    publishedSpendCap.arm(config.llmBudgetUsd, clock.now());

    const opening = cap.startingTotal();
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'llm_spend_cap_armed',
      level: opening.admitted ? 'info' : 'error',
      message: opening.admitted
        ? `LLM spend cap armed: $${opening.spent_usd.toFixed(2)} of ` +
          `$${opening.budget_usd.toFixed(2)} already recorded in this database, ` +
          `$${(opening.budget_usd - opening.spent_usd).toFixed(2)} remaining. The window is the ` +
          'whole llm_spend table, so spend from earlier runs against this file counts. Start ' +
          'from a fresh store if this run is meant to have the full budget.'
        : `LLM spend cap is ALREADY BREACHED at startup: ${opening.reason}. No debate will be ` +
          'admitted and the run will take no new trade. Raise llmBudgetUsd or start from a ' +
          'fresh store.',
      payload: {
        spent_usd: opening.spent_usd,
        budget_usd: opening.budget_usd,
        admitted: opening.admitted,
      },
    });
  }

  return {
    marketData,
    benchmarkSeries,
    marketIntelligence,
    miCoverageMonitor,
    llmFailureRateMonitor,
    gateRefusalRateMonitor,
    debateLogStore,
    analysts,
    setupStore,
    tuningStore,
    breachAlerts,
    armDivergenceAlerts,
    spendCap,
  };
}

function buildTraderStepDepsFor(deps: {
  config: ProductionConfig;
  logger: Logger;
  breakerStateDeps: ReturnType<typeof buildBreakerStateDeps>;
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  executionStore: ReturnType<typeof withOnTradeClose>;
  setupStore: SqliteSetupStore;
}): TraderStepDeps {
  const { config, logger, breakerStateDeps, sessionCalendars, executionStore, setupStore } = deps;
  return {
    ...breakerStateDeps,
    config: config.traderConfig,
    sessionCalendars,
    getExitFillSizes: (idempotency_keys) => executionStore.getExitFillSizes(idempotency_keys),
    getUnresolvedFlattens: () => executionStore.getUnresolvedFlattens(),
    setupStore,
    traderLog: new SqliteTraderLogStore(guardedStore(config.db, 'trader')),
    ...(config.capitalCeilingUsd === undefined
      ? {}
      : { capitalCeilingUsd: config.capitalCeilingUsd }),
    ...(config.traderDiagnosticAlerts === undefined
      ? {}
      : { traderDiagnosticAlerts: config.traderDiagnosticAlerts }),
    logger,
  };
}

function buildRiskStepDepsFor(deps: {
  config: ProductionConfig;
  logger: Logger;
  breakerStateDeps: ReturnType<typeof buildBreakerStateDeps>;
  ciiConsumer: CiiConsumer;
  tuningStore: SqliteTuningStore;
  llmClient: LlmClient;
  spendCap: SpendCap;
  marketData: MarketDataService;
}): RiskStepDeps {
  const {
    config,
    logger,
    breakerStateDeps,
    ciiConsumer,
    tuningStore,
    llmClient,
    spendCap,
    marketData,
  } = deps;
  return {
    ...breakerStateDeps,
    config: config.riskConfig,
    correlationConfig: config.correlationConfig,
    ciiConsumer,
    riskLog: new SqliteRiskLogStore(guardedStore(config.db, 'risk')),
    thresholds: tuningStore,
    ...(config.thresholdClampAlerts === undefined
      ? {}
      : { thresholdClampAlerts: config.thresholdClampAlerts }),
    logger,
    critic: buildRiskCriticProducer({
      mode: config.mode,
      llm: llmClient,
      store: new SqliteRiskCriticStore(guardedStore(config.db, 'risk'), logger),
      spendCap,
      marketData,
      logger,
    }),
  };
}

function buildVerdictStepDepsFor(deps: {
  config: ProductionConfig;
  breakerStateDeps: ReturnType<typeof buildBreakerStateDeps>;
  tradingCalendar: TradingCalendar;
  executionStore: ReturnType<typeof withOnTradeClose>;
}): VerdictStepDeps {
  const { config, breakerStateDeps, tradingCalendar, executionStore } = deps;
  return {
    ...breakerStateDeps,
    ...(config.verdictAlerts === undefined ? {} : { verdictAlerts: config.verdictAlerts }),
    tradingCalendar,
    positionStore: executionStore,
    config: config.verdictConfig,
    approvals: resolveApprovalsChannel(config),
    store: config.db,
  };
}

function logCapitalCeilingResolved(
  logger: Logger,
  ceiling: number | undefined,
  capitalCeilingUsdPerGbp: number | undefined,
): void {
  if (ceiling === undefined) return;

  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    event: 'sizing_capital_ceiling_resolved',
    level: 'info',
    message:
      capitalCeilingUsdPerGbp === undefined
        ? `sizing ceiling ${ceiling}, declared in the account currency — no FX conversion applied`
        : `sizing ceiling ${ceiling}, converted from a GBP book at ` +
          `${capitalCeilingUsdPerGbp} USD/GBP (SIZING_USD_PER_GBP, a configured ` +
          'constant — not a live rate feed)',
    payload: {
      capital_ceiling_usd: ceiling,
      derived_by_conversion: capitalCeilingUsdPerGbp !== undefined,
      ...(capitalCeilingUsdPerGbp === undefined
        ? {}
        : {
            usd_per_gbp: capitalCeilingUsdPerGbp,
            usd_per_gbp_provenance: 'SIZING_USD_PER_GBP (paper-profile.ts), configured constant',
          }),
    },
  });
}

export function buildProductionComponents(config: ProductionConfig): ProductionComponents {
  const clock = config.clock;

  const { ceiling, environment, universe, tradingCalendar } = resolveProductionBootConfig(
    config,
    clock,
  );

  const llmRateLimiter =
    config.llmRateLimiter ??
    new RateLimiter(clock, config.rateLimiterConfig ?? DEFAULT_LLM_RATE_LIMIT_CONFIG);

  const sessionCalendars: Record<AssetClass, TradingCalendar> = {
    crypto: new AlwaysOpenCalendar(),
    stocks: tradingCalendar,
  };

  const logger = config.logger ?? new JsonLogger();

  logCapitalCeilingResolved(logger, ceiling, config.capitalCeilingUsdPerGbp);

  let alpacaBrokerClient: AlpacaBrokerClient | undefined;
  const brokerClient = (): AlpacaBrokerClient =>
    (alpacaBrokerClient ??=
      config.alpacaBrokerClient ?? buildDefaultAlpacaBrokerClient(config.mode, logger));

  const venuePacing = config.venuePacing ?? resolveVenuePacing();
  const alpacaBucket = new TokenBucket(venuePacing.alpaca, undefined, {
    logger,
    name: 'alpaca',
  });

  const {
    marketData,
    benchmarkSeries,
    marketIntelligence,
    miCoverageMonitor,
    llmFailureRateMonitor,
    gateRefusalRateMonitor,
    debateLogStore,
    analysts,
    setupStore,
    tuningStore,
    breachAlerts,
    armDivergenceAlerts,
    spendCap,
  } = buildMarketDataAndSpendLayer({
    config,
    clock,
    universe,
    tradingCalendar,
    alpacaBucket,
    logger,
    venuePacing,
    sessionCalendars,
  });
  const { executionStore, broker, circuitBreakers, ciiConsumer, breakerStateDeps, executionDeps } =
    buildExecutionAndRiskInfra({
      config,
      clock,
      logger,
      setupStore,
      brokerClient,
      alpacaBucket,
      marketData,
      universe,
      sessionCalendars,
    });

  const {
    llmInFlightGate,
    llmClient,
    marketIntelligenceRefresh,
    gdeltIngestAgent,
    gdeltScoringPass,
    polymarketAgent,
  } = buildLlmAndMarketIntelligenceLayer({
    config,
    clock,
    logger,
    environment,
    marketIntelligence,
    spendCap,
    universe,
  });

  const traderStepDeps = buildTraderStepDepsFor({
    config,
    logger,
    breakerStateDeps,
    sessionCalendars,
    executionStore,
    setupStore,
  });
  const traderSteps = buildTraderSteps(traderStepDeps);

  const riskStepDeps = buildRiskStepDepsFor({
    config,
    logger,
    breakerStateDeps,
    ciiConsumer,
    tuningStore,
    llmClient,
    spendCap,
    marketData,
  });

  const verdictStepDeps = buildVerdictStepDepsFor({
    config,
    breakerStateDeps,
    tradingCalendar,
    executionStore,
  });

  const controlExecutionStore = new SqliteExecutionStore(
    guardedStore(config.db, 'execution'),
    'control',
    config.capitalCeilingUsd,
  );
  const controlBreakerState = new InMemoryBreakerStatePersistence();
  const controlArmWiring = buildControlArmWiring({
    trader: traderStepDeps,
    risk: riskStepDeps,
    verdict: verdictStepDeps,
    execution: executionDeps,
    store: controlExecutionStore,
    broker: new SimulatedBrokerAdapter({
      clock,
      costModel: executionDeps.costModel,
      marketData,
      config: config.executionConfig.simulated,
    }),
    circuitBreakers: new CircuitBreakers(config.breakerConfig, controlBreakerState.load()),
    breakerState: controlBreakerState,
    accountState: new ControlArmAccountStateProvider({
      resolveBook: buildControlBookAnchorResolver({
        liveAccountState: breakerStateDeps.accountState,
        store: new SqliteAccountStateStore(
          guardedStore(config.db, 'orchestrator'),
          CONTROL_BOOK_ANCHOR_KEY,
        ),
        fallbackBook:
          config.riskConfig.live_book_ceiling?.same_currency_verified === true
            ? config.riskConfig.live_book_ceiling.book
            : LIVE_BOOK_SIZING_USD,
        liveBookCeiling: config.riskConfig.live_book_ceiling,
      }),
      closedTrades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop'), 'control'),
      getOpenPositions: () => controlExecutionStore.getOpenPositions(),
      calendars: sessionCalendars,
    }),
    costModel: executionDeps.costModel,
    marketData,
    executionConfig: config.executionConfig,
    logger,
  });

  const analystSkipKinds = new AnalystSkipKindRelay();

  const steps: TickSteps = {
    exitCheck: traderSteps.exitCheck,
    analysts: buildAnalystsStep(analysts, logger, {
      skipAlerts: config.analystSkipAlerts ?? loggingAlertChannel('analystSkipAlerts', logger),
      skipKinds: analystSkipKinds,
      coverage: {
        contextSource: marketIntelligence,
        subclassOf: subclassOfUniverse(universe),
        telemetry: new LoggingMiCoverageTelemetry(logger),
        alertChannel: config.miCoverageAlerts ?? loggingAlertChannel('miCoverageAlerts', logger),
        monitor: miCoverageMonitor,
        logger,
        ...(marketIntelligenceRefresh === undefined
          ? {}
          : {
              refreshAttempted: (instrument: string) =>
                marketIntelligenceRefresh.refreshAttempted(instrument),
            }),
      },
      ...(marketIntelligenceRefresh === undefined
        ? {}
        : { marketIntelligence: marketIntelligenceRefresh }),
    }),
    analystSkipKind: (trace_id) => analystSkipKinds.take(trace_id),
    debate: buildDebateStep(
      llmClient,
      debateLogStore,
      llmRateLimiter,
      spendCap,
      logger,
      tuningStore,
      {
        windowSource: debateLogStore,
        monitor: llmFailureRateMonitor,
        alertChannel:
          config.llmFailureRateAlerts ?? loggingAlertChannel('llmFailureRateAlerts', logger),
      },
      {
        windowSource: debateLogStore,
        monitor: gateRefusalRateMonitor,
        alertChannel:
          config.gateRefusalRateAlerts ?? loggingAlertChannel('gateRefusalRateAlerts', logger),
        gateRefusalSink: debateLogStore,
      },
    ),
    trader: traderSteps.trader,
    risk: buildRiskStep(riskStepDeps),
    verdict: buildVerdictStep(verdictStepDeps),
    execution: buildExecutionStep(executionDeps),
    controlArm: controlArmWiring.controlArm,
  };

  return {
    steps,
    breachAlerts,
    armDivergenceAlerts,
    tuning: tuningStore,
    marketData,
    benchmarkSeries,
    broker,
    analysts,
    circuitBreakers,
    approvals: verdictStepDeps.approvals,
    executionStore,
    executionDeps,
    controlArmWiring,
    llmRateLimiter,
    llmInFlightGate,
    gdeltIngestAgent,
    gdeltScoringPass,
    polymarketAgent,
    marketIntelligence,
    marketIntelligenceCoverage: miCoverageMonitor,
    marketIntelligenceRefresh,
    universe,
    debateLog: debateLogStore,
    environment,
  };
}

export function buildProductionTickRunner(config: ProductionConfig): SequentialTickRunner {
  return new SequentialTickRunner(buildProductionComponents(config).steps);
}

function buildMiIngestAgent(deps: {
  archive: MiArchiveStore | undefined;
  hasScoringCredentials: boolean;
  store: MarketIntelligenceStore;
  llmClient: LlmClient;
  spendCap: SpendCap;
  clock: Clock;
  logger: Logger;
  assetClasses: AssetClass[];
}): MiIngestAgent | undefined {
  if (deps.archive === undefined || !deps.hasScoringCredentials) return undefined;

  let newsClient: AlpacaNewsClient;
  try {
    newsClient = new AlpacaNewsClient({});
  } catch (error) {
    deps.logger.log({
      trace_id: 'startup',
      stage: 'market_intelligence',
      event: 'mi_news_path_absent',
      level: 'warn',
      message:
        'market intelligence: the deterministic news path is NOT running because Alpaca data ' +
        'credentials are missing. `sentiment` and `fundamental` will report NO DATA on every ' +
        'tick, which is what pinned the stocks conviction ceiling below its floor in #625. ' +
        'Set ALPACA_API_KEY/ALPACA_API_SECRET for a run whose results are meant to mean ' +
        'something.',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return undefined;
  }

  const agent = new MiIngestAgent({
    archive: deps.archive,
    store: deps.store,
    newsClient,
    llmClient: deps.llmClient,
    spendCap: deps.spendCap,
    clock: deps.clock,
    logger: deps.logger,
    assetClasses: deps.assetClasses,
  });
  agent.hydrate();

  return agent;
}

export function startTickLoop(deps: {
  scheduler: Scheduler;
  runner: TickRunner;
  clock: Clock;
  logger: Logger;
  persistence: PersistenceInstances;
  tickIntervalMs: number;
  maxConcurrentInstruments: number;
  decisionGate: DecisionGate;
  tickSkipAlerts?: TickSkipAlertChannel;
  heldAssets?: () => Promise<ReadonlySet<string>>;
}): { stop: () => Promise<void> } {
  let stopped = false;
  const tickSkipThrottle = new TickSkipThrottle();
  const running = new Map<string, symbol>();
  const passes = new Set<Promise<void>>();
  let handle: NodeJS.Timeout | undefined;

  const release = (asset: string, token: symbol): void => {
    if (running.get(asset) === token) {
      running.delete(asset);
    }
  };

  const buildGuardedRunner = (claims: Map<string, symbol>): TickRunner => ({
    runInstrument: async (signal, ctx) => {
      try {
        return await deps.runner.runInstrument(signal, ctx);
      } finally {
        const token = claims.get(signal.asset);
        if (token !== undefined) {
          release(signal.asset, token);
        }
      }
    },
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the claim loop must stay one synchronous check-then-set pass over the plan (#669/#1390), the tick-skip escalation must run BEFORE the ready.length===0 early return (Guards Before Early Returns), and stop()'s shielded-promise view must not be reordered against runOnce's own await/catch (#692) — all three are race-condition invariants extraction cannot verify
  const runOnce = async (): Promise<void> => {
    try {
      const plan = deps.scheduler.nextTick(deps.clock);

      let instruments = plan.instruments;
      if (deps.heldAssets !== undefined && instruments.length > 0) {
        try {
          instruments = orderHeldFirst(instruments, await deps.heldAssets());
        } catch (error) {
          deps.logger.log({
            trace_id: 'tick-loop',
            stage: 'tick-loop',
            event: 'tick_held_lookup_failed',
            level: 'warn',
            message:
              'tick: held-position lookup failed, flatten-tail priority not applied this tick',
            payload: { error: describeThrownSafely(error) },
          });
        }
      }

      if (stopped) return;

      const claims = new Map<string, symbol>();
      const ready: typeof plan.instruments = [];
      const busy: string[] = [];
      const duplicated: string[] = [];
      const seenInPlan = new Set<string>();
      for (const instrument of instruments) {
        if (seenInPlan.has(instrument.asset)) {
          duplicated.push(instrument.asset);
          continue;
        }
        seenInPlan.add(instrument.asset);

        if (running.has(instrument.asset)) {
          busy.push(instrument.asset);
          continue;
        }

        const token = Symbol(instrument.asset);
        running.set(instrument.asset, token);
        claims.set(instrument.asset, token);
        ready.push(instrument);
      }

      if (busy.length > 0) {
        deps.logger.log({
          trace_id: 'tick-loop',
          stage: 'tick-loop',
          level: 'info',
          message: `tick: ${busy.length} instrument(s) still running from a previous pass, skipped this tick`,
          payload: { skipped: busy, ran: ready.length },
        });
      }

      if (duplicated.length > 0) {
        deps.logger.log({
          trace_id: 'tick-loop',
          stage: 'tick-loop',
          event: 'tick_plan_duplicates_dropped',
          level: 'warn',
          message: `tick: scheduler returned ${duplicated.length} duplicate instrument(s) in one plan, extras dropped`,
          payload: { duplicated },
        });
      }

      await reportTickSkip(tickSkipThrottle, deps.tickSkipAlerts, deps.logger, {
        skipped: busy,
        planned: ready.length + busy.length,
        reportedAt: deps.clock.now(),
      });

      if (ready.length === 0) return;

      const pass = runTickPlan(
        { ...plan, instruments: ready },
        buildGuardedRunner(claims),
        deps.clock,
        {
          max_concurrent_instruments: deps.maxConcurrentInstruments,
          logger: deps.logger,
          auditLog: deps.persistence.auditLog,
          currentTickStore: deps.persistence.currentTickStore,
          decisionGate: deps.decisionGate,
        },
      )
        .then(() => undefined)
        .finally(() => {
          for (const [asset, token] of claims) release(asset, token);
        });

      const settled = pass.catch(() => undefined);
      passes.add(settled);
      try {
        await pass;
      } finally {
        passes.delete(settled);
      }
    } catch (error) {
      deps.logger.log({
        trace_id: 'tick-loop',
        stage: 'tick-loop',
        event: 'tick_failed',
        level: 'error',
        message: 'tick failed',
        payload: { error: describeThrownSafely(error) },
      });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    handle = setTimeout(() => {
      schedule();
      void runOnce();
    }, deps.tickIntervalMs);
  };

  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
      await Promise.all(passes);
    },
  };
}

export function equityCalendarFor(config: ProductionConfig): TradingCalendar {
  if (config.tradingCalendar !== undefined) {
    return config.tradingCalendar;
  }

  return config.mode === 'live'
    ? new LseRegularHoursCalendar()
    : new UsEquityRegularHoursCalendar();
}

export function buildHeldAssetsReader(
  components: Pick<ProductionComponents, 'executionStore' | 'controlArmWiring'>,
): () => Promise<ReadonlySet<string>> {
  return async () => {
    const [live, control] = await Promise.all([
      components.executionStore.getOpenPositions(),
      components.controlArmWiring.store.getOpenPositions(),
    ]);
    return new Set([...live, ...control].map((p) => p.instrument));
  };
}

export function buildProductionOrchestrator(config: ProductionConfig): ProductionOrchestrator {
  const logger = config.logger ?? new JsonLogger();
  const clock = config.clock;
  const components = buildProductionComponents(config);

  const persistence = buildPersistence(config.db);
  const tickRunner = new SequentialTickRunner(components.steps);
  const equityCalendar = equityCalendarFor(config);
  const scheduler = new UniverseScheduler({
    universe: components.universe,
    calendar: equityCalendar,
    ...(config.stocksTradingWindow === undefined
      ? {}
      : {
          stocksTradingWindow: withFlattenTail(
            config.stocksTradingWindow,
            equityCalendar,
            config.traderConfig.flatten_before_close_ms,
          ),
        }),
    postCloseFlattenWindow: postCloseFlattenTail(
      equityCalendar,
      config.traderConfig.flatten_after_close_ms,
    ),
  });
  const heartbeat = new Heartbeat(
    config.heartbeatChannel ?? loggingAlertChannel('heartbeatChannel', logger),
    logger,
  );

  let loop: { stop: () => Promise<void> } | undefined;
  let fillSync: { stop: () => Promise<void> } | undefined;
  let controlFillSync: { stop: () => Promise<void> } | undefined;
  let heartbeatHandle: NodeJS.Timeout | undefined;
  let feedbackHandle: NodeJS.Timeout | undefined;
  let feedbackScheduleStopped = false;
  let gdeltHandle: NodeJS.Timeout | undefined;
  let polymarketHandle: NodeJS.Timeout | undefined;

  const fillSyncExecution = buildExecutionSurface(components.executionDeps, FILL_SYNC_TRACE_ID);
  const reconcileExecution = buildExecutionSurface(components.executionDeps, RECONCILE_TRACE_ID);

  const feedbackStores = {
    trades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop')),
    debate_log: new SqliteDebateLogStore(guardedStore(config.db, 'debate-engine')),
    tuning: components.tuning,
    adjustments: new SqliteAdjustmentLog(guardedStore(config.db, 'feedback-loop')),
  };
  const loosenNotices =
    config.feedback?.loosenNotices ??
    config.loosenNotices ??
    loggingAlertChannel('loosenNotices', logger);

  const selectionStore = new SqliteStage2SelectionStore(guardedStore(config.db, 'backtest'));

  const metricsSource =
    config.feedback?.metrics === undefined
      ? undefined
      : resolveDailyMetricsSource(config.feedback.metrics.source, {
          db: config.db,
          trades: feedbackStores.trades,
          logger,
          stage2Selections: selectionStore,
          clock,
        });

  const runMetricsCheck = (
    source: DailyMetricsSource,
    metrics: DailyMetricsConfig,
    feedbackConfig: FeedbackConfig,
  ): void => {
    const sample = source.getDailyMetrics();
    if (sample === undefined) {
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        event: 'daily_metrics_suite_absent',
        level: 'warn',
        message:
          'no daily MetricsSuite this cycle — all four kill-lines were skipped, NOT passed ' +
          '(pbo_over_max, oos_sharpe_under_min, dsr_insignificant, ' +
          'live_backtest_divergence_over_max)',
        payload: { kill_lines_evaluated: 0 },
      });
      return;
    }

    const report = computeMetrics({
      clock,
      daily: sample.daily,
      ...(sample.revalidation === undefined ? {} : { revalidation: sample.revalidation }),
      backtest_reference_sharpe: resolveBacktestReferenceSharpe(
        selectionStore,
        metrics.backtest_reference_sharpe,
        clock,
      ),
      tuning: feedbackStores.tuning,
      adjustments: feedbackStores.adjustments,
      config: feedbackConfig,
      alerts: components.breachAlerts,
    });

    logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'daily_metrics_computed',
      level: report.breaches.length > 0 ? 'error' : 'info',
      message:
        report.breaches.length > 0
          ? 'daily metrics computed — KILL-THRESHOLD BREACH (alerted, thresholds auto-tightened)'
          : 'daily metrics computed',
      payload: {
        breaches: report.breaches,
        not_evaluated: report.not_evaluated,
        revalidation_present: report.revalidation !== undefined,
        daily: report.daily,
      },
    });
  };

  const armComparisonSource = new SqliteArmComparisonSource(guardedStore(config.db, 'control-arm'));
  const armComparisonSamples = new SqliteArmComparisonSampleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  const feedbackScheduleStore = new SqliteFeedbackCycleScheduleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  const outsideBenchmarkSeries = components.benchmarkSeries;
  const outsideBenchmarkSamples = new SqliteOutsideBenchmarkSampleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  const runOutsideBenchmarks = (comparison: ArmComparison): void => {
    void runOutsideBenchmarkCycle({
      clock,
      comparison,
      series: outsideBenchmarkSeries,
      samples: outsideBenchmarkSamples,
    })
      .then((result) => {
        logger.log({
          trace_id: 'feedback-cycle',
          stage: 'feedback-loop',
          event: 'outside_benchmarks_computed',
          level: result.unmeasured.length > 0 ? 'warn' : 'info',
          message:
            result.unmeasured.length > 0
              ? 'outside benchmarks computed — SOME NOT MEASURED (absent, not zeroed)'
              : 'outside benchmarks computed',
          payload: {
            window_from: comparison.from.toISOString(),
            window_to: comparison.to.toISOString(),
            measured: result.measured.map((sample) => sample.performance),
            unmeasured: result.unmeasured,
          },
        });
      })
      .catch((error: unknown) => {
        logger.log({
          trace_id: 'feedback-cycle',
          stage: 'feedback-loop',
          event: 'outside_benchmark_cycle_failed',
          level: 'error',
          message: 'outside benchmark cycle failed',
          payload: { error: describeThrownSafely(error) },
        });
      });
  };

  const runArmComparison = (): ArmComparison => {
    const sample = runArmComparisonCycle({
      clock,
      trades: armComparisonSource,
      samples: armComparisonSamples,
      alerts: components.armDivergenceAlerts,
      basis: LIVE_BOOK_SIZING_USD,
      window_ms: DEFAULT_ARM_COMPARISON_WINDOW_MS,
      thresholds: DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    });

    logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'arm_comparison_computed',
      level: sample.divergence.diverged ? 'warn' : 'info',
      message: sample.divergence.diverged
        ? 'arm comparison computed — ARM DIVERGENCE (alerted, nothing auto-tightened)'
        : 'arm comparison computed',
      payload: {
        window_from: sample.comparison.from.toISOString(),
        window_to: sample.comparison.to.toISOString(),
        basis: sample.comparison.basis,
        live: sample.comparison.live,
        control: sample.comparison.control,
        diverged: sample.divergence.diverged,
        divergence_reason: sample.divergence.reason,
      },
    });

    return sample.comparison;
  };

  const { llmCallLogMaxRows, miArchiveRetentionDays, alertDeliveryFailureRetentionDays } =
    components.environment;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every statement's position is individually documented as load-bearing — the three prunes must stay OUTSIDE the try (#1045/#1060/#1131), the metrics check must run AFTER the cycle's own success log, and the arm comparison must stay OUTSIDE the metrics guard (#971) and BEFORE the outside-benchmarks call (#981) — extraction risks silently reordering one of these
  const runFeedbackCycle = (feedback: FeedbackCycleConfig): void => {
    pruneLlmCallLogWithLog(config.db, llmCallLogMaxRows, logger, 'daily');
    pruneMiArchiveWithLog(config.miArchive, miArchiveRetentionDays, clock, logger, 'daily');
    pruneAlertDeliveryFailuresWithLog(
      config.db,
      alertDeliveryFailureRetentionDays,
      clock,
      logger,
      'daily',
    );

    try {
      const result = runDailyCycle({
        clock,
        ...feedbackStores,
        config: feedback.config,
        loosen_notices: loosenNotices,
        proposals: feedback.proposals ?? [],
      });
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'info',
        message: 'daily feedback cycle complete',
        payload: result,
      });

      if (feedback.metrics !== undefined && metricsSource !== undefined) {
        runMetricsCheck(metricsSource, feedback.metrics, feedback.config);
      }

      const comparison = runArmComparison();

      runOutsideBenchmarks(comparison);
    } catch (error) {
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        event: 'feedback_cycle_failed',
        level: 'error',
        message: 'daily feedback cycle failed',
        payload: { error: describeThrownSafely(error) },
      });

      if (isThresholdBoundViolation(error)) {
        try {
          config.thresholdClampAlerts?.postThresholdClampAlert({
            trace_id: 'feedback-cycle',
            where: 'daily-kill-line-check',
            message: error instanceof Error ? error.message : String(error),
            reported_at: clock.now(),
          });
        } catch (alertError) {
          logger.log({
            trace_id: 'feedback-cycle',
            stage: 'feedback-loop',
            event: 'threshold_clamp_alert_failed',
            level: 'error',
            message: 'threshold clamp alert channel failed',
            payload: {
              error: alertError instanceof Error ? alertError.message : String(alertError),
            },
          });
        }
      }
    }
  };

  const scheduleFeedbackCycle = (feedback: FeedbackCycleConfig, intervalMs: number): void => {
    feedbackScheduleStopped = false;

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the attempt marker must be recorded BEFORE runFeedbackCycle and the boundary AFTER it (#1110, both explicitly ordered), and the re-arm must run in a finally so a thrown check can never leave the timer un-armed — extraction risks silently reordering one of these
    const runIfDue = (): void => {
      try {
        const now = new Date();
        const boundary = currentBoundary(now, intervalMs);
        const last = feedbackScheduleStore.lastBoundary();

        if (isBoundaryDue(boundary, last)) {
          const attempted = feedbackScheduleStore.attemptedBoundary();
          const alreadyAttempted = attempted !== null && attempted.getTime() === boundary.getTime();

          if (alreadyAttempted) {
            logger.log({
              trace_id: 'feedback-cycle',
              stage: 'feedback-loop',
              event: 'feedback_cycle_already_attempted',
              level: 'warn',
              message:
                'feedback cycle for this boundary was already attempted — not running it ' +
                'again, only retrying the completion stamp (#1110)',
              payload: { boundary: boundary.toISOString() },
            });
          } else {
            try {
              feedbackScheduleStore.recordAttempt(boundary, now);
            } catch (attemptError) {
              logger.log({
                trace_id: 'feedback-cycle',
                stage: 'feedback-loop',
                event: 'feedback_attempt_marker_failed',
                level: 'error',
                message:
                  'could not record the feedback-cycle attempt marker — running the cycle ' +
                  'anyway; a restart before completion will not be recognised as a retry (#1110)',
                payload: {
                  error: describeThrownSafely(attemptError),
                },
              });
            }
            runFeedbackCycle(feedback);
          }
          feedbackScheduleStore.recordBoundary(boundary, now);
        }
      } catch (error) {
        logger.log({
          trace_id: 'feedback-cycle',
          stage: 'feedback-loop',
          event: 'feedback_cycle_pass_failed',
          level: 'error',
          message:
            'feedback cycle pass failed — re-arming for the next boundary; a restart retries ' +
            'the cycle, or only its completion stamp if this boundary is already recorded as ' +
            'attempted (#1110)',
          payload: { error: describeThrownSafely(error) },
        });
      } finally {
        if (!feedbackScheduleStopped) {
          const upcoming = nextBoundary(new Date(), intervalMs);
          const delayMs = Math.min(
            Math.max(0, upcoming.getTime() - Date.now()),
            MAX_SET_TIMEOUT_DELAY_MS,
          );
          feedbackHandle = setTimeout(runIfDue, delayMs);
        }
      }
    };

    runIfDue();
  };

  return {
    tickRunner,
    scheduler,
    heartbeat,
    orphanScanner: persistence.orphanScanner,
    persistence,
    marketData: components.marketData,
    broker: components.broker,
    analysts: components.analysts,
    logger,
    approvals: components.approvals,
    marketIntelligenceCoverage: components.marketIntelligenceCoverage,
    marketIntelligence: components.marketIntelligence,
    marketIntelligenceRefresh: components.marketIntelligenceRefresh,
    universe: components.universe,

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: startup sequencing where order is the point — both reconciles must run before the tick loop, weight seeding before the loops start, and the bar prefetch is "the last line before the tick loop is armed" (#1543)
    async start(): Promise<OrphanGoVerdict[]> {
      const orphans = await persistence.orphanScanner.scan(
        config.db,
        config.orphanAlerts ?? loggingAlertChannel('orphanAlerts', logger),
        logger,
      );

      await runStartupReconcile({
        execution: reconcileExecution,
        logger,
        traceId: RECONCILE_TRACE_ID,
      });

      await runStartupReconcile({
        execution: components.controlArmWiring.reconcileExecution,
        logger,
        traceId: CONTROL_RECONCILE_TRACE_ID,
      });

      if (config.feedback !== undefined) {
        const seedResult = seedAnalystWeights({
          tuning: feedbackStores.tuning,
          analyst_ids: components.analysts.analystIds(),
          dial: config.feedback.config.weights,
        });
        logger.log({
          trace_id: 'startup',
          stage: 'feedback-loop',
          level: 'info',
          message: 'analyst weight rows ready for the daily cycle',
          payload: { seeded: seedResult.seeded, already_tuned: seedResult.existing },
        });
      }

      const thresholdSeeds = riskThresholdsFrom(config.riskConfig);
      const seededThresholds = Object.entries(thresholdSeeds).filter(([name, value]) =>
        components.tuning.seedRiskThreshold(name, value),
      );
      logger.log({
        trace_id: 'startup',
        stage: 'risk',
        level: 'info',
        message:
          'risk threshold rows ready — the Risk Manager reads these live at evaluate time, ' +
          'so a Feedback Loop tightening now binds on the next tick',
        payload: {
          seeded: seededThresholds.map(([name]) => name),
          already_present: Object.keys(thresholdSeeds).length - seededThresholds.length,
        },
      });

      heartbeatHandle = setInterval(() => {
        void heartbeat.emit(clock);
      }, config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

      const gdeltIngestAgent = components.gdeltIngestAgent;
      const gdeltScoringPass = components.gdeltScoringPass;
      if (gdeltIngestAgent !== undefined) {
        const pollGdelt = (trace_id: string): void => {
          void gdeltIngestAgent
            .refresh(trace_id)
            .then(() => {
              gdeltScoringPass?.run(trace_id);
            })
            .catch((error: unknown) => {
              logCaughtFailure(
                logger,
                {
                  trace_id,
                  stage: 'market_intelligence',
                  event: 'gdelt_chain_threw',
                  level: 'warn',
                  message:
                    'market intelligence: the GDELT poll/score chain broke its never-throws ' +
                    'contract; no macro aggregate this poll. The archive is unchanged and the ' +
                    'next poll retries.',
                },
                error,
                {},
              );
            });
        };

        pollGdelt('startup');
        gdeltHandle = setInterval(() => {
          pollGdelt('gdelt-poll');
        }, config.gdeltPollIntervalMs ?? DEFAULT_GDELT_POLL_INTERVAL_MS);
      }

      const polymarketAgent = components.polymarketAgent;
      void polymarketAgent.refresh('startup');
      polymarketHandle = setInterval(() => {
        void polymarketAgent.refresh('polymarket-poll');
      }, config.polymarketPollIntervalMs ?? DEFAULT_POLYMARKET_POLL_INTERVAL_MS);

      controlFillSync = startFillSync({
        execution: components.controlArmWiring.fillSyncExecution,
        clock,
        logger,
        fillPollIntervalMs: config.fillPollIntervalMs ?? DEFAULT_FILL_POLL_INTERVAL_MS,
        reconcileTraceId: CONTROL_RECONCILE_TRACE_ID,
        fillSyncTraceId: CONTROL_FILL_SYNC_TRACE_ID,
        reportCarriedLots: buildCarriedLotReporter({
          clock,
          calendar: equityCalendar,
          flattenAfterCloseMs: config.traderConfig.flatten_after_close_ms,
          getOpenPositions: () => components.controlArmWiring.store.getOpenPositions(),
          getExitFillSizes: (keys) => components.controlArmWiring.store.getExitFillSizes(keys),
          logger,
          traceId: CONTROL_FILL_SYNC_TRACE_ID,
          arm: 'control',
          ...(config.traderDiagnosticAlerts === undefined
            ? {}
            : { alerts: config.traderDiagnosticAlerts }),
        }),
      });

      fillSync = startFillSync({
        execution: fillSyncExecution,
        clock,
        logger,
        fillPollIntervalMs: config.fillPollIntervalMs ?? DEFAULT_FILL_POLL_INTERVAL_MS,
        reconcileTraceId: RECONCILE_TRACE_ID,
        fillSyncTraceId: FILL_SYNC_TRACE_ID,
        reportCarriedLots: buildCarriedLotReporter({
          clock,
          calendar: equityCalendar,
          flattenAfterCloseMs: config.traderConfig.flatten_after_close_ms,
          getOpenPositions: () => components.executionStore.getOpenPositions(),
          getExitFillSizes: (keys) => components.executionStore.getExitFillSizes(keys),
          logger,
          traceId: FILL_SYNC_TRACE_ID,
          arm: 'live',
          ...(config.traderDiagnosticAlerts === undefined
            ? {}
            : { alerts: config.traderDiagnosticAlerts }),
        }),
      });

      if (config.mode !== 'backtest') {
        const prefetch = await prefetchBars({
          marketData: components.marketData,
          universe: components.universe,
          asOf: clock.now(),
          logger,
          traceId: 'startup',
        });
        if (prefetch.warmed === 0 && prefetch.failed > 0) {
          logger.log({
            trace_id: 'startup',
            stage: 'market_data',
            event: 'bar_prefetch_total_failure',
            level: 'error',
            message:
              `bar prefetch warmed ZERO of ${prefetch.failed} (instrument, window) pair(s) — ` +
              'the tick loop is about to arm on a completely cold store; the first tick will pay ' +
              'the full cold sweep this ticket exists to avoid',
            payload: { failed: prefetch.failed },
          });
        }
      }

      loop = startTickLoop({
        scheduler,
        runner: tickRunner,
        clock,
        logger,
        persistence,
        tickIntervalMs: config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
        maxConcurrentInstruments: config.maxConcurrentInstruments ?? 1,
        decisionGate: new DebateBarDecisionGate(),
        tickSkipAlerts: config.tickSkipAlerts ?? loggingAlertChannel('tickSkipAlerts', logger),
        heldAssets: buildHeldAssetsReader(components),
      });

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the boundary read at the bottom is explicitly documented as happening BEFORE scheduleFeedbackCycle's first check ("so this reports what was true when the process came up, not the post-catch-up state"), and the intervalMs validation is a deliberate boot crash at a specific point in the sequence — extraction risks separating a diagnostic from the arming call it describes
      function runFeedbackCycleStartup(): void {
        const feedback = config.feedback;
        if (feedback === undefined) {
          logger.log({
            trace_id: 'startup',
            stage: 'feedback-loop',
            event: 'feedback_cycle_unconfigured',
            level: 'warn',
            message:
              'ProductionConfig.feedback is not set — the daily feedback cycle will NEVER run. ' +
              'No analyst weight is attributed, no dial is tuned, and no kill-line ' +
              '(pbo_over_max, oos_sharpe_under_min, dsr_insignificant, ' +
              'live_backtest_divergence_over_max) is ever evaluated. The run will look healthy ' +
              'and learn nothing.',
            payload: { feedback_cycle: 'not_started' },
          });
        } else {
          if (feedback.metrics === undefined) {
            logger.log({
              trace_id: 'startup',
              stage: 'feedback-loop',
              event: 'feedback_metrics_unconfigured',
              level: 'warn',
              message:
                'FeedbackCycleConfig.metrics is not set — the daily cycle will tune dials but ' +
                'computeMetrics will NEVER run, so all four kill-lines stay unevaluated. A ' +
                'MetricsSuite CAN be produced in-repo since #345: supply ' +
                'SqliteDailyEquityMetricsSource over the daily_equity series this process is ' +
                'already recording every tick (ADR-0006). It self-gates below 60 observations, ' +
                'so arming it during a short soak evaluates nothing rather than acting on noise.',
              payload: { kill_lines: 'not_evaluated' },
            });
          } else {
            logger.log({
              trace_id: 'startup',
              stage: 'feedback-loop',
              level: 'info',
              message:
                'FeedbackCycleConfig.metrics is wired — computeMetrics runs on every daily cycle. ' +
                'The source gates itself below its minimum observation count (ADR-0006 §5), so ' +
                'early cycles report "no daily MetricsSuite" with the count rather than acting on ' +
                'a Sharpe made of noise. Which kill-lines that suite can actually answer is ' +
                'reported per cycle in `not_evaluated`, and at startup by the warns that follow.',
              payload: { metrics_source: 'wired' },
            });

            const revalidationSelections = selectionStore.getLatestPerAssetClass();
            const usableSelections = usableRevalidationSelections(
              revalidationSelections,
              clock.now(),
            );
            const revalidationGatedKillLines = [
              'pbo_over_max',
              'oos_sharpe_under_min',
              'dsr_insignificant',
            ];
            if (usableSelections.length === 0) {
              logger.log({
                trace_id: 'startup',
                stage: 'feedback-loop',
                event: 'revalidation_selection_absent',
                level: 'warn',
                message:
                  'pbo_over_max, oos_sharpe_under_min and dsr_insignificant are evaluated ONLY ' +
                  'from a revalidation snapshot (DailyMetricsSample.revalidation), and no usable ' +
                  'frozen Stage 2 selection exists — none persisted, all older than ' +
                  `${DEFAULT_STAGE2_MAX_AGE_DAYS} days, or PBO/DSR refused. Expect these three in ` +
                  '`not_evaluated` on every cycle (un-run, NOT passed) until a direct Stage 2 run ' +
                  '(`node dist/server/tools/run-stage2.js`) freezes a fresh selection (#384, #579).',
                payload: {
                  kill_lines_gated_on_revalidation: revalidationGatedKillLines,
                  persisted_selections: revalidationSelections.length,
                },
              });
            } else {
              logger.log({
                trace_id: 'startup',
                stage: 'feedback-loop',
                level: 'info',
                message:
                  'pbo_over_max, oos_sharpe_under_min and dsr_insignificant are ARMED by the ' +
                  'frozen Stage 2 selection (#384): the metrics source reports the worse-PBO ' +
                  'snapshot once the daily suite clears its observation gate (ADR-0006 §5, ' +
                  '~60 sessions). Until then they read `not_evaluated`; after a selection ages ' +
                  `past ${DEFAULT_STAGE2_MAX_AGE_DAYS} days they go inert again until Stage 2 ` +
                  'is re-run (#579).',
                payload: {
                  kill_lines_gated_on_revalidation: revalidationGatedKillLines,
                  selections: usableSelections.map((selection) => ({
                    asset_class: selection.asset_class,
                    selected_at: selection.selected_at.toISOString(),
                    pbo: selection.pbo,
                    dsr: selection.dsr,
                  })),
                },
              });
            }

            if (feedback.metrics.backtest_reference_sharpe <= 0) {
              logger.log({
                trace_id: 'startup',
                stage: 'feedback-loop',
                event: 'backtest_reference_sharpe_inert',
                level: 'warn',
                message:
                  'backtest_reference_sharpe <= 0 — live_backtest_divergence_over_max is INERT and ' +
                  'can never breach. A non-positive reference has no meaningful relative drop, so ' +
                  'the check returns 0 by design; set ' +
                  'FeedbackCycleConfig.metrics.backtest_reference_sharpe to the frozen selected ' +
                  "config's backtest Sharpe to arm it (#375). Warned once per process.",
                payload: {
                  backtest_reference_sharpe: feedback.metrics.backtest_reference_sharpe,
                  kill_line: 'live_backtest_divergence_over_max',
                },
              });
            }
          }
          const feedbackIntervalMs = feedback.intervalMs ?? DEFAULT_FEEDBACK_INTERVAL_MS;
          if (!Number.isFinite(feedbackIntervalMs) || feedbackIntervalMs <= 0) {
            throw new Error(
              `FeedbackCycleConfig.intervalMs must be positive, got ${feedbackIntervalMs}`,
            );
          }
          const feedbackBoundaryNow = currentBoundary(new Date(), feedbackIntervalMs);
          let feedbackStoredBoundary: Date | null = null;
          let feedbackScheduleReadFailed = false;
          try {
            feedbackStoredBoundary = feedbackScheduleStore.lastBoundary();
          } catch (error) {
            feedbackScheduleReadFailed = true;
            logger.log({
              trace_id: 'startup',
              stage: 'feedback-loop',
              event: 'feedback_schedule_read_failed',
              level: 'error',
              message:
                'could not read the feedback cycle schedule store at startup — proceeding with ' +
                "boot; runIfDue's own guarded read (below) will retry it on the first pass (#1110)",
              payload: { error: error instanceof Error ? error.message : String(error) },
            });
          }
          const feedbackDueNow = isBoundaryDue(feedbackBoundaryNow, feedbackStoredBoundary);
          const feedbackNextDue = nextBoundary(new Date(), feedbackIntervalMs);
          logger.log({
            trace_id: 'startup',
            stage: 'feedback-loop',
            level: 'info',
            message: feedbackScheduleReadFailed
              ? 'daily feedback cycle schedule is UNKNOWN — the store could not be read at ' +
                "startup, so no catch-up decision was made here; runIfDue's own guarded read " +
                `decides on its first pass, next boundary at ${feedbackNextDue.toISOString()} (#1110)`
              : feedbackDueNow
                ? 'daily feedback cycle is due now — catching up on the current boundary, then ' +
                  `resuming the normal schedule, next due at ${feedbackNextDue.toISOString()} (#1110)`
                : 'daily feedback cycle already ran for the current boundary — next due at ' +
                  `${feedbackNextDue.toISOString()}`,
            payload: {
              boundary: feedbackBoundaryNow.toISOString(),
              interval_ms: feedbackIntervalMs,
              stored_boundary: feedbackStoredBoundary?.toISOString() ?? null,
              stored_boundary_read_failed: feedbackScheduleReadFailed,
              next_due: feedbackNextDue.toISOString(),
            },
          });

          scheduleFeedbackCycle(feedback, feedbackIntervalMs);
        }
      }
      runFeedbackCycleStartup();

      return orphans;
    },

    async stop(): Promise<void> {
      if (heartbeatHandle !== undefined) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = undefined;
      }
      feedbackScheduleStopped = true;
      if (feedbackHandle !== undefined) {
        clearTimeout(feedbackHandle);
        feedbackHandle = undefined;
      }
      if (gdeltHandle !== undefined) {
        clearInterval(gdeltHandle);
        gdeltHandle = undefined;
      }
      if (polymarketHandle !== undefined) {
        clearInterval(polymarketHandle);
        polymarketHandle = undefined;
      }
      const stopping = loop?.stop();
      const stoppingFillSync = fillSync?.stop();
      const stoppingControlFillSync = controlFillSync?.stop();
      const drainingGdelt = components.gdeltIngestAgent?.whenIdle();
      const drainingPolymarket = components.polymarketAgent.whenIdle();
      const drainingMiRefresh = components.marketIntelligenceRefresh?.stop();
      loop = undefined;
      fillSync = undefined;
      controlFillSync = undefined;
      await Promise.allSettled([
        stopping,
        stoppingFillSync,
        stoppingControlFillSync,
        drainingGdelt,
        drainingPolymarket,
        drainingMiRefresh,
      ]);
    },
  };
}
