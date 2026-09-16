/**
 * Production Composition Root (#236, ADR-0004): wires stages, persistence and the tick loop but implements
 * none of them (ADR-0004 §3). Also owns the Feedback Loop's daily cycle and the `ingestFills()`/`reconcile()`
 * fill-sync poll — neither runs without this file scheduling it.
 */
import { AnalystOrchestrator } from '../../pipeline/analysts/index.js';
// #753: falsifier arm 2's comparison reader — both arms, one window, one query
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
  // #753: falsifier arm 2's venue. A measurement, not a second book.
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
// #753: the control arm's own account scalars — see `control-account-state.ts`
import {
  buildControlBookAnchorResolver,
  ControlArmAccountStateProvider,
} from './production/control-account-state.js';
// #753: falsifier arm 2's composition — see `control-arm-wiring.ts`
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
// #1085: the MI refresh, off the analyst stage's critical path and serialised
// behind one spend check
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

/**
 * The first paper run's universe (ADR-0004 §4): one instrument, not `DEFAULT_UNIVERSE`'s six, so a wiring
 * defect surfaces against the smallest blast radius. BTC-USD specifically bypasses the calendar gate
 * (crypto never consults it), so the smoke run isn't hostage to market hours.
 */
export const SMOKE_TEST_UNIVERSE: readonly UniverseInstrument[] = [
  { asset: 'BTC-USD', asset_class: 'crypto' },
];

/**
 * Every instrument the outside-benchmark path can write, derived from `BENCHMARK_COMPOSITION` (#989 review)
 * rather than hardcoded, so a future benchmark leg change can't silently diverge from a second copy of this list
 */
export const BENCHMARK_INSTRUMENTS: ReadonlySet<string> = new Set(
  Object.values(BENCHMARK_COMPOSITION).flatMap((legs) =>
    legs.map((leg) => leg.instrument.toUpperCase()),
  ),
);

// Split out by the 2026-08-06 review (D1): injectable-surface types live in ./production/config.ts, defaults
// in ./production/defaults.ts. Re-exported here so this file stays the one import surface ADR-0004 names
export type {
  AlertChannelSlots,
  DailyMetricsConfig,
  DailyMetricsSourceDeps,
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
  buildDefaultAlpacaDataClient,
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

/** The composed, still-stoppable process. Returned by `buildProductionOrchestrator`. */
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
  /** `ProductionComponents.approvals` (#1152) — see that field's doc comment */
  approvals: ApprovalChannel;
  /** #752: the market-intelligence coverage monitor — see `ProductionComponents.marketIntelligenceCoverage` */
  marketIntelligenceCoverage: MiCoverageMonitor;
  /**
   * The MI refresh queue (#1085), exposed so a test can drive the real shutdown path and observe the drain —
   * the only way to catch `stop()`'s drain line silently going dead (#1105). `undefined` when no MI agent was built.
   */
  marketIntelligenceRefresh: MiRefreshQueue | undefined;
  /**
   * The MI store itself (#504), exposed so the offline smoke gate can read back what ingestion actually put
   * in front of the analysts — an archive row alone only proves a fetch happened, not that it reached `fundamental`
   */
  marketIntelligence: MarketIntelligenceStore;
  /** `ProductionComponents.universe`'s value (#1167) — read this, don't re-derive from config */
  universe: readonly UniverseInstrument[];
  /** Runs the orphan scan once, then starts the heartbeat and tick loop. Resolves once startup is done — the loop keeps running after. */
  start(): Promise<OrphanGoVerdict[]>;
  /**
   * Stops the heartbeat/feedback timer immediately and resolves once any in-flight tick finishes — awaiting
   * the drain matters, since killing the process between Verdict's `go` and Execution's write orphans a verdict (#209). Idempotent.
   */
  stop(): Promise<void>;
}

/** Everything composed from in-repo code, built exactly once per process */
export interface ProductionComponents {
  steps: TickSteps;
  /**
   * The operator escalation channel, exposed because TWO consumers need the same instance — Feedback Loop's
   * kill-threshold breach and the LLM spend cap's breach (ADR-0008) — so an injected override can't miss one of them
   */
  breachAlerts: BreachAlertChannel;
  /**
   * Where arm divergence escalates (#971), exposed for the same reason as `breachAlerts`: resolved once here
   * so an injected override can't be missed by a second instance built elsewhere
   */
  armDivergenceAlerts: ArmDivergenceAlertChannel;
  /**
   * The tuning dials (#433): Risk Manager READS `risk_thresholds` at evaluate time, Feedback Loop WRITES
   * them — exposed so both halves share the one instance rather than a second construction
   */
  tuning: TuningStore;
  marketData: MarketDataService;
  /**
   * The OUTSIDE BENCHMARKS' series reader (#981) — separate from `marketData` on purpose, since `marketData`
   * is universe-derived and refuses `'SPY'` once the universe is LSE-only (#734/#751)
   */
  benchmarkSeries: BenchmarkSeriesSource;
  broker: BrokerAdapter;
  analysts: AnalystOrchestrator;
  circuitBreakers: CircuitBreakers;
  /**
   * The exact instance `steps.verdict`'s HITL gate would call `requestApproval` on (#1152) — not a
   * reconstruction, since a probe using a fresh instance would prove the helper refuses, not that the tick loop is bound to it
   */
  approvals: ApprovalChannel;
  /**
   * The `onTradeClose`-hooked store (#237) — every consumer (`getOpenPositions`, Verdict, Execution) shares
   * this one instance so a scheduled `ingestFills()` call reaches the same hook, not a separately decorated copy
   */
  executionStore: ExecutionSharedStore;
  /** Execution's dependency set, exposed so the fill-sync loop can bind `reconcile()`/`ingestFills()` from the same object the tick step uses */
  executionDeps: ExecutionStepDeps;
  /**
   * Falsifier arm 2's wiring (#753), exposed so its fill poller can run on its own cadence from
   * `buildProductionOrchestrator` — without it the control arm's lots stall at `submitted` and never close
   */
  controlArmWiring: ControlArmWiring;
  /**
   * The LLM budget every debate is admitted against and metered through (#388) — the same instance inside
   * `steps.debate`, exposed so a caller can assert the limiter actually saw the run's calls (the failure mode is invisible to a unit suite)
   */
  llmRateLimiter: RateLimiter;
  /**
   * The ONE account-wide in-flight gate (#1080) every Nous-speaking client this function builds shares —
   * Nous queues per ACCOUNT, so exposing this instance is the only way to prove this root's clients are actually behind it
   */
  llmInFlightGate: LlmInFlightGate;
  /**
   * The GDELT macro archiver (#556), or undefined with no MI archive to write into. Exposed because it's
   * polled from `buildProductionOrchestrator`'s own timer — without this field a second instance would double the download.
   */
  gdeltIngestAgent: GdeltIngestAgent | undefined;
  /**
   * The GDELT scoring pass (#1086), or undefined with no archive to derive from. Exposed for the same
   * reason as `gdeltIngestAgent`, plus: it holds per-bar guard state in memory, so a second instance would re-derive it.
   */
  gdeltScoringPass: GdeltScoringPass | undefined;
  /**
   * The Polymarket macro/event ingester (#504), routed via `scope` alongside GDELT (#1164). Never
   * `undefined` (Polymarket's read APIs are keyless) — exposed so it isn't rebuilt as a second timer-driven instance.
   */
  polymarketAgent: PolymarketAgent;
  /**
   * The market-intelligence coverage monitor (#752), read/written every tick by `steps.analysts`. Exposed
   * so a caller can read `.degraded`/`.missingInstruments` directly — the only way to catch it becoming a counter nothing reads.
   */
  marketIntelligenceCoverage: MiCoverageMonitor;
  /** The MI store ingestion agents write and analysts read (#504). Exposed so the offline smoke gate can read back what actually reached `fundamental`. */
  marketIntelligence: MarketIntelligenceStore;
  /**
   * The queue the analysts step triggers the MI refresh through (#1085), or undefined with no MI writer.
   * Exposed so `stop()` can drain it too — the refresh completes AFTER the tick that asked for it.
   */
  marketIntelligenceRefresh: MiRefreshQueue | undefined;
  /** The same instance this function's own routing/tick-step wiring closed over above (#1167) — read this, don't re-derive from config */
  universe: readonly UniverseInstrument[];
  /**
   * The `debate_log` store the `debate` step writes through, exposed (#1396) so a test can write history
   * through the SAME instance the llm-failure-rate guard reads and observe the alert on a real call
   */
  debateLog: SqliteDebateLogStore;
  /**
   * Every `process.env` read this root made, resolved once (production/environment.ts). Daily sweeps take
   * retention values from here rather than re-reading the environment, so the two roots can't disagree.
   */
  environment: ProductionEnvironment;
}

/**
 * Node clamps a `setTimeout` delay above 2^31-1 ms (~24.85 days) and fires immediately — undocumented but
 * stable platform behavior. Only bites an operator-configured `intervalMs` above the clamp.
 */
const MAX_SET_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

/**
 * Prunes, reports what it removed, never throws — housekeeping must not fail the process that calls it
 * (matches `spend-sink.ts`'s "bookkeeping never fails the thing it books"). Logs both directions: a large
 * prune and a failing one, since only a no-op prune should stay quiet.
 */
