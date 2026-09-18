import type {
  LlmClient,
  PromptTierAlertChannel,
  RateLimiter,
  RateLimiterConfig,
} from '../../../pipeline/debate-engine/index.js';
import type {
  AlpacaBrokerClient,
  BrokerAdapter,
  DormantLegsUnresolvedAlertChannel,
  ExecutionConfig,
  FlattenReconcileAlertChannel,
  LegResizeUnverifiedAlertChannel,
  NonSterlingFeeAlertChannel,
  OcoDoubleFillAlertChannel,
  ResidualExposureAlertChannel,
  SaxoOpenApiClient,
  SaxoSessionLostAlertChannel,
  UnattributedFlattenFillAlertChannel,
  UnpricedFillAlertChannel,
  UnrecordedVenuePositionAlertChannel,
  UnresolvedPriceUnitAlertChannel,
} from '../../../pipeline/execution/index.js';
import type {
  ArmDivergenceAlertChannel,
  BreachAlertChannel,
  DailyMetricsSource,
  FeedbackConfig,
  LoosenNotificationChannel,
  TuningProposal,
} from '../../../pipeline/feedback-loop/index.js';
import type { BenchmarkSeriesSource } from '../../../pipeline/outside-benchmark/index.js';
import type {
  BreakerConfig,
  CorrelationConfig,
  PersistedBreakerState,
  RiskConfig,
} from '../../../pipeline/risk-manager/index.js';
import type { TraderConfig } from '../../../pipeline/trader/index.js';
import type {
  ApprovalChannel,
  TradeChannelNotifier,
  VerdictConfig,
} from '../../../pipeline/verdict/index.js';
import type {
  AlpacaMarketDataClient,
  BarFetcher,
  DataSource,
  IndicatorSpec,
  LseMarkClient,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import type {
  CiiConsumerConfig,
  CiiScoreProvider,
  GdeltGkgClient,
  MiArchiveStore,
  PolymarketWireClient,
} from '../../../providers/market-intelligence/index.js';
import type {
  Clock,
  ClosedTradeStore,
  TokenBucketConfig,
  VenuePacingConfig,
} from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import type { CostConfig, SqliteStage2SelectionStore } from '../../../tools/backtest/index.js';
import type { HeartbeatChannel } from '../heartbeat.js';
import type { OrphanAlertChannel } from '../orphan-verdict-scan.js';
import type { Logger, UniverseInstrument } from '../types.js';
import type { AccountFundingSource } from './account-state.js';
import type { AnalystSkipAlertChannel } from './analysts-adapter.js';
import type { CalendarFallbackAlertChannel } from './calendar-fallback-alert.js';
import type { CapitalCeilingUsd } from './capital-ceiling.js';
import { DEFAULT_STAGE2_MAX_AGE_DAYS } from './daily-equity-metrics-source.js';
import type { DataFailoverAlertChannel } from './data-failover.js';
import type { AccountStateProvider, VolatilityReadingProvider } from './direct-bind.js';
import type { ExitValuationDegradedAlertChannel } from './exit-valuation-alert.js';
import type { GateRefusalRateAlertChannel } from './gate-refusal-rate-guard.js';
import type { LlmFailureRateAlertChannel } from './llm-failure-rate-guard.js';
import type { LseCalendarCoverageAlertChannel } from './lse-calendar-coverage-alert.js';
import type { MiCoverageAlertChannel } from './mi-coverage.js';
import type { SaxoWeeklyReminderAlertChannel } from './saxo-weekly-reminder-alert.js';
import type { ThresholdClampAlertChannel } from './threshold-clamp-alert.js';
import type { TickSkipAlertChannel } from './tick-skip-alert.js';
import type { TraderDiagnosticAlertChannel } from './trader-diagnostic-alert.js';

export interface AlertChannelSlots {
  heartbeatChannel?: HeartbeatChannel;
  orphanAlerts?: OrphanAlertChannel;
  unpricedFillAlerts?: UnpricedFillAlertChannel;
  residualExposureAlerts?: ResidualExposureAlertChannel;
  ocoDoubleFillAlerts?: OcoDoubleFillAlertChannel;
  legResizeAlerts?: LegResizeUnverifiedAlertChannel;
  dormantLegsAlerts?: DormantLegsUnresolvedAlertChannel;
  priceUnitAlerts?: UnresolvedPriceUnitAlertChannel;
  flattenReconcileAlerts?: FlattenReconcileAlertChannel;
  analystSkipAlerts?: AnalystSkipAlertChannel;
  breachAlerts?: BreachAlertChannel;
  loosenNotices?: LoosenNotificationChannel;
  traderDiagnosticAlerts?: TraderDiagnosticAlertChannel;
  verdictAlerts?: TradeChannelNotifier;
  miCoverageAlerts?: MiCoverageAlertChannel;
  thresholdClampAlerts?: ThresholdClampAlertChannel;
  dataFailoverAlerts?: DataFailoverAlertChannel;
  exitValuationAlerts?: ExitValuationDegradedAlertChannel;
  calendarFallbackAlerts?: CalendarFallbackAlertChannel;
  armDivergenceAlerts?: ArmDivergenceAlertChannel;
  tickSkipAlerts?: TickSkipAlertChannel;
  promptTierAlerts?: PromptTierAlertChannel;
  lseCalendarCoverageAlerts?: LseCalendarCoverageAlertChannel;
  llmFailureRateAlerts?: LlmFailureRateAlertChannel;
  gateRefusalRateAlerts?: GateRefusalRateAlertChannel;
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel;
  unrecordedVenuePositionAlerts?: UnrecordedVenuePositionAlertChannel;
  saxoSessionLostAlerts?: SaxoSessionLostAlertChannel;
  saxoWeeklyReminderAlerts?: SaxoWeeklyReminderAlertChannel;
}

export interface ProductionConfig extends AlertChannelSlots {
  db: StoreHandle;
  clock: Clock;
  mode: 'live' | 'paper' | 'backtest';

  alpacaBrokerClient?: AlpacaBrokerClient;
  saxoBrokerClient?: SaxoOpenApiClient;
  alpacaDataClient?: AlpacaMarketDataClient;
  approvals?: ApprovalChannel;
  unpricedFillAgeOutMs?: number;
  ciiScoreProvider?: CiiScoreProvider;
  accountState?: AccountStateProvider;
  accountFunding?: AccountFundingSource;
  volatility?: VolatilityReadingProvider;

  traderConfig: TraderConfig;
  riskConfig: RiskConfig;
  verdictConfig: VerdictConfig;
  executionConfig: ExecutionConfig;
  correlationConfig: CorrelationConfig;
  breakerConfig: BreakerConfig;
  costConfig: CostConfig;
  ciiConsumerConfig: CiiConsumerConfig;

  universe?: readonly UniverseInstrument[];
  dataSourceAssetClass?: 'crypto' | 'stocks';
  lseMarkClient?: LseMarkClient;
  broker?: BrokerAdapter;
  dataSource?: DataSource;
  benchmarkSeriesSource?: BenchmarkSeriesSource;
  equitiesFallbackBarFetcher?: BarFetcher;
  fallbackPacing?: TokenBucketConfig;
  llmClient?: LlmClient;
  volatilityIndicator?: IndicatorSpec;
  tradingCalendar?: TradingCalendar;
  stocksTradingWindow?: (instant: Date) => boolean;
  initialBreakerState?: readonly PersistedBreakerState[];
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  fillPollIntervalMs?: number;
  gdeltPollIntervalMs?: number;
  gdeltClient?: GdeltGkgClient;
  polymarketPollIntervalMs?: number;
  polymarketClient?: PolymarketWireClient;
  maxConcurrentInstruments?: number;
  maxInFlightLlmCalls?: number;
  expectedLlmCallMs?: number;
  rateLimiterConfig?: RateLimiterConfig;
  llmBudgetUsd?: number;
  processEnv?: NodeJS.ProcessEnv;
  capitalCeilingUsd?: CapitalCeilingUsd;
  capitalCeilingUsdPerGbp?: number;
  sentimentEnabled?: boolean;
  sentimentRetrieval?: boolean;
  xMaxSearchResults?: number;
  miArchive?: MiArchiveStore;
  llmRateLimiter?: RateLimiter;
  venuePacing?: VenuePacingConfig;
  feedback?: FeedbackCycleConfig;
  logger?: Logger;
}

export interface FeedbackCycleConfig {
  config: FeedbackConfig;
  loosenNotices?: LoosenNotificationChannel;
  proposals?: TuningProposal[];
  intervalMs?: number;
  metrics?: DailyMetricsConfig;
}

export interface DailyMetricsSourceDeps {
  db: StoreHandle;
  trades: ClosedTradeStore;
  logger: Logger;
  stage2Selections: SqliteStage2SelectionStore;
  clock: Clock;
}

export type DailyMetricsSourceFactory = (deps: DailyMetricsSourceDeps) => DailyMetricsSource;

export interface DailyMetricsConfig {
  source: DailyMetricsSource | DailyMetricsSourceFactory;
  backtest_reference_sharpe: number;
}

export function resolveBacktestReferenceSharpe(
  selections: SqliteStage2SelectionStore,
  configured: number,
  clock: Clock,
): number {
  const maxAgeMs = DEFAULT_STAGE2_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;

  const now = clock.now().getTime();
  const fresh = selections
    .getLatestPerAssetClass()
    .filter((selection) => now - selection.selected_at.getTime() <= maxAgeMs);

  if (fresh.length === 0) return configured;

  return fresh.reduce(
    (best, selection) => Math.max(best, selection.backtest_sharpe),
    Number.NEGATIVE_INFINITY,
  );
}

export function resolveDailyMetricsSource(
  source: DailyMetricsSource | DailyMetricsSourceFactory,
  deps: DailyMetricsSourceDeps,
): DailyMetricsSource {
  return typeof source === 'function' ? source(deps) : source;
}