function pruneLlmCallLogWithLog(
  db: StoreHandle,
  maxRows: number,
  logger: Logger,
  trigger: 'startup' | 'daily',
): void {
  try {
    // Declared as a `debate-engine` write, not `orchestrator` (#1048): `llm_call_log` is owned by the debate engine, so this housekeeping DML goes through the guard under the owning stage
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

/**
 * Prunes the MI archive, reports what it removed, never throws — same posture as
 * `pruneLlmCallLogWithLog`. `archive` is optional since `ProductionConfig.miArchive` is; missing means nothing to prune.
 */
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

/**
 * Prunes `alert_delivery_failures`, reports what it removed, never throws — same posture as the other
 * prune functions. Builds its own store handle since this table (unlike the optional MI archive) exists in every shared store.
 */
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

/** The composition root's `ApprovalChannel` default when `config.approvals` is omitted. Named (#1152) so the smoke gate's fallback probe calls the exact expression production wires. */
export function resolveApprovalsChannel(
  config: Pick<ProductionConfig, 'approvals'>,
): ApprovalChannel {
  return config.approvals ?? new UnwiredApprovalChannel();
}

/**
 * Builds the six `TickSteps` from real stage implementations (#234/#235), built once and shared: a second
 * `AlpacaBrokerAdapter` over the same account would silently lose bracket-leg lookups the first one made
 */
/**
 * The boot-time refusal family (#434/#691/#670/#1389/#638/#569/#989/#1378) — every gate that must run
 * before a store handle is open or a wire client exists. Order matches the original sequence exactly.
 */
function resolveProductionBootConfig(
  config: ProductionConfig,
  clock: Clock,
): {
  ceiling: ReturnType<typeof toCapitalCeilingUsd> | undefined;
  environment: ProductionEnvironment;
  universe: readonly UniverseInstrument[];
  tradingCalendar: TradingCalendar;
} {
  // Refuses an `automation_level` engaging the HITL gate (#434): unsound since ADR-0007, since staleness/drift gates run before the approval await and are never re-checked
  assertAutomationLevelSupported(config.verdictConfig);

  // #691: a non-positive `flatten_before_close_ms` disables flat-by-close silently — the window never opens, so a soak would discover overnight carry hours in rather than at boot
  assertTraderConfigSound(config.traderConfig);

  // #670: rejects a flatten window positive but narrower than the tick rate can land inside — same silent failure as above. Resolves the effective tick interval rather than reading it raw, since unset still runs at `DEFAULT_TICK_INTERVAL_MS`
  assertFlattenWindowCoversTickInterval(
    config.traderConfig,
    config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
  );

  // #1389: bounds the post-close grace from ABOVE against Verdict's price-staleness ceiling — a grace past `max_mark_age.stocks` produces post-bell ticks refused `stale_feed`, indistinguishable in `trader_log` from a working grace
  assertFlattenGraceWithinMarkAge(config.traderConfig, config.verdictConfig.max_mark_age.stocks);

  // #638: ADR-0013 calls this a precondition of its own safety, not tidiness — with no human gate left, the numeric thresholds ARE the stop. Refused, never coerced: a clamped kill line would read as accepted to the operator
  if (config.feedback !== undefined) {
    assertKillThresholdsWithinBounds(
      config.feedback.config.kill_thresholds,
      'buildProductionComponents',
    );
  }

  // #569: `capitalCeilingUsd` is optional on `ProductionConfig` (paper/backtest need not set it) and not in
  // `REQUIRED_INJECTED_CONFIG`, so a caller bypassing `startFromEnvironment` could reach `mode: 'live'` with
  // no ceiling. Re-minted through `toCapitalCeilingUsd` here, at boot, rather than trusted — a hand-cast `NaN` would otherwise read as "no bound".
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

  // The only environment read in this root, after the config gates above so a
  // hand-assembled config is refused for its own faults first, and before any
  // store or wire client below is opened
  const environment = readProductionEnvironment(config);

  // The one place ProductionConfig.universe's default is applied (#1167)
  // Every other consumer reads it off the fields below instead of re-deriving it
  const universe = config.universe ?? SMOKE_TEST_UNIVERSE;

  // #989: fail-CLOSED calendar-mismatch guard against `buildBenchmarkDataSource`'s fixed US-normalized
  // port. `.constructor !==`, not `instanceof` — exact identity so a `UsEquityRegularHoursCalendar`
  // subclass overriding session normalization can't quietly slip past. Case-insensitive on the instrument symbol.
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

  // #1378: the live equity leg's table-coverage cliff. Uses `instanceof`, not `.constructor !==` like above — a future subclass of `LseRegularHoursCalendar` inherits its coverage cliff and should be caught too, not exempted
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

// Independent of the sentiment/LLM layer below — see each agent's own
// comment for why neither depends on Nous credentials or on the other.
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

  /**
   * The GDELT macro layer (#556): runs whenever an archive exists, no credentials or LLM needed.
   * Independent of `miIngestAgent` — that ticker layer returns zero items for the LSE ETPs this system trades.
   */
  const gdeltIngestAgent =
    config.miArchive === undefined
      ? undefined
      : new GdeltIngestAgent({
          archive: config.miArchive,
          client: config.gdeltClient ?? new GdeltGkgClient({}),
          clock,
          logger,
        });

  /**
   * The other half of #556 (#1086): turns archived bytes into `IntelligenceItem`s, driven from the same
   * timer after each poll — no network/LLM call, since the aggregate is derived at read every time.
   * Asset classes come from the UNIVERSE, not every class the type admits (crypto is out of scope, ADR-0015).
   */
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

  /**
   * The Polymarket macro/event layer (#504, `intel` writer #1164). Built unconditionally — keyless reads,
   * no LLM call. Folded into `fundamental-analyst.ts` alongside `news` (#1164) since the LSE ETPs this
   * system trades get zero Benzinga coverage; `MiCoverageMonitor` still reports them uncovered since these items are filed under macro series, never tickers.
   */
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
    // The ONE construction-time difference between a sentiment stage that fills
    // `social` and one that never does — everything downstream (spend gate,
    // evidence guard, bucket cache) is identical, per grok-agent.ts's claim.
    client: sentimentRetrieval
      ? new XSearchClient({
          ...sentimentCredentials,
          gate: llmInFlightGate,
          // Credentials pin `x-ai/grok-4.5`, on which `x_search` 400s
          // ("supported only on OpenRouter-routed models") — the routed alias
          // here is a workaround, not a preference. See `X_SEARCH_MODEL`.
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
    // Absent on runs with no archive, which is a working configuration: it
    // costs replay and the post-hoc bot-share check, not correctness
    archive: config.miArchive,
  });
}

// Every branch below turns on sentiment/Nous credentials state, none of it
// on the macro layer's state (see buildMacroIntelligenceLayer).
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

  // #464, retargeted at Nous (ADR-0009): off switch is explicit `SAMURAI_SENTIMENT=off` (the old
  // XAI_API_KEY-absence switch no longer works under a single provider). Off reports NO_DATA_MARKER (#463)
  // rather than a silent neutral read. Metered under `stage: 'market_intelligence'`, checked against the cap BEFORE calling.
  const sentimentEnabled = environment.sentimentEnabled;

  // #1035. Passed down from the one read, so both spend sinks agree and
  // neither reads the environment for itself — the same rule the file sink
  // follows (`buildEntrypointLogger`)
  const captureLlmText = environment.captureLlmText;

  // `tryNousCredentials`, not `nousCredentials`: an unconfigured Nous environment degrades this optional stage to no-agent rather than failing boot. An unpriced model still throws — a hole in the spend cap, not a config gap
  const sentimentCredentials = sentimentEnabled ? tryNousCredentials('sentiment') : undefined;
  /** ONE `LlmClient` for the whole root — the debate stage and MI scoring both bill through it, so there's one spend meter rather than two disagreeing */
  const promptTierAlerts =
    config.promptTierAlerts ?? loggingAlertChannel('promptTierAlerts', logger);
  /**
   * ONE throttle for the whole root: `NOUS_MODEL` can route both the debate client and the sentiment
   * `GrokAgent` through the same tiered model, and a throttle per store would double-count that model's
   * consecutive crossings (#1155)
   */
  const promptTierThrottle = new PromptTierCrossingThrottle();
  /**
   * ONE in-flight gate for the whole root (#1080): Nous queues per ACCOUNT, not per key or client, so a
   * second gate would cap two populations of the same queue independently and cap neither
   */
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

  /**
   * The deterministic news path (#552), preferred over `grokAgent` when buildable: `GrokAgent`'s
   * `retrievalEvidence: false` makes it ingest `[]` by construction, and #625 measured the cost — with
   * `sentiment`/`fundamental` both at confidence 0.05, no stock could trade at any RSI
   */
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

  /**
   * The MI writers, taken OFF the analyst stage's critical path (#1085). BOTH agents, not one (#969) —
   * they fill different buckets (`news` vs `social`). `undefined` when neither could be built, in which
   * case analysts report NO_DATA_MARKER (#463) rather than a silent no-op refresher.
   */
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

/** The LLM client, its shared in-flight/spend metering, and the whole MI writer set (news/social/GDELT/Polymarket) — self-contained beyond the six fields threaded back out */
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

  /**
   * #1045: row ceiling applied at boot AND on the daily timer (two call sites) — startup alone would fire
   * once for an unattended run, daily alone leaves a restart-heavy dev loop pruning nothing. Wired here,
   * not in `SqliteLlmSpendStore`, since retention is a deployment policy, not the writer's job (#1059's history).
   */
  const { llmCallLogMaxRows, miArchiveRetentionDays, alertDeliveryFailureRetentionDays } =
    environment;
  pruneLlmCallLogWithLog(config.db, llmCallLogMaxRows, logger, 'startup');

  /**
   * #1060: the 90-day MI archive purge, applied at boot and on the daily timer — same two-call-site shape
   * as the row ceiling above, for the same reason. Wired here, not in `MiArchiveStore.write`, for the same reason (#1059's history).
   */
  pruneMiArchiveWithLog(config.miArchive, miArchiveRetentionDays, clock, logger, 'startup');
  /** #1131: same two-call-site shape as the MI archive purge above — see `pruneAlertDeliveryFailuresWithLog` for why this table needs its own retention sweep */
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

// Shared by the trader/risk/verdict binds: all three derive the current
// portfolio + breaker state from the same sources, fetched fresh at their
// own call time (#234)
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
    // #640: the valuation-freshness bound, read from the RISK config rather
    // than the verdict one. The two bounds are deliberately separate fields
    // (see `RiskConfig.max_mark_age`): declining one trade on a stale tick and
    // refusing to value the entire book are different-weight actions
    maxMarkAge: config.riskConfig.max_mark_age,
    breakerState: breakerStateStore,
    // One portfolio observation per tick, shared by the trader/risk binds (B4)
    portfolioSnapshots: new Map<string, PortfolioSnapshot>(),
    // #841: BOTH the risk and verdict binds degrade an exit's valuation
    // rather than suppress the flatten, and both must be able to say so
    // Spread here rather than onto each bind separately for exactly that
    // reason — a channel wired into one seam only would leave the other
    // silent. Conditional spread under `exactOptionalPropertyTypes`.
    ...(config.exitValuationAlerts === undefined
      ? {}
      : { exitValuationAlerts: config.exitValuationAlerts }),
    // The `error`-level line both seams write before reaching the channel
    // above, and #726's sink for a failed `riskLog.write`
    logger,
    // Defaulted, not required (#276): the three sources this needs — Alpaca's
    // account ledger, the durable `account_state` table, and the existing
    // ClosedTrade store — all exist in-repo now, so an injected seam would be
    // asking the caller to build what this module can compose
    accountState:
      config.accountState ??
      new BrokerAccountStateProvider({
        // #1509: the venue's own ledger, injected when the run is not Alpaca's
        // (`saxoFunding`, built at the entrypoint from the one Saxo client)
        // Everything below this line is venue-neutral and shared
        funding: config.accountFunding ?? alpacaFunding(brokerClient()),
        store: new SqliteAccountStateStore(guardedStore(config.db, 'orchestrator')),
        // Per-class session-open equity snapshots (#332) — the local
        // replacement for Alpaca's blended `last_equity` (GAP-8)
        sessionEquity: new SqliteSessionEquityStore(guardedStore(config.db, 'orchestrator')),
        // The append-only daily equity series (#345), wired unconditionally on the same boundary as the
        // snapshot above — a return series cannot be backfilled. Whether it is ever EVALUATED is a separate, gated decision (`SqliteDailyEquityMetricsSource`)
        dailyEquity: new SqliteDailyEquityStore(guardedStore(config.db, 'orchestrator')),
        // The existing ClosedTrade reader, per spec story 25 — no new
        // realized-PnL ledger is built when one already exists
        closedTrades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop')),
        // Two calendars: crypto resets at 00:00 UTC, stocks at the prior 16:00 ET close — only the equity
        // one is overridable here. SHARING `tradingCalendar` with the scheduler is deliberate (#331): the
        // accounting boundary and session gating move together, so a holiday-calendar fix reaches the daily-PnL boundary without touching this file
        calendars: sessionCalendars,
        mode: config.mode,
        // Composition happens at startup, so "now" here IS the process start — it decides whether a
        // session boundary was crossed under a running process or had already passed when this one came up (#332's two cold-start cases)
        startedAt: config.clock.now(),
        logger: config.logger ?? new JsonLogger(),
      }),
    // #277's provider, wired by default now that AccountStateProvider (#276)
    // exists — the only reason direct-bind.ts left it a required seam
    volatility:
      config.volatility ??
      new MarketDataVolatilityReadingProvider({
        marketData,
        universe,
        volatility_indicator: config.volatilityIndicator ?? DEFAULT_VOLATILITY_INDICATOR,
        // Literally the same objects the scheduler gates its tick plan on and
        // the daily-PnL boundary resets on, for the same reason (#386): a
        // second session opinion here would arm `volatility_halt:stocks`
        // overnight for a class the tick plan had already excluded
        calendars: sessionCalendars,
        logger: config.logger ?? new JsonLogger(),
      }),
    getOpenPositions,
    mode: config.mode,
  };
}

// The fill-sync loop binds `reconcile()`/`ingestFills()` from this same
// object, so Execution cannot gain a dependency on the tick path and
// silently miss it on the poll path.
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
    // #1214: the same pair the flatten window and the daily-PnL boundary
    // resolve against, for the reason this object exists at all (above)
    sessionCalendars,
    store: executionStore,
    costModel: new CostModelImpl(config.costConfig),
    marketData,
    config: config.executionConfig,
    // #525: the fallback alert for a residual `ingestFills()` failed to re-arm after a partial flatten
    // Required on `ExecutionInput`, same "no silent default" reason as `unpricedFillAlerts` (#298) — an omitted channel is the #322 bug re-created
    residualExposureAlerts:
      config.residualExposureAlerts ?? loggingAlertChannel('residualExposureAlerts', logger),
    // #527: diagnostic-only for now (see `LoggingFlattenOverfillAlertChannel`'s
    // doc) — no `SAMURAI_ALERTS`/config override yet, unlike the escalations
    // above. A phone-reaching transport is a later ticket if this ever fires.
    flattenOverfillAlerts: new LoggingFlattenOverfillAlertChannel(logger),
    // #519: where `reconcile()`'s flatten sweep escalates a row it could not settle. Required, same "no silent default" reason as `residualExposureAlerts` — an omitted channel would make an unresolved flatten's ambiguity invisible again
    flattenReconcileAlerts:
      config.flattenReconcileAlerts ?? loggingAlertChannel('flattenReconcileAlerts', logger),
    // #1550: where `findUnrecordedVenuePositions` escalates a venue position no open lot explains. Required, with a `loggingAlertChannel` default — nothing else writes an `error` line for this condition
    unrecordedVenuePositionAlerts:
      config.unrecordedVenuePositionAlerts ??
      loggingAlertChannel('unrecordedVenuePositionAlerts', logger),
    // #1550: one throttle per arm, shared by `fillSyncExecution`/`reconcileExecution` below — the page cadence is a property of the process, not of the surface
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
    // #573: the execution port's own local diagnostic trace — see
    // `ExecutionInput.logger`'s decision doc. Required, so a composition
    // root that forgets it is a `tsc` error rather than a silent gap
    logger,
    // #1087: one throttle for this arm's whole process lifetime, shared by `fillSyncExecution`/`reconcileExecution` below — process-scoped, not surface-scoped, even though only the former calls `ingestFills()`
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    // #1465: optional, unlike the required channels above — no `Logging…`
    // default, see `ExecutionInput.nonSterlingFeeAlerts`'s doc for why
    ...(config.nonSterlingFeeAlerts === undefined
      ? {}
      : { nonSterlingFeeAlerts: config.nonSterlingFeeAlerts }),
    // #1506: optional for the same reason as `nonSterlingFeeAlerts` above
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
  // Hooked once, shared everywhere below: `getOpenPositions`, Verdict's `positionStore` and Execution's `store` all read/write through this one instance, so `onTradeClose` fires regardless of caller
  const executionStore = withOnTradeClose(
    // #1112 AC5 (migration 0045): the same ceiling `sizingEquity` clamps this arm's sizing against, stamped on every row so a later window can tell which sizing regime it was sized under
    new SqliteExecutionStore(
      guardedStore(config.db, 'execution'),
      'live',
      config.capitalCeilingUsd,
    ),
    { setup_store: setupStore },
    logger,
  );
  // `resolveVenuePacing` starts from `DEFAULT_VENUE_PACING` (each value's provenance + published ceiling) and layers any `SAMURAI_PACING_ALPACA_*` override — a rate limit is a property of the account, not the code. Built once, above market-data wiring (#391)
  const broker =
    config.broker ??
    new AlpacaBrokerAdapter({
      client: brokerClient(),
      rateLimiter: alpacaBucket,
      // #287: without a durable bracket index the adapter starts blind on restart — `fetchNewFills` polls nothing for lots that were already filling when the process died
      state: new SqliteBrokerStateStore(guardedStore(config.db, 'execution')),
      // #298: the same store carries the age-out clock for a fill the venue
      // will not price, which is why it must be the durable one here — a
      // restart that reset the clock would age nothing out across a soak
      unpricedFillAlerts:
        config.unpricedFillAlerts ?? loggingAlertChannel('unpricedFillAlerts', logger),
      // #586: the emulated crypto OCO's accepted-risk escalation — required
      // on `AlpacaBrokerAdapterInput` for the same "no silent default"
      // reason `unpricedFillAlerts` is
      ocoDoubleFillAlerts:
        config.ocoDoubleFillAlerts ?? loggingAlertChannel('ocoDoubleFillAlerts', logger),
      // #609: `AlpacaBrokerAdapterInput.logger`, required for the same reason `ExecutionInput.logger` is (#573) — a dropped wiring is now a `tsc` error, not a silent gap. Same instance built above, not a second one
      logger,
      ...(config.unpricedFillAgeOutMs === undefined
        ? {}
        : { unpricedFillAgeOutMs: config.unpricedFillAgeOutMs }),
      clock,
    });
  // The sticky breakers' durable home (#203, review 2026-08-06 B1): loaded
  // here so a trip survives restart, written by every breaker evaluation on
  // the tick path (direct-bind.ts `computeCurrentPortfolioAndBreakers`)
  const breakerStateStore = new SqliteBreakerStateStore(guardedStore(config.db, 'risk'));
  const circuitBreakers = new CircuitBreakers(
    config.breakerConfig,
    config.initialBreakerState ?? breakerStateStore.load(),
  );
  // Parked by default (ADR-0002): the live WorldMonitor feed costs money per
  // call and the geopolitical tier is not what the first paper run tests
  // `null` is already a documented answer on this port
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

  /**
   * #562: the live orchestrator's bars now fail over per leg instead of one vendor with no catch. Wraps
   * whatever `buildAlpacaDataSource` returns as the PRIMARY; `config.dataSource` still short-circuits both,
   * since a caller bringing its own source has already decided where bars come from.
   */
  const dataSource =
    config.dataSource ??
    buildFailoverDataSource({
      primary: buildAlpacaDataSource(config, universe, tradingCalendar, alpacaBucket),
      universe,
      // The primary's own calendar, not a second instance: the fallback's bars
      // are session-normalized against it so a failover cannot change what a
      // `lookback` means at the store
      calendar: tradingCalendar,
      equitiesFallbackBarFetcher: config.equitiesFallbackBarFetcher,
      // Passed through UNRESOLVED (#822/#825) — resolving it at this call site would run on every boot
      // regardless of whether the default Polygon branch is selected (#825's exact defect). `buildFailoverDataSource` resolves it itself.
      fallbackPacing: config.fallbackPacing,
      alertChannel: config.dataFailoverAlerts ?? loggingAlertChannel('dataFailoverAlerts', logger),
      logger,
      now: () => clock.now(),
    });
  // `MarketDataServiceImpl`'s mode is live-vs-backtest only; `paper` reads
  // the same live feed `live` does — paper differs at the broker, not at
  // the data source
  const marketDataMode = config.mode === 'backtest' ? 'backtest' : 'live';
  /**
   * The PIPELINE's own store instance — NOT shared with the benchmark service below, which gets its own
   * (`benchmarkMarketDataStore`). See that instance's doc for why the two writers' shared key space is safe.
   */
  const marketDataStore = new SqliteMarketDataStore(guardedStore(config.db, 'market-data'));
  // #1082: telemetry wired on the PRIMARY instance only, not the benchmark instance below — the benchmark
  // path runs at Feedback Loop's daily cadence, not the per-tick path the 106 analyst timeouts were observed on
  const marketData: MarketDataService = new MarketDataServiceImpl(
    dataSource,
    clock,
    marketDataMode,
    marketDataStore,
    5_000,
    { logger },
  );

  /**
   * The benchmark path's OWN store instance (#987), deliberately not `marketDataStore` above. Shares the
   * same `bars` table/PK with no discriminator column, but the two writers are provably disjoint on
   * `instrument`: `marketData` can never write `'SPY'`/`'AGG'` once the universe is LSE-only (#751), and
   * this path is the ONLY writer of those symbols. Pre-cutover the collision is real but pre-existing and
   * not live-exposed (ADR-0004 §5); **closed in code by #989**, which refuses to boot on a resolved
   * calendar other than `UsEquityRegularHoursCalendar` while a benchmark instrument is still directly in the universe.
   */
  const benchmarkMarketDataStore = new SqliteMarketDataStore(
    guardedStore(config.db, 'market-data'),
  );
  /**
   * The OUTSIDE BENCHMARKS' own market-data path (#981), deliberately NOT `marketData` above: that source
   * refuses `'SPY'` once the universe is LSE-only (#734/#751), which would park both benchmarks in
   * `unmeasured` forever. #636 requires them measured on FL's own cadence regardless of what the live
   * universe trades, so this path takes no `universe` at all — see `buildBenchmarkDataSource`.
   */
  const benchmarkSeries: BenchmarkSeriesSource =
    config.benchmarkSeriesSource ??
    new MarketDataBenchmarkSeriesSource(
      new MarketDataServiceImpl(
        // `tradingCalendar` is NOT passed: it is LSE in live mode, and SPY/AGG
        // are US-session instruments. See `buildBenchmarkDataSource`.
        buildBenchmarkDataSource({ rateLimiter: alpacaBucket }),
        clock,
        marketDataMode,
        benchmarkMarketDataStore,
      ),
    );

  // `MarketIntelligenceStore` starts empty and, as of #464, has a writer — constructed here rather than
  // inline so the agent and the analysts cannot end up holding two different stores (same defect as #432)
  const marketIntelligence = new MarketIntelligenceStore(clock);

  // #752: one monitor for the whole process, restart-clean in memory. Exposed on `ProductionComponents`
  // so a caller can assert the degraded-coverage flag actually moves (same reasoning as `llmRateLimiter`)
  const miCoverageMonitor = new MiCoverageMonitor();

  // #1396: one monitor for the whole process, same restart-clean-in-memory posture as `miCoverageMonitor`
  // `debateLogStore` is hoisted so this guard and `SqliteDebateLogStore.writeLog` share one instance, not a second connection
  const llmFailureRateMonitor = new LlmFailureRateMonitor();
  // #1533: its own monitor, because its own latch — the two signals cross
  // their thresholds independently (see `gate-refusal-rate-guard.ts`)
  const gateRefusalRateMonitor = new GateRefusalRateMonitor();
  const debateLogStore = new SqliteDebateLogStore(guardedStore(config.db, 'debate-engine'));

  /**
   * #1542: re-derives `deriveAnalystTimeoutMs` against the RESOLVED `venuePacing` (env override applied)
   * rather than trusting the checked-in default, which is correct only while no operator has overridden
   * pacing. `alpacaFetchBoundMs` pins the worst-case single fetch to the same constants
   * `AlpacaHttpDataClient` defaults to, so the bound can't silently drift from what the client runs.
   */
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
      /**
       * #746: reuses the SAME `sessionCalendars` pair the flatten rule resolved above rather than deriving
       * a second one (#696 found exactly that bug class once already)
       */
      sessionCalendars,
      /**
       * #745: `technical_indicator_unavailable{kind}`, wired unconditionally with no config switch — an
       * unwired counter is indistinguishable from an instrument whose axes are all available
       */
      telemetry: new LoggingAnalystTelemetry(logger),
      /**
       * #1114: deleting this line collapses `AnalystOrchestrator`'s logger back to `NOOP_LOGGER` silently —
       * `runAnalystFailureCauseScenario` (smoke-run.ts) drives a real rejection and fails the gate if it observes nothing
       */
      logger,
    },
    undefined,
    { timeout_ms: analystTimeoutMs },
  );

  // One instance, both ends of `cosine_setups` (#432): the Trader's `decide` WRITES the setup and
  // `onTradeClose` LABELS it with realized R on close — constructed here so the two halves can't drift into separate stores
  const setupStore = new SqliteSetupStore(guardedStore(config.db, 'trader'));

  /**
   * Hoisted above the tick steps (#433): the Risk Manager now READS `risk_thresholds` at evaluate time,
   * and a threshold `autoTighten` writes has to be the same row Risk reads — one instance, both ends of the dial
   */
  const tuningStore = new SqliteTuningStore(guardedStore(config.db, 'feedback-loop'), clock);

  /**
   * Hoisted above `spendCap` below rather than left beside the Feedback Loop's stores: the LLM spend cap
   * escalates its breach through this same channel, and a breach reaching only the log stream is invisible on an unattended run
   */
  const breachAlerts = config.breachAlerts ?? loggingAlertChannel('breachAlerts', logger);

  /** #971. Resolved beside `breachAlerts`, and never merged with it — see its slot's doc. */
  const armDivergenceAlerts =
    config.armDivergenceAlerts ?? loggingAlertChannel('armDivergenceAlerts', logger);

  /**
   * #1140: the SAME `config.llmBudgetUsd` the enforcer is built from, recorded where the dashboard process
   * (which can't see this config object) can read it — armed on both sides so the published and enforced caps are one expression apart, not two copies
   */
  const publishedSpendCap = new SqliteLlmSpendCapStore(guardedStore(config.db, 'orchestrator'));

  /**
   * The hard dollar ceiling (ADR-0008). Distinct from `llmRateLimiter`, which bounds CALLS PER WINDOW and
   * refills with time: this bounds TOTAL DOLLARS and never refills — a run can be inside its rate limit and
   * still spend a fortnight's budget in three days. Absent means uncapped, warned about rather than defaulted silently.
   */
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

    /**
     * Announces what this database has ALREADY spent, because the cap's window is the whole `llm_spend`
     * table (a per-process baseline would hand a fresh budget to every restart on a MacBook soak) — so
     * prior runs against the same file count, and `data/samurai-development.sqlite` held 196 calls/$0.38
     * before this cap existed. Silence would let an operator assume zero and be wrong.
     */
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
    // #668: THE pair built above, not a fresh one — ADR-0014's flat-by-close resolves through the
    // instrument's own venue, so the Trader has to read the same calendars the daily-PnL boundary and volatility reading do
    sessionCalendars,
    // #568: literally the `executionStore` above — the same instance `getOpenPositions` reads and
    // `ingestFills()` writes fills through, so the Trader sizes an exit off the same fill record `executeExit` re-derives
    getExitFillSizes: (idempotency_keys) => executionStore.getExitFillSizes(idempotency_keys),
    // #1389: the same `executionStore` again, for the same reason — and here
    // it also carries the arm scoping (migration 0050), so the live arm's
    // Trader sees the live arm's in-flight flattens and nobody else's
    getUnresolvedFlattens: () => executionStore.getUnresolvedFlattens(),
    setupStore,
    traderLog: new SqliteTraderLogStore(guardedStore(config.db, 'trader')),
    // #511: the declared capital ceiling, spread through rather than read from the environment here —
    // the ONE hop that carries it from `liveStartingProfile` to the sizing arithmetic. Omitted (not `undefined`) on paper/backtest under `exactOptionalPropertyTypes`.
    ...(config.capitalCeilingUsd === undefined
      ? {}
      : { capitalCeilingUsd: config.capitalCeilingUsd }),
    // #698: the diagnostic escalation, wired HERE and not only declared — otherwise the next instance of
    // this repo's dominant defect (a tested mechanism nothing calls), reporting a failure whose only other
    // symptom is a book that quietly stops trading. Omitted, not `undefined`, under `log-only`.
    ...(config.traderDiagnosticAlerts === undefined
      ? {}
      : { traderDiagnosticAlerts: config.traderDiagnosticAlerts }),
    // The sink for the diagnostics themselves, and for an alert the transport
    // could not deliver. Without it a log-only run would have nowhere to put
    // them at all
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
    // #433: the live dial. Without this Risk freezes its RiskConfig at
    // construction and `autoTighten`'s response to a kill-line breach
    // changes no decision
    thresholds: tuningStore,
    // #766: the live-read clamp trip escalation. Same conditional-spread idiom as `traderDiagnosticAlerts`
    // above, required by `exactOptionalPropertyTypes`: omitted rather than `undefined` under `log-only`
    ...(config.thresholdClampAlerts === undefined
      ? {}
      : { thresholdClampAlerts: config.thresholdClampAlerts }),
    // #726: sink for the catch's own guarded `riskLog.write` failure — without it, a store failure while reporting a gate throw has nowhere to go but silent loss, with no trace at all
    logger,
    // #957: check-pipeline step 7's producer. The SAME `llmClient` the debate bills through, so the
    // critic's calls land in `llm_spend` under `stage: 'risk_critic'` against ADR-0008's ceiling. `mode`
    // picks the implementation: `backtest` holds no LLM client at all, making ADR-0003 §2 structural
    // `marketData` is required, not optional, so deleting this line is a compile error, not a silent `no_conditions`
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
    // #465. Absent under `log-only` and in tests, so no verdict alerting;
    // present under `telegram`, filtered to notable verdicts only
    ...(config.verdictAlerts === undefined ? {} : { verdictAlerts: config.verdictAlerts }),
    tradingCalendar,
    // Verdict's `PositionStore.findByKey` is a strict subset of Execution's
    // `SharedStore`; one store instance serves both rather than opening a
    // second connection with a divergent view of the same table
    positionStore: executionStore,
    config: config.verdictConfig,
    // Unreachable by design since ADR-0007: `automation_level` is `auto` for both classes, so the HITL
    // gate short-circuits. `UnwiredApprovalChannel` THROWS rather than auto-approving, so re-enabling the
    // gate without wiring a transport fails loudly instead of fabricating consent
    approvals: resolveApprovalsChannel(config),
    // Backs LoggingVerdict's verdict_log write (#302) — the same handle
    // every other Sqlite* store in this function reads/writes through
    store: config.db,
  };
}

// #1180: which rate produced which ceiling, on the stream a soak keeps. The
// ceiling is DERIVED on a paper run (GBP book × a configured rate) and
// DECLARED on a live run — `derived_by_conversion` distinguishes them so a
// live ceiling is never misattributed a conversion rate. No-op with no ceiling.
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

  // FIRST, ahead of every store/socket/wire client below (PR #390 review): `RateLimiter`'s constructor
  // VALIDATES its config, and a malformed budget should be refused before a SQLite handle is open, so a
  // throw doesn't leave a half-built root behind. One instance for the process, shared by every instrument's
  // debate — a limiter per debate/instrument would enforce nothing across the universe. Takes THIS root's
  // `clock`, so an injected frozen clock (the offline smoke run) gets one window for the whole run
  const llmRateLimiter =
    config.llmRateLimiter ??
    new RateLimiter(clock, config.rateLimiterConfig ?? DEFAULT_LLM_RATE_LIMIT_CONFIG);

  // `tradingCalendar` is computed above, ahead of the precutover collision guard, which needs its
  // RESOLVED value rather than re-deriving `mode` itself (#989 review)
  /**
   * ONE calendar pair, shared by every consumer that needs to know when a venue is open (#331/#332, #386).
   * Built once rather than per call site — two literals would be two places for a future override to land on only one of them.
   */
  const sessionCalendars: Record<AssetClass, TradingCalendar> = {
    crypto: new AlwaysOpenCalendar(),
    stocks: tradingCalendar,
  };

  /**
   * Hoisted above the analysts (#745), market-data wiring (#562) and `alpacaBucket` below (#1083), each of
   * which now logs through it — depends on nothing but `config`, so all three moves are free (same reasoning as `breachAlerts` below)
   */
  const logger = config.logger ?? new JsonLogger();

  logCapitalCeilingResolved(logger, ceiling, config.capitalCeilingUsdPerGbp);

  // One broker wire client for the whole root: the order adapter and account-state provider both talk to
  // Alpaca's Trading API, and two clients would mean two token budgets against one account's shared rate limit
  // LAZY since #1400, memoized so "one client" still holds — a run supplying both `config.broker` and
  // `config.accountState` (or, since #1509, `config.accountFunding`) reaches neither call site, so building it unconditionally demanded `ALPACA_API_KEY` for a transport never used
  let alpacaBrokerClient: AlpacaBrokerClient | undefined;
  const brokerClient = (): AlpacaBrokerClient =>
    (alpacaBrokerClient ??=
      config.alpacaBrokerClient ?? buildDefaultAlpacaBrokerClient(config.mode, logger));

  // Outbound pacing per venue, from ops config rather than a literal (#299). Hoisted above the market-data
  // wiring (#391): ONE Alpaca bucket for the whole root, shared by the broker adapter and market-data
  // client, since the 200 req/min limit is per ACCOUNT and two buckets would be two budgets against one limit
  // `{ logger, name: 'alpaca' }` (#1083) makes a wait on this shared bucket observable — previously silent starvation
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

  // #464, retargeted at Nous (ADR-0009): off switch is explicit `SAMURAI_SENTIMENT=off` (the old
  // XAI_API_KEY-absence switch no longer works under a single provider). Off reports NO_DATA_MARKER (#463)
  // rather than a silent neutral read. Metered under `stage: 'market_intelligence'`, checked against the cap BEFORE calling.
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

  // The Trader's two entry points, built together so the tick path's exit
  // check and the decision path's full decision share one dependency set and
  // one diagnostic throttle (#743) — see `buildTraderSteps`
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

  /**
   * FALSIFIER ARM 2 (#753) — the mandated matched control, composed here beside the live arm rather than in
   * a script of its own. ADR-0014 amendment 2 / ADR-0017 §Consequences make it non-optional, running from
   * the first soak day (no env flag: an opt-in control is a control that's off during the run that mattered).
   * Cost is bounded — no LLM call, no venue call (simulated broker), no extra market-data fetch.
   */
  const controlExecutionStore = new SqliteExecutionStore(
    guardedStore(config.db, 'execution'),
    'control',
    // #1112 AC5 (migration 0045): the SAME ceiling as the live arm's store above — `deps.trader` reaches
    // this arm by the verbatim spread `buildControlArmWiring` does, so both arms' rows are stamped identically
    config.capitalCeilingUsd,
  );
  const controlBreakerState = new InMemoryBreakerStatePersistence();
  const controlArmWiring = buildControlArmWiring({
    trader: traderStepDeps,
    risk: riskStepDeps,
    verdict: verdictStepDeps,
    execution: executionDeps,
    store: controlExecutionStore,
    // A SIMULATED venue, never the live one — the book is £1,000 and D5 deploys 35%/25% per position, so
    // a control placing real orders at the same envelope would double deployment (no ADR authorises that)
    // Fills priced through the SAME `CostModel` the live arm uses, so the comparison stays cost-inclusive
    broker: new SimulatedBrokerAdapter({
      clock,
      // #1121 AC1: the SAME `CostModelImpl` instance the live arm's `execute.ts` prices its modelled-cost
      // fallback through — not a second instance from an equal-looking config, which would drift out of sync by hand
      costModel: executionDeps.costModel,
      marketData,
      // #1121 AC1: the SAME simulated-adapter config the live arm's execution config declares, not a
      // second one — pins `MarketState.venue` ('saxo') identically on both arms' `CostModel.fill` calls, so
      // an edge can't be a fixture difference in disguise. The same RATE is not the same CHARGE though
      // (review round 2, finding 6): the live arm prices off the executed fill, the control off the mid at
      // submit, so the live arm is systematically over-charged by a measured ~0.004bps — conservative in direction, stated here rather than corrected
      config: config.executionConfig.simulated,
    }),
    circuitBreakers: new CircuitBreakers(config.breakerConfig, controlBreakerState.load()),
    breakerState: controlBreakerState,
    // The control arm's OWN account scalars, derived from its OWN book — the fourth per-arm thing, and
    // the one that was missing: a shared `AccountStateProvider` reflects only the LIVE arm's trades, which
    // would make the control's D5 sizing and drawdown-halt timing functions of the live arm's cash (`control-account-state.ts`)
    accountState: new ControlArmAccountStateProvider({
      // The live arm's REAL equity, observed ONCE at first boot and persisted first-write-wins — not the
      // declared £1,000. Since #1112 both arms clamp to the SAME `capitalCeilingUsd`, so as long as this
      // anchor stays above that ceiling, `sizingEquity`'s `min(equity, ceiling)` lands both arms on the
      // identical clamped figure regardless of raw equity. `npm run smoke` once measured a
      // declared-£1,000-anchored control taking zero trades, before #1112 existed — a real scale mismatch,
      // not evidence about today's shared-ceiling clamp. Reading it once is what keeps this an anchor rather than a coupling.
      resolveBook: buildControlBookAnchorResolver({
        liveAccountState: breakerStateDeps.accountState,
        store: new SqliteAccountStateStore(
          guardedStore(config.db, 'orchestrator'),
          CONTROL_BOOK_ANCHOR_KEY,
        ),
        // Gated on `same_currency_verified` exactly like the primary live-read clamp below — an unverified
        // ceiling must not cap one path and leave the other uncapped (#972 fix 3). The unverified branch is
        // `LIVE_BOOK_SIZING_USD`, not the raw GBP book, denominated in the account's currency so the
        // "anchor stays above the ceiling" note above keeps holding. Since #1509 `armSameCurrencyCeilings`
        // sets `same_currency_verified` only from a Saxo balance read, so every Alpaca run stays on the USD fallback
        fallbackBook:
          config.riskConfig.live_book_ceiling?.same_currency_verified === true
            ? config.riskConfig.live_book_ceiling.book
            : LIVE_BOOK_SIZING_USD,
        // #972 fix 3 — the same ceiling the fallback above resolves through,
        // applied to the primary live-read anchor path too
        liveBookCeiling: config.riskConfig.live_book_ceiling,
      }),
      // `arm: 'control'` — the one caller that asks this store for the other
      // arm. Handing it the default would restore the coupling exactly.
      closedTrades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop'), 'control'),
      getOpenPositions: () => controlExecutionStore.getOpenPositions(),
      // The SAME two calendars the live provider is given: the arms must
      // measure a "day" over identical boundaries or their daily figures are
      // not comparable
      calendars: sessionCalendars,
    }),
    costModel: executionDeps.costModel,
    marketData,
    executionConfig: config.executionConfig,
    logger,
  });

  // #1080. Both ends are wired HERE, in one place, because a relay with a writer and no reader is this
  // repo's characteristic defect: the adapter would classify every skip and the audit row would keep saying `quorum_skip`, with nothing failing
  const analystSkipKinds = new AnalystSkipKindRelay();

  const steps: TickSteps = {
    // #743: the tick path's position-facing exit check — the Trader's
    // exit-only entry point, runnable without analysts or a debate
    exitCheck: traderSteps.exitCheck,
    // `logger` here is what makes an analyst failure visible at all — see the
    // adapter's doc comment (issue #358 item 4)
    analysts: buildAnalystsStep(analysts, logger, {
      skipAlerts: config.analystSkipAlerts ?? loggingAlertChannel('analystSkipAlerts', logger),
      // #1080: why a skip happened, for the runner to read back below
      skipKinds: analystSkipKinds,
      // #752: the per-name/per-subclass NO_DATA counter and degraded-coverage alert. `subclassOfUniverse`
      // is the SAME derivation #739 uses for the Risk Manager gate and the Trader's frozen bracket, so an
      // unclassified instrument is bucketed as `UNCLASSIFIED_SUBCLASS`, never dropped
      coverage: {
        contextSource: marketIntelligence,
        subclassOf: subclassOfUniverse(universe),
        telemetry: new LoggingMiCoverageTelemetry(logger),
        alertChannel: config.miCoverageAlerts ?? loggingAlertChannel('miCoverageAlerts', logger),
        monitor: miCoverageMonitor,
        logger,
        // #1085: hold the alert (never the counter) for a name MI has not finished looking at once —
        // bound to the queue's own state so it can't drift from the refresh it describes; absent when there's no writer at all, when the first miss SHOULD alert immediately
        ...(marketIntelligenceRefresh === undefined
          ? {}
          : {
              refreshAttempted: (instrument: string) =>
                marketIntelligenceRefresh.refreshAttempted(instrument),
            }),
      },
      // The writers `MarketIntelligenceStore` has, behind the queue that keeps
      // them off this stage's critical path — see `marketIntelligenceRefresh`'s
      // construction above
      ...(marketIntelligenceRefresh === undefined
        ? {}
        : { marketIntelligence: marketIntelligenceRefresh }),
    }),
    analystSkipKind: (trace_id) => analystSkipKinds.take(trace_id),
    // Two independent stores hang off this one step, both over `config.db`: #367's `SqliteLlmSpendStore`
    // meters what the debate COSTS, and #364's `SqliteDebateLogStore` records what it DECIDED — the latter
    // had no writer anywhere in the tick path before this, so `attribution.ts` had nothing to attribute over the whole soak
    debate: buildDebateStep(
      llmClient,
      debateLogStore,
      llmRateLimiter,
      spendCap,
      logger,
      // #435: the live `analyst_weights` table, read at every debate. Without
      // this the daily cycle steps a weight nothing reads — the write end
      // exists and the read end does not, which is the same shape as #433
      tuningStore,
      // #1396: the llm-failure-rate window read + monitor + alert channel
      // `windowSource` is `debateLogStore` itself — see its hoist above
      {
        windowSource: debateLogStore,
        monitor: llmFailureRateMonitor,
        alertChannel:
          config.llmFailureRateAlerts ?? loggingAlertChannel('llmFailureRateAlerts', logger),
      },
      // #1533: the gate-refusal-rate bundle. The same `debateLogStore` serves all three roles — window
      // reads and the refusal sink — but the monitor, threshold and channel are this signal's own
      {
        windowSource: debateLogStore,
        monitor: gateRefusalRateMonitor,
        alertChannel:
          config.gateRefusalRateAlerts ?? loggingAlertChannel('gateRefusalRateAlerts', logger),
        gateRefusalSink: debateLogStore,
      },
    ),
    // #328: `traderLog`/`riskLog` are what make the two stages that decide WHAT and HOW BIG
    // reconstructible after the fact — an `audit_log` digest alone proves the stage ran, never why. Both
    // write on a skip/rejection too, the case with no downstream record at all
    trader: traderSteps.trader,
    risk: buildRiskStep(riskStepDeps),
    verdict: buildVerdictStep(verdictStepDeps),
    execution: buildExecutionStep(executionDeps),
    // #753: falsifier arm 2, run on every tick beside the live arm. Bound
    // unconditionally — see `controlArmWiring`'s construction above for why
    // there is no flag
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

/**
 * The ticket's literal signature: all six stages bound into one runner. Constructs its own
 * `ProductionComponents`, so a process must call this OR `buildProductionOrchestrator`, never both against
 * the same account — two `AlpacaBrokerAdapter`s would each hold half the bracket-leg map.
 */
export function buildProductionTickRunner(config: ProductionConfig): SequentialTickRunner {
  return new SequentialTickRunner(buildProductionComponents(config).steps);
}

/**
 * The deterministic MI ingest agent, or `undefined` when this run cannot build one (#552). Split out and
 * made total since it can be unavailable three independent ways (no archive, no scoring credentials, no
 * Alpaca data keys), none of which may take down boot. Degrading is safe: the caller falls back to the
 * retrieval-era agent, though not free — without it the store ingests `[]` on every refresh (#625's conviction ceiling stays in force).
 */
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
  // Startup hydration (#554): the store is in-memory, so without this a restart
  // loses every item ingested before it and the run silently measures less than
  // it appears to
  agent.hydrate();

  return agent;
}

/**
 * The tick loop. Self-scheduling (`setTimeout`), with a PER-INSTRUMENT (not global) in-flight guard (#669):
 * a global guard let a slow crypto debate cost the equity leg a tick, and under ADR-0014's intraday horizon
 * a lost tick is real exit slippage. `RateLimiter`/`SpendCap` now own concurrency/spend admission
 * independently of ticks, so the guard only needs to hold pipeline reentrancy per instrument.
 *
 * This is NOT a complete concurrency proof: persistence (`current_tick`, `audit_log`) is audited safe under
 * overlapping passes, but the Risk/Execution DECISION path is not (#1013 fix-up H3, #1019 open) — portfolio
 * exposure caps can fail to net same-tick concurrent exposure across instruments once D5 subclass
 * classification arms (#895). #1040 closed the cross-INSTRUMENT case within one pass; cross-PASS remains open.
 */
export function startTickLoop(deps: {
  scheduler: Scheduler;
  runner: TickRunner;
  clock: Clock;
  logger: Logger;
  persistence: PersistenceInstances;
  tickIntervalMs: number;
  /** Per PASS, not process-wide: the real ceiling is this x passes in flight (#692) */
  maxConcurrentInstruments: number;
  /** The tick/decision split's gate (#743) — see `TickLoopConfig.decisionGate` */
  decisionGate: DecisionGate;
  /**
   * Where a materially degraded tick pass is escalated (#1084). Absent = no alerting — the honest default
   * for a caller (a focused unit test) that has not wired one through.
   */
  tickSkipAlerts?: TickSkipAlertChannel;
  /**
   * Held instruments for THIS tick, read once per pass and applied via `orderHeldFirst` before the claim
   * loop (#1390) — every instrument it names moves ahead of every one it does not. Absent = no reordering,
   * the honest default for a caller with no held-position reader wired. A rejection is swallowed: a
   * held-lookup failure must cost this tick's priority, not this tick's flatten.
   */
  heldAssets?: () => Promise<ReadonlySet<string>>;
}): { stop: () => Promise<void> } {
  let stopped = false;
  /** Consecutive-degraded-tick counter for the escalation above (#1084) */
  const tickSkipThrottle = new TickSkipThrottle();
  /**
   * Instruments with a pass still in flight (#669), each mapped to the TOKEN of the claim that owns it — a
   * bare `Set` is not enough: claims release per instrument as each pipeline settles, so a fast instrument
   * can be re-claimed by a later pass before a slower earlier pass's backstop runs and deletes every asset
   * it claimed, including the one now owned by the later pass. The token makes release ownership-aware, so a stale release is a no-op.
   */
  const running = new Map<string, symbol>();
  /** Outstanding passes, so `stop()` awaits them instead of abandoning them mid-pipeline */
  const passes = new Set<Promise<void>>();
  let handle: NodeJS.Timeout | undefined;

  /** Releases `asset` only if `token` still owns it. See `running`. */
  const release = (asset: string, token: symbol): void => {
    if (running.get(asset) === token) {
      running.delete(asset);
    }
  };

  /**
   * Clears each instrument's guard when THAT instrument's pipeline settles, not when the whole pass does —
   * releasing on pass completion is still a per-PASS guard wearing a per-instrument shape (a fast instrument
   * stays marked running until a slow sibling finishes, reproducing the starvation #669 exists to remove).
   * Built PER PASS so it closes over that pass's own claim tokens.
   */
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

      // #1390: held-first, computed BEFORE the claim loop and never inside it — the claim loop's
      // check-then-set has to stay one synchronous pass over the plan, so the only safe place for an async read is upstream of it
      let instruments = plan.instruments;
      if (deps.heldAssets !== undefined && instruments.length > 0) {
        try {
          instruments = orderHeldFirst(instruments, await deps.heldAssets());
        } catch (error) {
          // A failed position read must not cost the tick — only its
          // priority. Falling through to the unordered plan keeps every
          // instrument claimable exactly as before #1390 shipped
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

      // Re-checked here, not only in `schedule()`: `await deps.heldAssets()` above is a yield point ahead
      // of `stop()`'s `Promise.all` snapshot — without this check, a `stop()` racing during the held-position read would return without waiting for the instruments this pass is about to claim
      if (stopped) return;

      // Claim inside ONE loop — check and claim per asset, not filter-then-add. A separate filter/add pass
      // is not atomic: if `nextTick` ever returned the same asset twice, both entries would pass the filter
      // before either was claimed, silently violating the one-pass-per-instrument invariant this guard exists to hold
      const claims = new Map<string, symbol>();
      const ready: typeof plan.instruments = [];
      const busy: string[] = [];
      // Separated from `busy` (#692): a within-plan duplicate and a still-running instrument are opposite
      // things — one is a slow pass (the steady state this guard tolerates), the other is `nextTick` handing
      // back a malformed plan (a scheduler bug). Collapsing them hid the second exactly when the guard caught it.
      const duplicated: string[] = [];
      // Duplicate detection reads THIS set, not `claims`: keying off `claims` misses a duplicate whose
      // first occurrence was already running from a prior pass (never entered `claims`), reporting it as an
      // ordinary slow pass — the malformed plan hidden again, in exactly the case a duplicate matters most
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
        // #1390: this tick still contributes NOTHING for every busy instrument, held ones included — safe
        // to defer since the pass that OWNS them was itself built held-first, PROVIDED it was already held
        // when that pass's plan was built. A lot opened after that read waits one pass, same as before this fix.
        deps.logger.log({
          trace_id: 'tick-loop',
          stage: 'tick-loop',
          // INFO, not warn: a partially-busy tick is the steady state (slow crypto debates routinely
          // outlast the interval), so at `warn` this would fire every interval and bury the case that
          // matters — the equity leg falling behind inside its two-hour window
          level: 'info',
          // Named, not counted: WHICH instrument is late decides whether this is benign — a bare count can't distinguish "crypto is slow again" from "the equity leg has stopped keeping up"
          message: `tick: ${busy.length} instrument(s) still running from a previous pass, skipped this tick`,
          payload: { skipped: busy, ran: ready.length },
        });
      }

      if (duplicated.length > 0) {
        // WARN, unlike `busy` above: this is not a steady state — the scheduler returned the same asset
        // twice in one plan, which no correct `nextTick` does. The guard made the duplicate lose to itself, but the plan that produced it is still a bug nothing else would report.
        deps.logger.log({
          trace_id: 'tick-loop',
          stage: 'tick-loop',
          event: 'tick_plan_duplicates_dropped',
          level: 'warn',
          message: `tick: scheduler returned ${duplicated.length} duplicate instrument(s) in one plan, extras dropped`,
          payload: { duplicated },
        });
      }

      // #1084: escalates a materially degraded PASS, separate from the quiet `info` log above. Computed
      // and AWAITED unconditionally, BEFORE the early return below — a 100%-skipped tick is the single most
      // degraded case this exists to catch, and placing it after that return would silently skip it (see
      // "Guards Before Early Returns"). `planned` excludes `duplicated` entries, which would inflate the denominator and suppress an alert.
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
          // Backstop only — `buildGuardedRunner` clears each instrument as its own pipeline settles. This
          // catches an instrument the plan claimed but `runTickPlan` never dispatched (a throw between claim
          // and call), which would otherwise stop trading it silently forever. Ownership-aware: releases only claims THIS pass still owns.
          for (const [asset, token] of claims) release(asset, token);
        });

      // What `stop()` awaits is a SHIELDED view of the pass, not the pass itself (#692): `Promise.all`
      // attaches a second, independent handler, so a pass failing after `stop()` snapshotted the set would
      // otherwise reject `Promise.all` and abandon every OTHER outstanding pass mid-pipeline. The failure is not swallowed — `runOnce` still awaits and logs the raw pass.
      const settled = pass.catch(() => undefined);
      passes.add(settled);
      try {
        await pass;
      } finally {
        passes.delete(settled);
      }
    } catch (error) {
      // A thrown tick must not kill the process: the heartbeat's silence is the intended external failure signal, and a transient stage/transport error should cost one tick, not the run
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
      // Re-armed BEFORE the pass rather than after it (#669) — chaining on completion made the real period
      // `interval + passDuration`, the same starvation by a different route. The per-instrument guard is what makes this safe: a still-working instrument is skipped by name.
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
      // Every outstanding pass, not just the newest — with the interval re-armed ahead of the pass, more
      // than one can legitimately be in flight. This only waits because `passes` holds SHIELDED promises
      // (#692); the raw chain would reject `Promise.all` and drop the remaining passes. The wait now spans
      // up to W passes serialized behind one another's portfolio tails (#1040), each bounded by the head's
      // `raceWithTimeout` plus `DEFAULT_CRITIC_BUDGET_MS` (10s) since #957 folded the Risk Critic into the tail
      await Promise.all(passes);
    },
  };
}

/**
 * The equity venue's calendar, chosen by MODE rather than hardcoded (#668) — `LseRegularHoursCalendar`
 * landed with no production caller, so every flatten decision would have resolved through the US 16:00 ET
 * boundary, hours after the 16:30 LSE close. Live equity is Saxo UK GIA (ADR-0015), paper is Alpaca US, and
 * the two sessions overlap by only two hours (#656), so a FUNCTION is needed at each of the two call sites
 * (component root, scheduler) rather than two independent literal defaults that could silently diverge. `config.tradingCalendar` still overrides both.
 */
export function equityCalendarFor(config: ProductionConfig): TradingCalendar {
  if (config.tradingCalendar !== undefined) {
    return config.tradingCalendar;
  }

  return config.mode === 'live'
    ? new LseRegularHoursCalendar()
    : new UsEquityRegularHoursCalendar();
}

/**
 * #1390's `heldAssets` reader — the union of BOTH arms' open positions, not just the live arm's.
 * `ProductionComponents.executionStore` only ever holds `arm: 'live'` rows; the control arm writes its own
 * lots into its own store. A live-only reader would leave every control-arm lot exactly as unprioritized as
 * before #1390 shipped — round-1 review caught this on the ticket's own incident, where all nine held lots were `arm: 'control'`.
 */
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

/**
 * The full composition root: every stage bound, every store constructed, and a `start`/`stop` pair for the
 * entrypoint. Startup order is orphan-scan-then-loop (ADR-0004 §3): the scan reports `go` verdicts a prior
 * crash stranded before Execution, and must read the audit trail before this run starts writing to it.
 */
export function buildProductionOrchestrator(config: ProductionConfig): ProductionOrchestrator {
  const logger = config.logger ?? new JsonLogger();
  const clock = config.clock;
  const components = buildProductionComponents(config);

  const persistence = buildPersistence(config.db);
  const tickRunner = new SequentialTickRunner(components.steps);
  // ONE calendar object, shared by the scheduler's gate and the flatten tail below — the two-copies hazard `equityCalendarFor`'s docblock exists to prevent applies with more force now that the tick window derives from `sessionEnd`
  const equityCalendar = equityCalendarFor(config);
  const scheduler = new UniverseScheduler({
    universe: components.universe,
    calendar: equityCalendar,
    // Passed through rather than defaulted here (#706): the composition root is where a run's policy is
    // chosen, and a default here would apply the window to the backtest harness and every programmatic
    // caller that never asked for it. Widened to the flatten tail before it reaches the scheduler, since the
    // Trader is the only thing that flattens — the entry window alone would remove every tick that could satisfy flat-by-close
    ...(config.stocksTradingWindow === undefined
      ? {}
      : {
          stocksTradingWindow: withFlattenTail(
            config.stocksTradingWindow,
            equityCalendar,
            config.traderConfig.flatten_before_close_ms,
          ),
        }),
    // #1389, UNCONDITIONAL unlike the narrowing above — the grace is not a policy a run opts into, it's
    // the second half of ADR-0014's flatten window. Resolves through the SAME `equityCalendar`, so a non-trading day has no close to be inside the grace of.
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
  /**
   * #753: falsifier arm 2's own fill poller — a SECOND loop rather than a widened first one, since
   * `ingestFills()`/`reconcile()` are bound to one store and one broker, and the arms deliberately share
   * neither. Without this the control arm's lots stop dead at `submitted` and the comparison report reads "made no trades" — indistinguishable from a control that found no setups.
   */
  let controlFillSync: { stop: () => Promise<void> } | undefined;
  let heartbeatHandle: NodeJS.Timeout | undefined;
  let feedbackHandle: NodeJS.Timeout | undefined;
  // Mirrors the SHAPE of `fill-sync.ts`'s own `stopped` flag (#1110), not its scope — this flag is
  // builder-scope and monotonic (`stop()` sets it `true`, never resets it), so `scheduleFeedbackCycle`
  // resets it itself on every call; without that reset, a `start()` after a `stop()` would run its boot catch-up cycle once and then refuse to re-arm
  let feedbackScheduleStopped = false;
  let gdeltHandle: NodeJS.Timeout | undefined;
  let polymarketHandle: NodeJS.Timeout | undefined;

  // Execution's two polled surfaces, bound once. Built from the same
  // `ExecutionStepDeps` the tick step uses, so the two paths cannot drift
  const fillSyncExecution = buildExecutionSurface(components.executionDeps, FILL_SYNC_TRACE_ID);
  const reconcileExecution = buildExecutionSurface(components.executionDeps, RECONCILE_TRACE_ID);

  /**
   * Feedback Loop's daily batch on its own timer, not a `TickSteps` member (ADR-0004 §3). Synchronous and
   * store-driven, so a throw here would take the timer callback down with it — caught and logged for the same reason the tick loop catches.
   */
  // Constructed once and closed over, not per invocation — the stores are stateless over the shared handle, so a fresh set each cycle bought nothing (code-review 2026-08-01, H7)
  const feedbackStores = {
    trades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop')),
    debate_log: new SqliteDebateLogStore(guardedStore(config.db, 'debate-engine')),
    tuning: components.tuning,
    adjustments: new SqliteAdjustmentLog(guardedStore(config.db, 'feedback-loop')),
  };
  /**
   * #366, retargeted by #736. Resolved once, outside the timer callback, read in the same precedence order
   * the alert channels use. None of them gate anything: since ADR-0013 Decision 2 the cycle applies its own
   * bounded loosenings and this channel only reports them, so a delivery failure costs visibility, not safety.
   */
  const loosenNotices =
    config.feedback?.loosenNotices ??
    config.loosenNotices ??
    loggingAlertChannel('loosenNotices', logger);

  /**
   * The detector's source, built once at construction (#379), never per cycle or per tick. A factory is
   * called eagerly rather than at first cycle deliberately: the first cycle is up to 24h away, and a
   * construction error must fail the start it belongs to rather than surface a day later inside a caught timer callback.
   */
  /**
   * The frozen Stage 2 selections (#375, #384). One instance, read by two consumers (the metrics source and
   * the divergence baseline) — both must see the same row, since a selection good enough to arm three kill-lines and not the fourth would be incoherent.
   */
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

  /**
   * `computeMetrics`'s production caller (#327) — what makes the four kill-lines reachable in a paper run
   * at all. Runs after `runDailyCycle` in the same timer, so a breach's auto-tighten lands on thresholds the
   * cycle has already finished writing. Returns without computing when no suite is available — the honest
   * path, logged at `warn` so a cycle that checked nothing never looks like one that found nothing.
   */
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
      // The same `FeedbackConfig` the tuning cycle used — its
      // `kill_thresholds` are the four lines, and its `risk_thresholds` are
      // what a breach auto-tightens
      config: feedbackConfig,
      alerts: components.breachAlerts,
    });

    logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'daily_metrics_computed',
      // A breach is an `error` even though the alert channel also carries it:
      // the log is the record an operator reads back after the fact
      level: report.breaches.length > 0 ? 'error' : 'info',
      message:
        report.breaches.length > 0
          ? 'daily metrics computed — KILL-THRESHOLD BREACH (alerted, thresholds auto-tightened)'
          : 'daily metrics computed',
      payload: {
        breaches: report.breaches,
        // Carried into the log as well as the report so a revalidation-less
        // day is legible in the log stream, not only to a caller holding the
        // returned `MetricsReport`
        not_evaluated: report.not_evaluated,
        revalidation_present: report.revalidation !== undefined,
        daily: report.daily,
      },
    });
  };

  /**
   * The matched-control comparison's production caller (#971, under #636/#913) — what makes falsifier arm
   * 2's numbers reach an operator without a human running `npm run report:arms`. Runs in the same daily
   * timer (#636: no new scheduling primitive) but deliberately NOT inside `runMetricsCheck`, since the
   * comparison is computable from `closed_trades` on every day, unlike a `MetricsSuite`. Reads
   * `SqliteArmComparisonSource`, not `feedbackStores.trades` (scoped to `arm = 'live'` so the loop never tunes on the control's outcomes).
   */
  const armComparisonSource = new SqliteArmComparisonSource(guardedStore(config.db, 'control-arm'));
  const armComparisonSamples = new SqliteArmComparisonSampleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  /**
   * The daily cycle's restart-durable schedule (#1110, migration 0044) — see `scheduleFeedbackCycle` below.
   * Constructed unconditionally, like `armComparisonSamples` above, even though only touched when `config.feedback` is supplied.
   */
  const feedbackScheduleStore = new SqliteFeedbackCycleScheduleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  /**
   * The outside benchmarks' production caller (#981, under #636) — SPY and 60/40 over the MATCHED
   * CONTROL'S window, on FL's existing cadence. Reads `components.benchmarkSeries` (a stocks-rooted source
   * taking no `universe`), NOT `components.marketData`, since that source refuses `'SPY'` once the universe
   * is LSE-only (#734/#751), which would strand both benchmarks in `unmeasured`. No new vendor/key/spend — SPY/AGG are ordinary Alpaca IEX-feed bars.
   */
  const outsideBenchmarkSeries = components.benchmarkSeries;
  const outsideBenchmarkSamples = new SqliteOutsideBenchmarkSampleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  /**
   * Fire-and-forget, but NEVER unhandled. `runFeedbackCycle` is synchronous, called from a self-rescheduling
   * `setTimeout` with no `await` seam, so an unawaited rejecting promise would be both an unhandled
   * rejection and a benchmark that silently never persists. Runs AFTER the arm comparison and inherits its `comparison`'s window, never recomputing it (#636's exact-window condition).
   */
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
          // `warn` only when a benchmark could not be measured — out-performing the book is context, never a warning (#636: secondary, never a verdict input)
          level: result.unmeasured.length > 0 ? 'warn' : 'info',
          message:
            result.unmeasured.length > 0
              ? 'outside benchmarks computed — SOME NOT MEASURED (absent, not zeroed)'
              : 'outside benchmarks computed',
          payload: {
            window_from: comparison.from.toISOString(),
            window_to: comparison.to.toISOString(),
            // Return AND drawdown together on every measured benchmark
            // (`docs/research/12-edge-hypothesis-critique.md` D4)
            measured: result.measured.map((sample) => sample.performance),
            // The reason a benchmark is absent lives HERE and nowhere else: FL
            // persists no row for it, so without this line "the vendor failed"
            // and "FL never ran" are the same empty panel
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
      // The declared book, not live equity, is the denominator for both arms' `return_pct` (#1112 AC3
      // pins it to the Trader's sizing ceiling) — converted (#1180) since the numerator is USD, and the
      // conversion only moves the SCALE, never a comparison between the arms
      basis: LIVE_BOOK_SIZING_USD,
      window_ms: DEFAULT_ARM_COMPARISON_WINDOW_MS,
      thresholds: DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    });

    logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'arm_comparison_computed',
      // A divergence is `warn`, not `error`: nothing failed and no dial moved
      // (contrast the kill-line breach above, which auto-tightens). It is the
      // measurement #636 asked for, and the operator decides what it means
      level: sample.divergence.diverged ? 'warn' : 'info',
      message: sample.divergence.diverged
        ? 'arm comparison computed — ARM DIVERGENCE (alerted, nothing auto-tightened)'
        : 'arm comparison computed',
      payload: {
        window_from: sample.comparison.from.toISOString(),
        window_to: sample.comparison.to.toISOString(),
        basis: sample.comparison.basis,
        // Both arms, both columns — never a return without its drawdown
        // (`docs/research/12-edge-hypothesis-critique.md` D4)
        live: sample.comparison.live,
        control: sample.comparison.control,
        diverged: sample.divergence.diverged,
        divergence_reason: sample.divergence.reason,
      },
    });

    // Returned so #981's benchmark cycle can inherit this window rather than
    // recomputing one. The arm comparison's own logic above is untouched.
    return sample.comparison;
  };

  // #1045 / #1060 / #1131: the same values the boot-time sweeps in
  // `buildProductionComponents` applied, from the one environment read
  const { llmCallLogMaxRows, miArchiveRetentionDays, alertDeliveryFailureRetentionDays } =
    components.environment;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: every statement's position is individually documented as load-bearing — the three prunes must stay OUTSIDE the try (#1045/#1060/#1131), the metrics check must run AFTER the cycle's own success log, and the arm comparison must stay OUTSIDE the metrics guard (#971) and BEFORE the outside-benchmarks call (#981) — extraction risks silently reordering one of these
  const runFeedbackCycle = (feedback: FeedbackCycleConfig): void => {
    // #1045, deliberately FIRST, outside the try below: a persistently throwing feedback cycle must not
    // silently disable retention too. Rides the existing daily cycle rather than a second scheduler (#636),
    // and inherits whatever cadence is configured since #1110's wall-clock-boundary schedule below
    pruneLlmCallLogWithLog(config.db, llmCallLogMaxRows, logger, 'daily');
    // #1060. Same placement rule applies: outside the try, so a persistently
    // failing feedback cycle cannot silently disable the MI archive's purge
    pruneMiArchiveWithLog(config.miArchive, miArchiveRetentionDays, clock, logger, 'daily');
    // #1131. Same placement rule applies: outside the try, so a persistently
    // failing feedback cycle cannot silently disable alert_delivery_failures's purge
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
        // No `mode` here since #736: the cycle ran one path in backtest and a
        // different, gated one in paper and live, and the gate is gone
      });
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'info',
        message: 'daily feedback cycle complete',
        payload: result,
      });

      // Inside the same try/catch, deliberately AFTER the cycle's own log line, so a metrics failure can't erase the record that the tuning cycle itself succeeded
      if (feedback.metrics !== undefined && metricsSource !== undefined) {
        runMetricsCheck(metricsSource, feedback.metrics, feedback.config);
      }

      // #971: OUTSIDE the `feedback.metrics` guard, deliberately — the comparison needs only `closed_trades`, so gating it on the metrics source would hide the matched control early in a soak
      const comparison = runArmComparison();

      // #981: outside benchmarks, over the same window `runArmComparison` measured — inside the same try/catch and AFTER it, so a benchmark can never cost the operator the matched control's reading
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

      // #766: the daily kill-line check's half of #638's clamp — a throw here previously left the cycle silently un-run beyond this log line. Runs at most once/day, so no latch is needed
      if (isThresholdBoundViolation(error)) {
        // #1110: guarded — `scheduleFeedbackCycle` records the boundary only AFTER this function returns,
        // on the premise `runFeedbackCycle` cannot throw; this `try` keeps that true even when `thresholdClampAlerts` is a caller-supplied channel with no such guarantee
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

  /**
   * Arms the daily feedback cycle on a restart-durable, wall-clock-boundary schedule (#1110) — replaces a
   * plain `setInterval` that never accumulated 24h of uptime on a soak restarting more often than daily.
   * Catch-up is capped at exactly ONE cycle (never a queue of missed boundaries), and the boundary is recorded
   * AFTER `runFeedbackCycle` returns, not before — recording before risked losing a boundary's cycle forever on a crash.
   */
  const scheduleFeedbackCycle = (feedback: FeedbackCycleConfig, intervalMs: number): void => {
    // Reset on every call, not just at module load — `stop()` sets this `true` and never resets it, so without this a second `start()` after `stop()` would refuse to re-arm (#1110's exact symptom through a third door)
    feedbackScheduleStopped = false;

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the attempt marker must be recorded BEFORE runFeedbackCycle and the boundary AFTER it (#1110, both explicitly ordered), and the re-arm must run in a finally so a thrown check can never leave the timer un-armed — extraction risks silently reordering one of these
    const runIfDue = (): void => {
      try {
        // `new Date()` (real/faked wall time), not `clock.now()` — see
        // DESIGN DECISION 1 above
        const now = new Date();
        const boundary = currentBoundary(now, intervalMs);
        const last = feedbackScheduleStore.lastBoundary();

        if (isBoundaryDue(boundary, last)) {
          const attempted = feedbackScheduleStore.attemptedBoundary();
          const alreadyAttempted = attempted !== null && attempted.getTime() === boundary.getTime();

          if (alreadyAttempted) {
            // A prior attempt for this EXACT boundary was stamped; this restart can't tell whether the
            // cycle completed or died mid-run, so only the completion stamp is retried, never the cycle itself — re-running risks double-applying its guardrail-capped step
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
              // BEFORE `runFeedbackCycle` — see the ordering note above
              feedbackScheduleStore.recordAttempt(boundary, now);
            } catch (attemptError) {
              // Best-effort: a failure here must not block the cycle from running — it only means a restart before `recordBoundary` completes won't be recognised as a retry
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
          // AFTER `runFeedbackCycle`, not before — see the ordering note above
          feedbackScheduleStore.recordBoundary(boundary, now);
        }
      } catch (error) {
        // #1110: a throw here (most likely `SQLITE_BUSY` on the shared WAL file) must not take the timer
        // down — before this `try`, an uncaught throw left the cycle unarmed for the rest of the process's life with no further log line, the exact symptom #1110 was filed to fix
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

      // Reconcile BEFORE the tick loop, awaited rather than fired off: a crash leaves lots stranded `pending`/`submitted`, so a failure here must propagate out of `start()` rather than being logged and stepped over
      await runStartupReconcile({
        execution: reconcileExecution,
        logger,
        traceId: RECONCILE_TRACE_ID,
      });

      // #753: the control arm's own startup reconcile, same reason as the live arm's — awaited and allowed
      // to propagate since it writes through the SAME database handle the live arm trades against
      // #1321: uses `CONTROL_RECONCILE_TRACE_ID`, not the live arm's, so the two arms' reconcile passes are distinguishable in the log
      await runStartupReconcile({
        execution: components.controlArmWiring.reconcileExecution,
        logger,
        traceId: CONTROL_RECONCILE_TRACE_ID,
      });

      // #371, placed beside reconcile before the tick loop. This path fails fast, unlike its siblings
      // below (which degrade a MISSING FEATURE to a warn): a throw here means the shared store won't take
      // a write at all, and that same handle carries open positions/fills/closed trades — a process that can't write to it must not go on to place orders
      if (config.feedback !== undefined) {
        // `runDailyCycle` only steps analysts with an existing `analyst_weights` row — without this every
        // cycle attributed trades and skipped every analyst. First-write-wins so a restart mid-soak can't flatten what the loop has learned
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

      /**
       * #433, NOT gated on `config.feedback`: the Risk Manager reads these caps at every `evaluate()`
       * regardless of whether a daily cycle runs, and `autoTighten` can't step a value it can't read.
       * First-write-wins, so a restart can't re-open a cap the loop already narrowed.
       */
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
      // Built or absent together: both hang off `config.miArchive`, so the
      // optional call below is narrowing, never a live "one without the other"
      const gdeltScoringPass = components.gdeltScoringPass;
      if (gdeltIngestAgent !== undefined) {
        /**
         * GDELT polls on its OWN timer, not the analysts step (#556): it's a per-world batch, not
         * per-instrument, and a ~3.4MB download would add seconds to the tick's critical path.
         * Archive-then-derive, in that order, so the scoring pass reads what this same poll just archived.
         * Fire-and-forget: both halves' contracts guarantee no throw, so a `catch` firing means a broken contract.
         */
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

        // Immediately, then on the interval: waiting a full period before the first poll would throw away the oldest 15 minutes on every restart
        pollGdelt('startup');
        gdeltHandle = setInterval(() => {
          pollGdelt('gdelt-poll');
        }, config.gdeltPollIntervalMs ?? DEFAULT_GDELT_POLL_INTERVAL_MS);
      }

      /**
       * Polymarket polls on its OWN timer too (#504), for GDELT's per-instrument reason — the curated
       * table is macro, and the hourly bucket means most polls make no request at all. Fire-and-forget,
       * since `refresh` never throws; immediate-then-interval so a restart doesn't start with an empty `news` bucket.
       */
      const polymarketAgent = components.polymarketAgent;
      void polymarketAgent.refresh('startup');
      polymarketHandle = setInterval(() => {
        void polymarketAgent.refresh('polymarket-poll');
      }, config.polymarketPollIntervalMs ?? DEFAULT_POLYMARKET_POLL_INTERVAL_MS);

      // #1321: the control arm's own trace ids, matching its execution surface's — this loop can no longer default to the live arm's constants for both arms
      controlFillSync = startFillSync({
        execution: components.controlArmWiring.fillSyncExecution,
        clock,
        logger,
        fillPollIntervalMs: config.fillPollIntervalMs ?? DEFAULT_FILL_POLL_INTERVAL_MS,
        reconcileTraceId: CONTROL_RECONCILE_TRACE_ID,
        fillSyncTraceId: CONTROL_FILL_SYNC_TRACE_ID,
        // #1389: the CONTROL arm's carried-lot detector is not an afterthought — the seven lots that
        // carried overnight on 2026-09-08 were control-arm lots. Bound to the control arm's own store (arm-scoped, #753)
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

      // #1543, deliberately LAST, right before the tick loop arms: `analystTimeoutMs` is sized against a
      // WARM store, so an empty one makes the first pass reach the venue serially and lose the first tick
      // to a timeout with no fault behind it. Skipped in backtest, where `cachedBars` disables itself.
      if (config.mode !== 'backtest') {
        const prefetch = await prefetchBars({
          marketData: components.marketData,
          universe: components.universe,
          asOf: clock.now(),
          logger,
          traceId: 'startup',
        });
        // `bar_prefetch_complete` already warns on a PARTIAL failure; this is
        // the distinct case where NOTHING warmed and the tick loop is about to
        // arm on exactly the cold store #1543 exists to avoid
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
        // #743: one gate per orchestrator, held across ticks — its per-bar
        // claims are what turn the 2-minute tick into a once-per-bar decision
        decisionGate: new DebateBarDecisionGate(),
        // #1084 — the eighteenth `ALERT_CHANNEL_FIELDS` member
        tickSkipAlerts: config.tickSkipAlerts ?? loggingAlertChannel('tickSkipAlerts', logger),
        // #1390: unions both arms' open positions — see `buildHeldAssetsReader`'s
        // doc for why the live arm's store alone is not enough
        heldAssets: buildHeldAssetsReader(components),
      });

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the boundary read at the bottom is explicitly documented as happening BEFORE scheduleFeedbackCycle's first check ("so this reports what was true when the process came up, not the post-catch-up state"), and the intervalMs validation is a deliberate boot crash at a specific point in the sequence — extraction risks separating a diagnostic from the arming call it describes
      function runFeedbackCycleStartup(): void {
        // #327: both degraded modes were previously reached by pure omission — no warn, no trace. Warned at STARTUP, not first use, since the first daily cycle is up to 24h away and silence looks like breakage
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
          // The weight rows this cycle will step were seeded above, before any
          // of the loops started (#371)
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
            /**
             * #379: the wired case, announced at startup for the same reason the unwired one is — a
             * detector that won't produce a suite for a calendar quarter (60-observation gate, ADR-0006 §5)
             * is not the same as one that ran and found nothing, so this line must not just be replaced by silence
             */
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

            /**
             * The three revalidation-gated kill-lines, stated at startup since nothing else does until a
             * suite exists (~60 sessions out, ADR-0006 §5). Reads `usableRevalidationSelections` — the
             * SAME predicate the metrics source applies — so this line can't drift from the decision it reports.
             */
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

            /**
             * #375: kept visible where an operator will see it. Wiring the metrics source (#379) removed
             * the blanket "all kill-lines unevaluated" warn that used to cover this line's inertness too,
             * so it's stated here instead — once per process, since the value is frozen config.
             */
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
          // #1110: states the schedule at startup, read BEFORE `scheduleFeedbackCycle`'s first check so it reports pre-catch-up state. `new Date()`, matching that function's own boundary math
          const feedbackIntervalMs = feedback.intervalMs ?? DEFAULT_FEEDBACK_INTERVAL_MS;
          // Named validation, not a bare `currentBoundary` throw: `FeedbackCycleConfig.intervalMs` is
          // unvalidated elsewhere, so a non-positive/NaN value would otherwise die inside `cycle-schedule.ts`
          // with a generic, unattributed message. Deliberately still a boot crash — the `setInterval(fn, 0)` this replaced would have hot-looped on the same bad config.
          if (!Number.isFinite(feedbackIntervalMs) || feedbackIntervalMs <= 0) {
            throw new Error(
              `FeedbackCycleConfig.intervalMs must be positive, got ${feedbackIntervalMs}`,
            );
          }
          const feedbackBoundaryNow = currentBoundary(new Date(), feedbackIntervalMs);
          // #1110 gap: an unreadable schedule store is not on the order path — must not stop a process managing open positions from booting, and `runIfDue` already swallows the identical failure
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
          // Computed once and carried on BOTH branches' payload (#1110): the due-now branch is a fresh deploy or post-outage restart, exactly when an operator most needs the next-scheduled instant
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
      // Timers first, in-flight drain second: nothing new may start while the
      // current pass finishes
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
      // Both drains started before either is awaited: they are independent,
      // and awaiting them in series would make shutdown take the sum of a
      // tick and a fill poll rather than the longer of the two
      const stopping = loop?.stop();
      const stoppingFillSync = fillSync?.stop();
      // #753: drained beside the live poller, started before either is awaited,
      // for the same reason the two above are — independent loops, so shutdown
      // takes the longest rather than the sum
      const stoppingControlFillSync = controlFillSync?.stop();
      // Clearing the timer stops the NEXT GDELT poll, not the one already downloading — that one ends in a guarded archive write, so this makes shutdown ordering deterministic
      const drainingGdelt = components.gdeltIngestAgent?.whenIdle();
      // Same ordering argument as the GDELT drain: clearing the timer stops
      // the NEXT poll, not the one already in flight, and that one ends in a
      // store and archive write
      const drainingPolymarket = components.polymarketAgent.whenIdle();
      // #1085: the MI refresh no longer completes inside the tick that asked for it, so the tick drain above no longer covers it — without this a shutdown can leave a refresh's write racing a closing store
      const drainingMiRefresh = components.marketIntelligenceRefresh?.stop();
      loop = undefined;
      fillSync = undefined;
      controlFillSync = undefined;
      // `allSettled`, not two sequential awaits: `stop()` CAN reject, and awaiting in series would leave the second drain's promise unawaited on that path — an unhandled rejection
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
