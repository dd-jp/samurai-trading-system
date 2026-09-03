/**
 * Production Composition Root (ticket #236) — see
 * [ADR-0004](../../docs/adr/0004-production-composition-root.md),
 * docs/specs/orchestrator-spec.md ("Module: Production Composition Root"),
 * closed wayfinder map #224.
 *
 * This is the one place real dependencies get closed over test-double-free:
 * it combines #234's direct-bound stages (`trader`/`risk`/`verdict`/
 * `execution`) and #235's adapter-bound stages (`analysts`/`debate`) into a
 * single `SequentialTickRunner`, constructs the persistence/reliability
 * instances around it (`SqliteAuditLog`, `SqliteCurrentTickStore`,
 * `OrphanVerdictScanner`, `UniverseScheduler`, `Heartbeat`), and owns the
 * process-level start/stop of the tick loop. It implements no stage logic
 * and no persistence of its own (ADR-0004 §3: "constructs and wires ... does
 * not implement any of them").
 *
 * ## Injected leaves — why `ProductionConfig` is large
 *
 * Every transport this system talks to (Alpaca REST for orders and for bars,
 * the Telegram/Discord trade channel, WorldMonitor's CII feed) once existed in
 * the codebase as an *interface only*, and writing them here would have been
 * implementing three or four components under a wiring ticket. So they became
 * optional `ProductionConfig` fields instead: this module composes everything
 * that *can* be composed from in-repo code and names the rest as explicit
 * seams. That is exactly the precedent #234 set one level down with
 * `AccountStateProvider` / `VolatilityReadingProvider` — an honest injected
 * seam beats a fabricated implementation.
 *
 * Most of them have since been filled in: `AlpacaHttpBrokerClient` /
 * `AlpacaHttpDataClient` (#273/#286) and `NousMessagesClient` (#274, retargeted
 * at Nous by ADR-0009) are built here by default, and `TelegramBotApiClient` (#275) is built one
 * level up, in `startFromEnvironment`, and passed in as the three alert
 * channels below (#322 — see alert-transport.ts for why the *selection*
 * belongs at the entrypoint rather than here). `CiiScoreProvider` is the one
 * genuinely unimplemented transport left, deliberately parked (ADR-0002).
 *
 * The LLM provider is the one exception: since #274, `NousMessagesClient`
 * (debate-engine/llm/nous-messages-client.ts) is a real, in-repo
 * `AnthropicMessagesClient` implementation, so this module builds the
 * `AnthropicLlmClient` Debate/disagreement-detection close over by default —
 * `ProductionConfig.llmClient` is now an optional override (same shape as
 * `broker`/`dataSource` below), not a required seam. The default resolves its
 * key, model and base URL through `nousCredentials('debate')` (see
 * `buildDefaultLlmClient`), and logs a `warn` at build time so a live client
 * being constructed — real per-call spend — is never silent.
 *
 * ## Two entry points, not one
 *
 * The ticket asks for `buildProductionTickRunner(): SequentialTickRunner`;
 * the spec sketches a `buildProductionTickRunner(config)` returning the
 * runner *plus* scheduler/heartbeat/orphan-scanner. Both are provided rather
 * than picking a winner: `buildProductionTickRunner` has the ticket's literal
 * return type, and `buildProductionOrchestrator` returns the full bundle plus
 * the `start`/`stop` the entrypoint needs.
 *
 * ## Feedback Loop wiring, per ADR-0004 §3
 *
 * ADR-0004 asks for Feedback Loop's `onTradeClose` and `runDailyCycle` at
 * this composition point, "not as `TickSteps` members". `runDailyCycle` is
 * wired, on its own daily timer independent of the tick chain, and starts
 * only when `ProductionConfig.feedback` is supplied; its four stores are all
 * SQLite-backed and constructed here. **Not starting it is announced at
 * startup at `warn` (#327)** — it used to be reached by pure omission, which
 * is the same silent-by-omission bug #293/#320/#322 closed elsewhere.
 *
 * **And a paper run now supplies it (#366).** The two inputs that used to have
 * no in-repo source have the same two homes every comparable input already
 * had: the `FeedbackConfig` values are starting values, so they sit in
 * `paperStartingProfile` (paper-profile.ts) beside the other eight sets, and
 * the loosen-notice channel is a transport, so it is selected from
 * `SAMURAI_ALERTS` (alert-transport.ts) and defaults to
 * `LoggingLoosenNotificationChannel` here. Before that, the 14-day soak (#238)
 * would have run stage 6 of a 6-stage pipeline dead for the whole window.
 *
 * `computeMetrics` — the kill-line detector — runs in that same timer, after
 * the tuning cycle, whenever `FeedbackCycleConfig.metrics` supplies a
 * `DailyMetricsSource` (#327). Before that ticket it had no production caller
 * at all, so all four kill-lines were unreachable in a paper run. The suite is
 * *supplied* through that port rather than computed inline, but a real
 * implementation of it now exists: `SqliteDailyEquityMetricsSource` derives a
 * live `ReturnSeries` from `daily_equity` (migration 0011, #345, ADR-0006),
 * which this file's `AlpacaAccountStateProvider` samples on every tick. It
 * refuses to produce a suite below a justified minimum observation count,
 * because a breach WRITES risk thresholds and a Sharpe over ~10 days is noise.
 * **A paper run now supplies that source too (#379)**, as a factory this root
 * resolves against its own handle — so the detector has a production caller
 * rather than one more tested mechanism waiting to be remembered. It is still
 * never defaulted here: an omitted `metrics` block leaves the detector off and
 * says so at startup.
 * A breach alerts through `ProductionConfig.breachAlerts` and never kills:
 * kill/rework stays a human decision, and there is no kill primitive here.
 * `onTradeClose` IS wired (#237, superseding this file's earlier note that it
 * was not): a `ClosedTrade` is never reachable from `TickOutcome.execution_result`
 * (`ExecutionImpl.execute()` returns a submission ack only, and
 * `intent_type: 'exit'` is unimplemented — #82/#83) — the only place one is
 * ever produced is `ingestFills()` calling `SharedStore.writeClosedTrade()`
 * (server/pipeline/execution/ingest-fills.ts), on its own polling path. So
 * `withOnTradeClose` (production/on-trade-close-hookup.ts) decorates
 * `writeClosedTrade` itself, using the real `SqliteSetupStore` (#198) FL
 * labels on trade close — not a `TickSteps` member, not reachable from
 * `SequentialTickRunner`.
 *
 * ## Fill sync — the other lifecycle this root owns
 *
 * `ingestFills()`/`reconcile()` ARE now scheduled (superseding this file's
 * earlier note that nothing drove them): `start()` awaits a one-shot
 * `reconcile()` before the tick loop, then runs `ingestFills()` on its own
 * self-scheduling poll — see `./fill-sync.ts` for why the ordering and the
 * non-`setInterval` cadence are both load-bearing. That is what gives
 * `withOnTradeClose` a live caller, and what lets a lot advance past
 * `submitted` at all.
 */
import { AnalystOrchestrator } from '../../pipeline/analysts/index.js';
// #753: falsifier arm 2's comparison reader — both arms, one window, one query.
import type { ArmComparison } from '../../pipeline/control-arm/index.js';
import { SqliteArmComparisonSource } from '../../pipeline/control-arm/index.js';
import type { LlmClient, SpendCap } from '../../pipeline/debate-engine/index.js';
import {
  RateLimiter,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
  SqliteSpendCap,
  UNCAPPED_SPEND,
} from '../../pipeline/debate-engine/index.js';
import type {
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
} from '../../pipeline/execution/index.js';
import {
  AlpacaBrokerAdapter,
  // #753: falsifier arm 2's venue. A measurement, not a second book.
  SimulatedBrokerAdapter,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
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
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
  runArmComparisonCycle,
  runDailyCycle,
  runOutsideBenchmarkCycle,
  SqliteAdjustmentLog,
  SqliteArmComparisonSampleStore,
  SqliteClosedTradeStore,
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
import { assertAutomationLevelSupported } from '../../pipeline/verdict/index.js';
import type { MarketDataService } from '../../providers/market-data-service/index.js';
import {
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
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
  GdeltGkgClient,
  GdeltIngestAgent,
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
import { positiveIntegerFromEnv } from '../../shared/env-integer.js';
import type { AssetClass, Clock, TuningStore } from '../../shared/index.js';
import { isThresholdBoundViolation, resolveVenuePacing, TokenBucket } from '../../shared/index.js';
import { tryNousCredentials } from '../../shared/llm/index.js';
import type { SharedStore as SqliteHandle } from '../../shared/store/index.js';
import {
  DEFAULT_MAX_LLM_CALL_ROWS,
  guardedStore,
  pruneLlmCallLog,
  SqliteRiskLogStore,
  SqliteTraderLogStore,
} from '../../shared/store/index.js';
import { CostModelImpl, SqliteStage2SelectionStore } from '../../tools/backtest/index.js';
import {
  LoggingAnalystSkipAlertChannel,
  LoggingAnalystTelemetry,
  LoggingArmDivergenceAlertChannel,
  LoggingBreachAlertChannel,
  LoggingDataFailoverAlertChannel,
  LoggingFlattenOverfillAlertChannel,
  LoggingFlattenReconcileAlertChannel,
  LoggingHeartbeatChannel,
  LoggingLoosenNotificationChannel,
  LoggingMiCoverageAlertChannel,
  LoggingMiCoverageTelemetry,
  LoggingOcoDoubleFillAlertChannel,
  LoggingOrphanAlertChannel,
  LoggingResidualExposureAlertChannel,
  LoggingUnpricedFillAlertChannel,
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
import { Heartbeat } from './heartbeat.js';
import { JsonLogger } from './logger.js';
import type { OrphanGoVerdict, OrphanVerdictScanner } from './orphan-verdict-scan.js';
import { LIVE_BOOK_GBP } from './paper-profile.js';
import { AlpacaAccountStateProvider } from './production/account-state.js';
import { buildAnalystsStep, composeMarketIntelligence } from './production/analysts-adapter.js';
// #753: the control arm's own account scalars — see `control-account-state.ts`.
import {
  buildControlBookAnchorResolver,
  ControlArmAccountStateProvider,
} from './production/control-account-state.js';
// #753: falsifier arm 2's composition — see `control-arm-wiring.ts`.
import {
  buildControlArmWiring,
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
import { assertFlattenWindowCoversTickInterval } from './production/flatten-tick-coupling.js';
import { MiCoverageMonitor } from './production/mi-coverage.js';
import { withOnTradeClose } from './production/on-trade-close-hookup.js';
import { withFlattenTail } from './production/stocks-tick-window.js';
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
 * The first paper run's universe (ADR-0004 §4, orchestrator-spec.md story
 * 18): one instrument, not `DEFAULT_UNIVERSE`'s six, so a wiring defect
 * surfaces against the smallest possible blast radius.
 *
 * BTC-USD specifically — crypto bypasses `UniverseScheduler`'s calendar gate
 * entirely (scheduler.ts: crypto never consults the calendar), so the smoke
 * run is not hostage to US market hours. A stock instrument would let a
 * closed session produce an empty `TickPlan`, which is indistinguishable at
 * a glance from a clean run that decided not to trade. Naming matches
 * `DEFAULT_UNIVERSE`'s.
 */
export const SMOKE_TEST_UNIVERSE: readonly UniverseInstrument[] = [
  { asset: 'BTC-USD', asset_class: 'crypto' },
];

/**
 * Every instrument symbol the outside-benchmark path can write, derived from
 * `BENCHMARK_COMPOSITION` rather than hardcoded (#989 review) — that table is
 * the one source of truth for what `buildBenchmarkDataSource` writes, and a
 * future third benchmark leg (or a leg swap) should not have to remember a
 * second, silently-stale literal list here. Consumed by the precutover
 * collision guard below. Upper-cased at the source (#989 review) so the
 * guard's own `.toUpperCase()` comparison is symmetric — a future
 * mixed/lowercase entry in `BENCHMARK_COMPOSITION` can't silently bypass it.
 * Exported so callers (`startup.test.ts`) derive the same set instead of
 * re-deriving it from `BENCHMARK_COMPOSITION` a second time (#989 review —
 * two derivations can silently diverge).
 */
export const BENCHMARK_INSTRUMENTS: ReadonlySet<string> = new Set(
  Object.values(BENCHMARK_COMPOSITION).flatMap((legs) =>
    legs.map((leg) => leg.instrument.toUpperCase()),
  ),
);

// Split out by the 2026-08-06 review (D1): the injectable-surface types live
// in ./production/config.ts and the checked-in defaults/default-client
// builders in ./production/defaults.ts. Re-exported here so this file remains
// the one import surface ADR-0004 names.
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
  DEFAULT_FEEDBACK_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_CLIENT_CONFIG,
  DEFAULT_LLM_RATE_LIMIT_CONFIG,
  universeAssetClasses,
} from './production/defaults.js';

import {
  buildAlpacaDataSource,
  buildBenchmarkDataSource,
  buildDefaultAlpacaBrokerClient,
  buildDefaultLlmClient,
  DEFAULT_FEEDBACK_INTERVAL_MS,
  DEFAULT_FILL_POLL_INTERVAL_MS,
  DEFAULT_GDELT_POLL_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_RATE_LIMIT_CONFIG,
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
  /** #752: the market-intelligence coverage monitor — see `ProductionComponents.marketIntelligenceCoverage`. */
  marketIntelligenceCoverage: MiCoverageMonitor;
  /**
   * The MI store itself (#504), exposed for `marketIntelligenceCoverage`'s
   * reason: the offline smoke gate has to read back what the ingestion agents
   * actually put in front of the analysts. An archive row proves a fetch
   * happened; only a `getContext` read proves the item reached the bucket
   * `fundamental` queries.
   */
  marketIntelligence: MarketIntelligenceStore;
  /**
   * Runs the orphan scan once, then starts the heartbeat interval and the
   * tick loop. Resolves once startup is done — the loop keeps running after.
   */
  start(): Promise<OrphanGoVerdict[]>;
  /**
   * Stops the heartbeat and the feedback timer immediately, and resolves once
   * any in-flight tick has finished. Awaiting the drain matters on shutdown:
   * killing the process between Verdict's `go` and Execution's write
   * manufactures exactly the orphaned verdict `OrphanVerdictScanner` (#209)
   * exists to detect. Idempotent.
   */
  stop(): Promise<void>;
}

/** Everything composed from in-repo code, built exactly once per process. */
export interface ProductionComponents {
  steps: TickSteps;
  /**
   * The operator escalation channel, exposed because TWO consumers need the
   * same instance: the Feedback Loop's kill-threshold breach, and the LLM
   * spend cap's breach (ADR-0008), which is constructed inside this function.
   * Returning it beats building a second one in `buildProductionOrchestrator`
   * — two channels would be two places for an injected override to be applied
   * to only one of them.
   */
  breachAlerts: BreachAlertChannel;
  /**
   * Where arm divergence escalates (#971), exposed for `breachAlerts`' reason:
   * the composition root resolves it once (injected override, else the log-only
   * stand-in) and the daily feedback cycle in `buildProductionOrchestrator` is
   * its consumer. A second instance built there would be a second place for an
   * injected override to be missed.
   */
  armDivergenceAlerts: ArmDivergenceAlertChannel;
  /**
   * The tuning dials, exposed for `breachAlerts`' reason (#433): the Risk
   * Manager READS `risk_thresholds` here at evaluate time and the Feedback
   * Loop's daily cycle WRITES them, and the two halves of that dial are wired
   * in different functions. Returning the instance beats constructing a second
   * one in `buildProductionOrchestrator`.
   */
  tuning: TuningStore;
  marketData: MarketDataService;
  /**
   * The OUTSIDE BENCHMARKS' series reader (#981) — a separate port from
   * `marketData` on purpose, because `marketData` is universe-derived and
   * refuses `'SPY'` outright once the universe is LSE-only (#734/#751). See
   * its construction below for the full argument. Exposed here so
   * `buildProductionOrchestrator` binds the instance this function resolved
   * rather than deriving a second one from `marketData` — that derivation was
   * the defect.
   */
  benchmarkSeries: BenchmarkSeriesSource;
  broker: BrokerAdapter;
  analysts: AnalystOrchestrator;
  circuitBreakers: CircuitBreakers;
  /**
   * The `onTradeClose`-hooked store (#237) — every consumer below
   * (`getOpenPositions`, Verdict's `positionStore`, Execution's `store`)
   * shares this one instance rather than each getting its own decorated
   * copy, so a future scheduled `ingestFills()` call reaching this same
   * field also reaches the hook. Typed as the `SharedStore` port, not the
   * concrete `SqliteExecutionStore`, because `withOnTradeClose` returns a
   * wrapper, not the class itself.
   */
  executionStore: ExecutionSharedStore;
  /**
   * Execution's dependency set, exposed so the fill-sync loop can bind
   * `reconcile()`/`ingestFills()` from the same object the tick step uses.
   */
  executionDeps: ExecutionStepDeps;
  /**
   * Falsifier arm 2's wiring (#753) — the control arm's tick hook (already
   * bound onto `steps.controlArm`) and its own fill-sync/reconcile surfaces.
   *
   * Exposed for the reason `executionDeps` is: the control arm's fill poller
   * runs on its own cadence from `buildProductionOrchestrator`, not from a tick
   * step, so the surfaces have to travel out of here rather than be rebuilt
   * against a second dependency set. Without a poller the control's lots stop
   * at `submitted`, no `ClosedTrade` is ever written, and the comparison report
   * reads "the control arm made no trades" — indistinguishable from a control
   * that found no setups.
   */
  controlArmWiring: ControlArmWiring;
  /**
   * The LLM budget every debate in this process is admitted against and
   * metered through (#388) — the instance inside `steps.debate`, not a copy.
   *
   * Exposed so a caller can assert the limiter actually saw the run's calls,
   * which is the only way to catch this component reverting to having no
   * caller: that defect is invisible to a unit suite by construction.
   *
   * Note `yarn smoke` does NOT read this field — `startFromEnvironment`
   * returns a `ProductionOrchestrator`, which has no such member, so the smoke
   * run injects its own limiter through `ProductionConfig.llmRateLimiter` and
   * holds that reference. The injection seam is the load-bearing one; this
   * field is the equivalent for a caller that went through
   * `buildProductionComponents` directly (rate-limit-wiring.test.ts).
   */
  llmRateLimiter: RateLimiter;
  /**
   * The GDELT macro archiver (#556), or undefined when this run has no MI
   * archive to write into.
   *
   * Exposed for the same reason `llmRateLimiter` is: it is polled from
   * `buildProductionOrchestrator`'s own timer rather than from a tick step, so
   * without this field the composition root would have to build a SECOND
   * instance — two agents polling one archive on two timers, doubling the
   * download for one set of rows.
   */
  gdeltIngestAgent: GdeltIngestAgent | undefined;
  /**
   * The Polymarket macro/event ingester (#504) — the second writer of the
   * `news` bucket, beside `MiIngestAgent`.
   *
   * Never `undefined`, unlike `gdeltIngestAgent`: that one needs an archive to
   * write into, while this one's product is a store write and the archive is
   * optional provenance. There is no credential to check either — Polymarket's
   * read APIs are keyless — so there is no run in which this should not exist.
   *
   * Exposed for `gdeltIngestAgent`'s reason: it is polled from
   * `buildProductionOrchestrator`'s own timer rather than from a tick step, so
   * without this field the composition root would have to build a SECOND
   * instance, and two agents on two timers would double the vendor traffic and
   * each hold half the bucket state.
   */
  polymarketAgent: PolymarketAgent;
  /**
   * The market-intelligence coverage monitor (#752) — the instance
   * `steps.analysts` reads and writes every tick. Exposed for the reason
   * `llmRateLimiter` is: a caller (or a test) can read `.degraded` and
   * `.missingInstruments` directly, which is the only way to catch this
   * mechanism reverting to a counter nothing reads — this repo's dominant
   * defect class.
   */
  marketIntelligenceCoverage: MiCoverageMonitor;
  /**
   * The MI store the ingestion agents write and the analysts read (#504).
   * Exposed so a caller — the offline smoke gate, specifically — can read back
   * what actually reached the bucket `fundamental` queries, rather than
   * inferring it from an archive row that only proves a fetch happened.
   */
  marketIntelligence: MarketIntelligenceStore;
}

/**
 * Builds the six `TickSteps` from real stage implementations — four direct
 * binds (#234) and two adapter binds (#235) — plus the shared instances they
 * close over. Exported so the composition-root seam the spec names ("assert
 * the returned `TickSteps` callables produce the same call shape") is
 * testable without starting a loop.
 *
 * Built once and shared deliberately: `AlpacaBrokerAdapter` keeps
 * `client_order_id -> bracket parent id` in memory, so a second adapter
 * instance over the same account would silently lose bracket-leg lookups for
 * orders the first one placed.
 */
/**
 * Whether LLM prompt/response text is persisted to `llm_call_log` (#1035).
 *
 * DEFAULT ON, and the asymmetry with `SAMURAI_ALERTS` — which deliberately has
 * no default at all — is the point rather than an inconsistency. An unset
 * `SAMURAI_ALERTS` would silently route operator alerts to an EXTERNAL
 * channel, so it must be named out loud; this writes to a local SQLite table
 * at a measured ~7 MB per 14-day soak. The cost of defaulting wrong is a few
 * megabytes of disk. The cost of defaulting OFF is that the soak this exists
 * to diagnose runs without it, and nobody finds out until they need the data
 * and it was never recorded.
 *
 * Exported so the default is pinned by a test rather than inferred from a
 * `!== 'off'` buried in a long composition root — this repo's characteristic
 * defect is a mechanism that is built, tested, and then reached by nothing on
 * the shipped path.
 */
export function captureLlmTextFromEnvironment(
  value: string | undefined = process.env.SAMURAI_LLM_CAPTURE,
): boolean {
  return value?.trim().toLowerCase() !== 'off';
}

/** The variable that overrides `llm_call_log`'s row ceiling (#1045). */
export const ENV_LLM_CALL_LOG_MAX_ROWS = 'SAMURAI_LLM_CALL_LOG_MAX_ROWS';

/** The variable that overrides the MI archive's retention window (#1060). */
export const ENV_MI_ARCHIVE_RETENTION_DAYS = 'SAMURAI_MI_ARCHIVE_RETENTION_DAYS';

/** The variable that overrides how many X posts a sentiment call fetches (#969). */
export const ENV_X_MAX_SEARCH_RESULTS = 'SAMURAI_X_MAX_RESULTS';

/**
 * How many `llm_call_log` rows to keep (#1045).
 *
 * `min = 1`, not `0` — the one place this deliberately departs from the file
 * sink's identical-looking setting, where `0` legally means "keep nothing".
 * Here "keep nothing" is already spelled `SAMURAI_LLM_CAPTURE=off`, and a
 * ceiling of zero would mean writing every prompt to disk purely to delete it
 * on the next sweep. Two spellings for one intention is how a config comes to
 * disagree with itself, so this one refuses.
 *
 * Exported and tested for the same reason `captureLlmTextFromEnvironment` is:
 * a retention policy read inline in a 3,000-line composition root is a policy
 * nobody can see.
 */
export function llmCallLogMaxRowsFromEnvironment(
  value: string | undefined = process.env[ENV_LLM_CALL_LOG_MAX_ROWS],
): number {
  return positiveIntegerFromEnv(
    value,
    ENV_LLM_CALL_LOG_MAX_ROWS,
    DEFAULT_MAX_LLM_CALL_ROWS,
    1,
    "the captured LLM prompt/response table's row ceiling (#1045)",
  );
}

/**
 * Prunes, reports what it removed, and never throws.
 *
 * Silence would be wrong in both directions, so both are logged: a sweep that
 * dropped thousands of prompts is something an operator should be able to find
 * afterwards when the rows they wanted are gone, and a sweep that keeps
 * failing is a table growing without a ceiling while everything else looks
 * healthy. Only a prune that did nothing — the ordinary case, every day below
 * the ceiling — stays quiet.
 *
 * Swallowing is deliberate and matches how the capture itself behaves
 * (`spend-sink.ts`: bookkeeping must never fail the thing it books). At boot a
 * throw would abort a trading process over housekeeping; on the timer it would
 * take down the daily feedback cycle. Neither trade is worth making for disk.
 */
function pruneLlmCallLogWithLog(
  db: SqliteHandle,
  maxRows: number,
  logger: Logger,
  trigger: 'startup' | 'daily',
): void {
  try {
    // Declared as a `debate-engine` write, not an `orchestrator` one (#1048):
    // `llm_call_log` is owned by the debate engine, which is the only writer of
    // records into it. This sweep is housekeeping on that table rather than a
    // second writer of records, but it is still a DML statement against it, so
    // it goes through the guard under the owning stage instead of slipping past
    // on a raw handle. Passing 'orchestrator' here would trip the guard, which
    // is the correct answer to the question "may the orchestrator write rows to
    // the debate engine's table?" — it may not.
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
      level: 'warn',
      message:
        'llm_call_log prune failed — captured prompts and responses are unaffected, but the ' +
        'table is not bounded until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error), trigger },
    });
  }
}

/**
 * How many days of MI archive history to keep (#1060).
 *
 * The specced rule here is a DAY WINDOW, not a row ceiling — the opposite of
 * `llmCallLogMaxRowsFromEnvironment` above, and deliberately so: LLM capture
 * volume is cadence-bound (a 15-minute-debate measurement does not hold at a
 * different cadence), whereas the archive's value genuinely is time-bound — a
 * 90-day-old news item is not useful to a backtest replay of last week. The
 * six spec statements this settles are reconciled in
 * `docs/specs/market-intelligence-spec.md`.
 *
 * `min = 1`, matching `llmCallLogMaxRowsFromEnvironment`'s reasoning: there is
 * no "keep nothing" spelling to protect here (unlike `SAMURAI_LLM_CAPTURE`),
 * but a zero-day window would purge same-tick writes before `hydrate()` could
 * ever read them back, which is not a retention policy anyone would choose on
 * purpose.
 */
export function miArchiveRetentionDaysFromEnvironment(
  value: string | undefined = process.env[ENV_MI_ARCHIVE_RETENTION_DAYS],
): number {
  return positiveIntegerFromEnv(
    value,
    ENV_MI_ARCHIVE_RETENTION_DAYS,
    DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
    1,
    "the MI archive's specced retention window (#1060)",
  );
}

/**
 * Prunes the MI archive, reports what it removed, and never throws — same
 * posture as `pruneLlmCallLogWithLog` and for the same reason: a throw at
 * boot would abort a trading process over housekeeping, and a throw on the
 * timer would take down the daily feedback cycle.
 *
 * `archive` is optional because `ProductionConfig.miArchive` is: some tests,
 * and any run that deliberately omits the deterministic news path, inject
 * nothing. A missing archive means nothing to prune, not an error.
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
      level: 'warn',
      message:
        'MI archive purge failed — archived rows are unaffected, but the archive is not bounded ' +
        'until this succeeds',
      payload: { error: error instanceof Error ? error.message : String(error), trigger },
    });
  }
}

export function buildProductionComponents(config: ProductionConfig): ProductionComponents {
  const clock = config.clock;

  // Before anything is built, for the same reason the LLM budget below is:
  // refuse a bad config while nothing is half-constructed. This one rejects an
  // `automation_level` that engages the HITL gate — unsound since ADR-0007
  // because the staleness and drift gates run before the approval await and
  // are never re-checked (#434). It was documented at the call site; a comment
  // does not guard a config value someone flips without reading it, and this
  // runs on every production boot rather than on a branch nothing reaches.
  assertAutomationLevelSupported(config.verdictConfig);

  // Same placement, same reason (#691). A non-positive `flatten_before_close_ms`
  // disables flat-by-close entirely and silently — the window never opens, so
  // nothing flattens and `trader_log` reads exactly like a session with nothing
  // to flatten. The Trader carries the same check as a backstop; this is the
  // one that makes it a boot failure rather than something a soak discovers
  // hours in, holding overnight.
  assertTraderConfigSound(config.traderConfig);

  // Third of the same family, and the one that spans two configs (#670). The
  // check above rejects a window of zero; this one rejects a window that is
  // positive but narrower than the tick rate can land inside, which fails in
  // exactly the same way — nothing flattens, nothing is logged, the book carries
  // overnight. The effective interval is resolved here rather than read raw,
  // because an unset `tickIntervalMs` still RUNS at
  // `DEFAULT_TICK_INTERVAL_MS` and exempting it would exempt precisely the
  // callers who never considered the interaction.
  assertFlattenWindowCoversTickInterval(
    config.traderConfig,
    config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
  );

  // Fourth of the same family, and the one ADR-0013 calls a precondition of
  // its own safety rather than a tidiness item (#638). With no human gate left
  // anywhere, the numeric thresholds ARE the stop, so a config edit is the
  // whole distance between this process and an arbitrary risk limit.
  //
  // The breaker half of the clamp runs inside `CircuitBreakers`' constructor
  // below — every construction, not just this one. The kill lines have no
  // constructor to hang it on, so they are refused here, before a store handle
  // is open. Refused, never coerced: a silently clamped kill line reads as
  // accepted, and the operator then believes a limit is in force that is not.
  if (config.feedback !== undefined) {
    assertKillThresholdsWithinBounds(
      config.feedback.config.kill_thresholds,
      'buildProductionComponents',
    );
  }

  // `capitalCeilingUsd` is optional on `ProductionConfig` (paper/backtest
  // boots and the hundreds of tests that never touch live money need not set
  // it) and it is NOT in `REQUIRED_INJECTED_CONFIG` — so a programmatic
  // caller reaching THIS function directly, bypassing
  // `startFromEnvironment`/`liveStartingProfile` (the only in-repo path that
  // refuses to build a live profile without one), could otherwise reach
  // `mode: 'live'` with no ceiling declared at all. `sizingEquity`
  // (production/direct-bind.ts, see its own doc for why an undefined
  // ceiling must stay unclamped) treats that as "none declared" — the
  // correct reading for paper/backtest — so it cannot also be the live-mode
  // gate; the gate belongs here (#569), before anything below is
  // half-built, the same placement `assertAutomationLevelSupported` above
  // uses.
  // Not just `=== undefined` (#569 review): the caller this gate exists for
  // is one assembling `ProductionConfig` by hand, and such a caller can as
  // easily pass `NaN` — from a failed parse of an operator-supplied figure —
  // as omit the field. `sizingEquity` does refuse a non-finite ceiling, so
  // either way the run fails closed; but it refuses at the FIRST SIZING of
  // the first tick, after the store, sockets and wire clients below are all
  // open. Boot is the honest place to say a live config is unusable.
  // POSITIVE and finite, not merely finite (#569 review, second pass): a
  // ceiling of `0` is finite, and `sizingEquity`'s `Math.min` would then
  // clamp every size in the run to zero — a live orchestrator that boots,
  // debates, bills for LLM calls and can never place a trade. A negative one
  // is worse: it survives to `decide`'s arithmetic as a negative size. Both
  // are configuration mistakes with no legitimate reading, and this gate
  // exists for exactly the hand-assembled config that can make them.
  //
  // `assertLiveCapitalCeilingUsd` (live-profile.ts) already refuses these on
  // the SAMURAI_LIVE_MAX_CAPITAL_USD path; this is the same rule for the
  // callers that never pass through it.
  const ceiling = config.capitalCeilingUsd;
  if (config.mode === 'live' && !(Number.isFinite(ceiling) && (ceiling as number) > 0)) {
    throw new Error(
      'Orchestrator cannot start: mode "live" requires ProductionConfig.capitalCeilingUsd to be ' +
        `a finite number greater than zero, and it is ${String(ceiling)}. It is the ceiling ` +
        'every position size in a live run is derived from (sizingEquity, ' +
        'production/direct-bind.ts) — build the config through liveStartingProfile() rather ' +
        'than assembling ProductionConfig by hand, or set the field explicitly. Refusing to ' +
        'size a live run off unclamped equity, and refusing to start one that could only ever ' +
        'size to zero.',
    );
  }

  const universe = config.universe ?? SMOKE_TEST_UNIVERSE;

  // Sixth of the same boot-time-refusal family (#989, follow-up to #987's
  // review of PR #988) — full mechanism (why a calendar mismatch, not
  // `mode`, is the real hazard; why the two writers can collide on one
  // `bars` row; why this is deferred rather than a schema fix) is documented
  // on `benchmarkMarketDataStore`'s doc comment below, not repeated here.
  //
  // Checks the RESOLVED calendar, fail-CLOSED: anything other than an exact
  // `UsEquityRegularHoursCalendar` match is treated as a potential mismatch
  // against `buildBenchmarkDataSource`'s fixed US-normalized port, rather
  // than enumerating `LseRegularHoursCalendar` as the one bad case (#989
  // review — a positive enumeration silently admits a future third calendar
  // class). `.constructor !==`, not `!(x instanceof ...)` (#989 review):
  // `instanceof` also matches a SUBCLASS of `UsEquityRegularHoursCalendar`
  // (this codebase already has one, `NeverTradingCalendar` in
  // trading-calendar.test.ts) that could override session normalization —
  // exact constructor identity is the only check that cannot be quietly
  // satisfied by a variant that behaves differently from the benchmark
  // port's own fixed calendar. Case-insensitive on the instrument symbol
  // since `ProductionConfig.universe` is caller-assembled and untyped on
  // case.
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

  // FIRST, ahead of every store, socket and wire client below (PR #390
  // review). The LLM budget is constructed here rather than beside the debate
  // step it feeds because `RateLimiter`'s constructor VALIDATES its config, and
  // a malformed budget should be refused before this function has opened a
  // SQLite handle or built an Alpaca client — a throw from the middle of the
  // wiring would leave a half-built root behind. Same placement reasoning as
  // #376 moving seeding ahead of the tick loops so a rejected `start()` cannot
  // leave live timers running.
  //
  // One instance for the process, shared by every instrument's debate: a
  // limiter per debate or per instrument would count each window separately and
  // enforce nothing across the universe — the shape the incidental
  // `maxConcurrentInstruments: 1` throttle already had.
  //
  // It takes THIS root's `clock`, which is what advances its fixed window.
  // `startFromEnvironment` supplies `SystemClock`, so a live or paper process
  // rolls the window on real time. A caller that injects a FROZEN clock (the
  // offline smoke run does) gets one window for the whole run and must keep its
  // debate count under `maxDebates` — true today at 3 ticks against 20, and the
  // reason that gate asserts on the limiter rather than ignoring it.
  const llmRateLimiter =
    config.llmRateLimiter ??
    new RateLimiter(clock, config.rateLimiterConfig ?? DEFAULT_LLM_RATE_LIMIT_CONFIG);

  // `tradingCalendar` is computed above, ahead of the precutover collision
  // guard, which needs its RESOLVED value rather than re-deriving `mode`
  // itself (#989 review). Reused here rather than recomputed.
  /**
   * ONE calendar pair, shared by every consumer that needs to know when a
   * venue is open — the daily-PnL boundary (#331/#332) and the volatility
   * reading (#386). Built once rather than per call site: two literals would
   * be two `AlwaysOpenCalendar` instances and, worse, two places for a future
   * override to be applied to only one of them, which is exactly the silent
   * disagreement `TradingCalendar`'s doc comment exists to prevent.
   */
  const sessionCalendars: Record<AssetClass, TradingCalendar> = {
    crypto: new AlwaysOpenCalendar(),
    stocks: tradingCalendar,
  };

  // One broker wire client for the whole root: the order adapter and the
  // account-state provider both talk to Alpaca's Trading API, and two clients
  // would mean two token budgets against one account's shared rate limit.
  const brokerClient =
    config.alpacaBrokerClient ??
    buildDefaultAlpacaBrokerClient(config.mode, config.logger ?? new JsonLogger());

  // Outbound pacing per venue, from ops config rather than a literal here
  // (#299). Hoisted above the market-data wiring by #391: ONE Alpaca bucket
  // for the whole root, shared by the broker adapter and the market-data
  // client, because the 200 req/min limit is per ACCOUNT and two buckets would
  // be two budgets against one limit. The broker takes `acquire()`; market
  // data takes `acquireBackground()` and leaves `reserveForPriority` tokens
  // it may not spend, so a bar sweep cannot park an order behind the refill.
  const venuePacing = config.venuePacing ?? resolveVenuePacing();
  const alpacaBucket = new TokenBucket(venuePacing.alpaca);

  /**
   * Hoisted above the analysts (#745), which now take a telemetry sink built on
   * it, and above the market-data wiring by #562, which logs a malformed
   * fallback-pacing override through it at boot. It depends on nothing but
   * `config`, so both moves are free — the same reasoning that hoisted
   * `breachAlerts` below.
   */
  const logger = config.logger ?? new JsonLogger();

  /**
   * #562: the live orchestrator's bars now fail over, per leg, instead of
   * every bar the running system reads coming from one vendor with no catch,
   * no second source and no alert.
   *
   * `buildAlpacaDataSource` is unchanged and still builds the PRIMARY — the
   * failover is a wrapper around whatever it returns, which is why a mixed
   * universe's `AssetClassRoutingDataSource` keeps routing exactly as before
   * and only the equities instruments in it acquire a fallback. The
   * `config.dataSource` seam still short-circuits both: a caller that brings
   * its own source (`FixtureDataSource`, a backtest source) has already
   * decided where bars come from, and wrapping it would be this module
   * overriding that decision.
   */
  const dataSource =
    config.dataSource ??
    buildFailoverDataSource({
      primary: buildAlpacaDataSource(config, universe, tradingCalendar, alpacaBucket),
      universe,
      // The primary's own calendar, not a second instance: the fallback's bars
      // are session-normalized against it so a failover cannot change what a
      // `lookback` means at the store.
      calendar: tradingCalendar,
      equitiesFallbackBarFetcher: config.equitiesFallbackBarFetcher,
      // Passed through UNRESOLVED (#822/#825) — no `?? resolveFallbackPacing(...)`
      // here. Resolving it at this call site, even sourced from config, would
      // still run on every boot regardless of whether the default Polygon
      // branch is the one selected, which is the exact defect #825 found.
      // `buildFailoverDataSource` resolves it itself, gated on
      // `equitiesFallbackBarFetcher` being undefined.
      fallbackPacing: config.fallbackPacing,
      alertChannel: config.dataFailoverAlerts ?? new LoggingDataFailoverAlertChannel(logger),
      logger,
      now: () => clock.now(),
    });
  // `MarketDataServiceImpl`'s mode is live-vs-backtest only; `paper` reads
  // the same live feed `live` does — paper differs at the broker, not at
  // the data source.
  const marketDataMode = config.mode === 'backtest' ? 'backtest' : 'live';
  /**
   * The PIPELINE's own store instance — NOT shared with the benchmark
   * service below, which gets its own (`benchmarkMarketDataStore`). See that
   * instance's doc for why the two writers' shared key space is safe.
   */
  const marketDataStore = new SqliteMarketDataStore(guardedStore(config.db, 'market-data'));
  const marketData: MarketDataService = new MarketDataServiceImpl(
    dataSource,
    clock,
    marketDataMode,
    marketDataStore,
  );

  /**
   * The benchmark path's OWN store instance — deliberately not
   * `marketDataStore` above, mirroring the data-SOURCE independence #986
   * already established for this same pair of services.
   *
   * It is still the same `bars` table, over the same `config.db`, with the
   * same `(instrument, timeframe, open_time)` primary key and no
   * calendar/source discriminator column — `SqliteMarketDataStore` has no
   * table-name option to give the two instances separate storage, so this
   * does not add row-level isolation by itself. What makes the shared key
   * space SAFE is `instrument`, which is part of that PK: `marketData` above
   * can never write a `'SPY'` or `'AGG'` row once the universe is LSE-only
   * (#751) — `LseMarkDataSource#assertTradeable` (lse-mark-source.ts) throws
   * `NonTradeableInstrumentError` for both, since neither is a pool
   * `lse_ticker`, before any bar reaches this store — and this benchmark
   * path is the ONLY writer of `'SPY'`/`'AGG'` rows by construction
   * (`buildBenchmarkDataSource` is a fixed two-symbol port, never the
   * universe). So post-cutover the two writers are provably disjoint on the
   * one column a collision would need to share.
   *
   * The residual gap is PRE-cutover: a universe that still trades `'SPY'`
   * directly (the pre-#751 default) sends the LIVE path's own
   * `AlpacaDataSource` through whatever `equityCalendarFor(config)` resolves
   * — `LseRegularHoursCalendar` by default in live mode, but
   * `config.tradingCalendar` can pin it there in ANY mode (`equityCalendarFor`'s
   * own doc) — so `marketData` and this benchmark path could both write
   * `'SPY'`/`(timeframe, open_time)` rows, normalized against two DIFFERENT
   * calendars (see `buildBenchmarkDataSource`'s doc for how far those two
   * tables actually diverge). That collision is not new here and not
   * introduced by #987: it exists on `main` today, is orthogonal to the
   * cutover this ticket is ahead of, and this system has not gone live
   * (ADR-0004 §5) — so a schema change (a discriminator column, needing a
   * migration) is deferred as disproportionate to a risk with no live
   * exposure yet. **Closed in code by #989**: `buildProductionComponents`
   * refuses to boot when the RESOLVED `tradingCalendar` is anything other
   * than `UsEquityRegularHoursCalendar` (fail-closed, not an enumerated
   * `LseRegularHoursCalendar` check — #989 review) and `'SPY'`/`'AGG'` (or
   * any other `BENCHMARK_INSTRUMENTS` member) is still directly in the
   * universe. The guard sits above, before the LLM budget is constructed,
   * and keys on the resolved calendar rather than `mode` — a `mode`-only
   * check both misses a `paper`-mode run with an LSE calendar override and
   * wrongly refuses a `live`-mode run with a US calendar override. A
   * comment alone was judged insufficient for live-money infrastructure.
   * Reopen once #751 lands (the guard's structural condition disappears) or
   * before this collision condition can be reached any other way.
   */
  const benchmarkMarketDataStore = new SqliteMarketDataStore(
    guardedStore(config.db, 'market-data'),
  );
  /**
   * The OUTSIDE BENCHMARKS' own market-data path (#981, under #636) —
   * deliberately NOT `marketData` above.
   *
   * `marketData` is universe-derived: `buildAlpacaDataSource` returns
   * `LseMarkDataSource` EXCLUSIVELY once the configured universe holds LSE
   * tickers (#751's cutover), and that source refuses `'SPY'` on purpose —
   * SPY is a `screening_instrument`, the US underlying a 3x LSE ETP tracks,
   * and marking the wrapper off the underlying is inadmissible (#734). Reading
   * the benchmarks through it would therefore park BOTH benchmarks (60/40 has
   * a SPY leg too) in `unmeasured` forever on the day the live universe
   * becomes LSE-only, with the panel reading "Absent, not zero" and nothing
   * failing. #636 requires the outside benchmark to keep being computed on
   * FL's own cadence regardless of what the live universe trades, so the
   * series come from a source with no universe in its construction at all —
   * see `buildBenchmarkDataSource`.
   *
   * `config.dataSource` is not consulted here for the same reason: it is the
   * override for the LIVE path's source, and honouring it would re-couple the
   * benchmarks to the universe through the back door. Tests and offline roots
   * replace the whole port via `config.benchmarkSeriesSource` instead.
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

  // `MarketIntelligenceStore` starts empty and, as of #464, has a writer: the
  // Grok agent below ingests into THIS instance. Constructed here rather than
  // inline so the agent and the analysts cannot end up holding two different
  // stores — the same reasoning as `setupStore` below, and the same defect
  // (#432) that would otherwise recur.
  const marketIntelligence = new MarketIntelligenceStore(clock);

  // #752: one monitor for the whole process, restart-clean in memory like
  // `consecutiveSkips` (analysts-adapter.ts). Exposed on `ProductionComponents`
  // so a caller can assert the degraded-coverage flag actually moves — the
  // same reasoning `llmRateLimiter` documents for why it is a field here
  // rather than a local this function throws away.
  const miCoverageMonitor = new MiCoverageMonitor();

  const analysts = new AnalystOrchestrator({
    market_intelligence: marketIntelligence,
    market_data: marketData,
    /**
     * #746: reuses the SAME `sessionCalendars` pair the flatten rule resolved
     * above rather than deriving a second one — see
     * `AnalystOrchestratorDeps.sessionCalendars`'s doc comment for why a
     * second derivation is the dangerous move (#696 found exactly that class
     * of bug once already). `production.test.ts` asserts this is the real
     * pair, not the orchestrator's `AlwaysOpenCalendar` default.
     */
    sessionCalendars,
    /**
     * #745: `technical_indicator_unavailable{kind}`. Wired here, unconditionally
     * and with no config switch — an unwired counter is indistinguishable from
     * an instrument whose axes are all available, which is the exact reading an
     * operator must not be given. `production.test.ts` asserts this line exists
     * by driving a thin instrument through the composed step and reading the
     * log, rather than by inspecting the field.
     */
    telemetry: new LoggingAnalystTelemetry(logger),
  });

  // One instance, both ends of `cosine_setups` (#432): the Trader's `decide`
  // WRITES the setup at decision time and `onTradeClose` LABELS it with the
  // realized R on close. Constructed here rather than inline below so the two
  // halves cannot drift into separate stores.
  const setupStore = new SqliteSetupStore(guardedStore(config.db, 'trader'));

  /**
   * Hoisted above the tick steps (#433). It used to be constructed down in
   * `feedbackStores`, which was fine while the Feedback Loop was its only
   * consumer — but the Risk Manager now READS `risk_thresholds` at evaluate
   * time, and a threshold `autoTighten` writes has to be the same row Risk
   * reads. One instance, both ends of the dial.
   */
  const tuningStore = new SqliteTuningStore(guardedStore(config.db, 'feedback-loop'), clock);

  /**
   * Hoisted above `spendCap` (below) rather than left beside the Feedback
   * Loop's stores: the LLM spend cap escalates its breach through this same
   * channel, and a breach that only reaches the log stream is invisible on an
   * unattended run. It depends on nothing but `logger`, so the move is free.
   */
  const breachAlerts = config.breachAlerts ?? new LoggingBreachAlertChannel(logger);

  /** #971. Resolved beside `breachAlerts`, and never merged with it — see its slot's doc. */
  const armDivergenceAlerts =
    config.armDivergenceAlerts ?? new LoggingArmDivergenceAlertChannel(logger);

  /**
   * The hard dollar ceiling (ADR-0008). Distinct from `llmRateLimiter`, which
   * bounds CALLS PER WINDOW and refills with time: this bounds TOTAL DOLLARS
   * and never refills. A run can be comfortably inside its rate limit and
   * still spend a fortnight's budget in three days, which is exactly what the
   * cadence-only plan risked.
   *
   * Absent means uncapped, and that is warned about rather than defaulted
   * silently — the same posture `SAMURAI_ALERTS` takes. An unattended run
   * (#238) with no ceiling is the case this exists for, so if it is ever
   * missing there, the log says so in as many words.
   */
  let spendCap: SpendCap;
  if (config.llmBudgetUsd === undefined) {
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      level: 'warn',
      message:
        'ProductionConfig.llmBudgetUsd is not set — LLM spend is UNCAPPED. Nothing will ' +
        'stop this process billing without bound; the rate limiter bounds calls per ' +
        'window, not total dollars, and it refills. Correct for a short attended run; an ' +
        'unattended soak (#238) must set a budget.',
      payload: { llm_budget_usd: null },
    });
    spendCap = UNCAPPED_SPEND;
  } else {
    const cap = new SqliteSpendCap(
      guardedStore(config.db, 'debate-engine'),
      config.llmBudgetUsd,
      logger,
      () =>
        breachAlerts.postBreachAlert({
          breaches: ['llm_spend_cap'],
          reported_at: clock.now(),
        }),
    );
    spendCap = cap;

    /**
     * Announce what this database has ALREADY spent, because the cap's window
     * is the whole `llm_spend` table and the operator's mental model is "$50
     * for this run".
     *
     * The whole-table window is the right choice — a per-process baseline
     * would hand a fresh budget to every restart, and a 14-day soak on a
     * MacBook will restart. But it means prior runs against the same file
     * count, and that is not hypothetical: `data/samurai-development.sqlite`
     * held 196 calls / $0.38 before this cap existed. Silence here would let
     * an operator assume zero and be wrong by however much they had already
     * spent.
     *
     * It lives inside this branch, on `cap` rather than on `spendCap`, so the
     * announcement reaches for `startingTotal()` on the concrete class that
     * offers it — `SpendCap`, the seam the debate step admits against, carries
     * `check()` alone. There is nothing to announce in the uncapped branch:
     * it has already warned, in more detail than a starting total would add.
     */
    const opening = cap.startingTotal();
    logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
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
  // Hooked once, shared everywhere below (see `ProductionComponents.executionStore`'s
  // doc): `getOpenPositions`, Verdict's `positionStore` and Execution's
  // `store` all read/write through this same instance, so `onTradeClose`
  // fires no matter which of them eventually calls `writeClosedTrade`.
  const executionStore = withOnTradeClose(
    new SqliteExecutionStore(guardedStore(config.db, 'execution')),
    { setup_store: setupStore },
    logger,
  );
  // `resolveVenuePacing` starts from `DEFAULT_VENUE_PACING` — which carries
  // each value's provenance and, where the venue publishes one, a documented
  // ceiling it refuses to let an override exceed — and applies any
  // `SAMURAI_PACING_ALPACA_*` the deployment set. A rate limit is a property
  // of the account, so it belongs beside the credentials, not in the code.
  // The bucket itself is built once, above the market-data wiring (#391).
  const broker =
    config.broker ??
    new AlpacaBrokerAdapter({
      client: brokerClient,
      rateLimiter: alpacaBucket,
      // #287: without a durable bracket index the adapter starts every run
      // blind, and `fetchNewFills` polls nothing for lots that were already
      // filling when the process died. The in-memory default is only ever
      // right for a test.
      state: new SqliteBrokerStateStore(guardedStore(config.db, 'execution')),
      // #298: the same store carries the age-out clock for a fill the venue
      // will not price, which is why it must be the durable one here — a
      // restart that reset the clock would age nothing out across a soak.
      unpricedFillAlerts: config.unpricedFillAlerts ?? new LoggingUnpricedFillAlertChannel(logger),
      // #586: the emulated crypto OCO's accepted-risk escalation — required
      // on `AlpacaBrokerAdapterInput` for the same "no silent default"
      // reason `unpricedFillAlerts` is.
      ocoDoubleFillAlerts:
        config.ocoDoubleFillAlerts ?? new LoggingOcoDoubleFillAlertChannel(logger),
      // #609: `AlpacaBrokerAdapterInput.logger`, required for the same reason
      // `ExecutionInput.logger` is (#573) — a dropped wiring here is now a
      // `tsc` error at every composition root instead of a silent gap a soak
      // would have to surface. This is the same `logger` already built above
      // for the rest of this composition root, not a second instance.
      logger,
      ...(config.unpricedFillAgeOutMs === undefined
        ? {}
        : { unpricedFillAgeOutMs: config.unpricedFillAgeOutMs }),
      clock,
    });
  // The sticky breakers' durable home (#203, review 2026-08-06 B1): loaded
  // here so a trip survives restart, written by every breaker evaluation on
  // the tick path (direct-bind.ts `computeCurrentPortfolioAndBreakers`).
  const breakerStateStore = new SqliteBreakerStateStore(guardedStore(config.db, 'risk'));
  const circuitBreakers = new CircuitBreakers(
    config.breakerConfig,
    config.initialBreakerState ?? breakerStateStore.load(),
  );
  // Parked by default (ADR-0002): the live WorldMonitor feed costs money per
  // call and the geopolitical tier is not what the first paper run tests.
  // `null` is already a documented answer on this port.
  const ciiConsumer = new CiiConsumer(
    config.ciiScoreProvider ?? new ParkedCiiScoreProvider(),
    clock,
    config.ciiConsumerConfig,
  );

  // Shared by the trader/risk/verdict binds: all three derive the current
  // portfolio + breaker state from the same sources, fetched fresh at their
  // own call time (#234).
  const breakerStateDeps = {
    marketData,
    circuitBreakers,
    // #640: the valuation-freshness bound, read from the RISK config rather
    // than the verdict one. The two bounds are deliberately separate fields
    // (see `RiskConfig.max_mark_age`): declining one trade on a stale tick and
    // refusing to value the entire book are different-weight actions.
    maxMarkAge: config.riskConfig.max_mark_age,
    breakerState: breakerStateStore,
    // One portfolio observation per tick, shared by the trader/risk binds (B4).
    portfolioSnapshots: new Map<string, PortfolioSnapshot>(),
    // #841: BOTH the risk and verdict binds degrade an exit's valuation
    // rather than suppress the flatten, and both must be able to say so.
    // Spread here rather than onto each bind separately for exactly that
    // reason — a channel wired into one seam only would leave the other
    // silent. Conditional spread under `exactOptionalPropertyTypes`.
    ...(config.exitValuationAlerts === undefined
      ? {}
      : { exitValuationAlerts: config.exitValuationAlerts }),
    // The `error`-level line both seams write before reaching the channel
    // above, and #726's sink for a failed `riskLog.write`.
    logger,
    // Defaulted, not required (#276): the three sources this needs — Alpaca's
    // account ledger, the durable `account_state` table, and the existing
    // ClosedTrade store — all exist in-repo now, so an injected seam would be
    // asking the caller to build what this module can compose.
    accountState:
      config.accountState ??
      new AlpacaAccountStateProvider({
        client: brokerClient,
        store: new SqliteAccountStateStore(guardedStore(config.db, 'orchestrator')),
        // Per-class session-open equity snapshots (#332) — the local
        // replacement for Alpaca's blended `last_equity` (GAP-8).
        sessionEquity: new SqliteSessionEquityStore(guardedStore(config.db, 'orchestrator')),
        // The append-only daily equity series (#345). Wired unconditionally,
        // and on the same boundary as the snapshot above, because a return
        // series cannot be backfilled: equity not sampled on the day is gone.
        // Capture starts from the first tick of the first run; whether it is
        // ever EVALUATED is a separate, gated decision that lives in
        // `SqliteDailyEquityMetricsSource`.
        dailyEquity: new SqliteDailyEquityStore(guardedStore(config.db, 'orchestrator')),
        // The existing ClosedTrade reader, per spec story 25 — no new
        // realized-PnL ledger is built when one already exists.
        closedTrades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop')),
        // Two calendars: crypto resets at 00:00 UTC, stocks at the prior 16:00
        // ET close. `tradingCalendar` is the equity one (it gates market-hours
        // scheduling), so only it is overridable here — a crypto session has no
        // holidays or half-days for a config to express.
        //
        // SHARING `tradingCalendar` WITH THE SCHEDULER IS DELIBERATE, not an
        // oversight, and it is why this is typed `TradingCalendar` rather than
        // narrowed to `UsEquityRegularHoursCalendar`. #331 put `sessionStart` on
        // the port precisely so the accounting boundary and the session gating
        // move together: "the boundary lives on the calendar rather than being
        // duplicated in each consumer" (trading-calendar.ts). The default models
        // NYSE holidays as of #696, so it no longer reports a session start for
        // a holiday Monday that never traded — and that fix reached the daily-PnL
        // boundary without touching this file, which is the whole point of the
        // arrangement. The authoritative session table (#684, Alpaca's
        // `GET /v2/calendar`) is injected HERE, through this same field, when it
        // lands. Narrowing the type would pin this consumer to the built-in
        // implementation and guarantee the two silently disagree on every
        // holiday — the divergence the port exists to prevent.
        //
        // The cost is that an override is authoritative for BOTH. That is the
        // contract: `sessionStart` is a required member, so a substitute cannot
        // omit it by accident, and any calendar answering it is by definition
        // asserting when this account's stock sessions begin.
        calendars: sessionCalendars,
        mode: config.mode,
        // Composition happens at startup, so "now" here IS the process start.
        // It decides whether a session boundary was crossed under a running
        // process (a real open) or had already passed when this one came up
        // (a mid-session base) — #332's two cold-start cases.
        startedAt: config.clock.now(),
        logger: config.logger ?? new JsonLogger(),
      }),
    // #277's provider, wired by default now that AccountStateProvider (#276)
    // exists — the only reason direct-bind.ts left it a required seam.
    volatility:
      config.volatility ??
      new MarketDataVolatilityReadingProvider({
        marketData,
        universe,
        volatility_indicator: config.volatilityIndicator ?? DEFAULT_VOLATILITY_INDICATOR,
        // Literally the same objects the scheduler gates its tick plan on and
        // the daily-PnL boundary resets on, for the same reason (#386): a
        // second session opinion here would arm `volatility_halt:stocks`
        // overnight for a class the tick plan had already excluded.
        calendars: sessionCalendars,
        logger: config.logger ?? new JsonLogger(),
      }),
    getOpenPositions: () => executionStore.getOpenPositions(),
    mode: config.mode,
  };

  // Hoisted, not inlined into `buildExecutionStep`: the fill-sync loop binds
  // `reconcile()`/`ingestFills()` from this same object, so Execution cannot
  // gain a dependency on the tick path and silently miss it on the poll path.
  const executionDeps: ExecutionStepDeps = {
    clock,
    broker,
    store: executionStore,
    costModel: new CostModelImpl(config.costConfig),
    marketData,
    config: config.executionConfig,
    mode: config.mode,
    // #525: the fallback alert for a residual `ingestFills()` failed to
    // re-arm after a partial flatten. Required on `ExecutionInput`, for the
    // same "no silent default" reason `unpricedFillAlerts` above is
    // required on `AlpacaBrokerAdapterInput` (#298) — an omitted channel is
    // the #322 bug re-created for a fifth escalation.
    residualExposureAlerts:
      config.residualExposureAlerts ?? new LoggingResidualExposureAlertChannel(logger),
    // #527: diagnostic-only for now (see `LoggingFlattenOverfillAlertChannel`'s
    // doc) — no `SAMURAI_ALERTS`/config override yet, unlike the escalations
    // above. A phone-reaching transport is a later ticket if this ever fires.
    flattenOverfillAlerts: new LoggingFlattenOverfillAlertChannel(logger),
    // #519: where `reconcile()`'s flatten sweep escalates a row it could not
    // settle. Required on `ExecutionInput` for the same "no silent default"
    // reason `residualExposureAlerts` above is — an omitted channel would
    // make an unresolved flatten's ambiguity invisible again.
    flattenReconcileAlerts:
      config.flattenReconcileAlerts ?? new LoggingFlattenReconcileAlertChannel(logger),
    // #573: the execution port's own local diagnostic trace — see
    // `ExecutionInput.logger`'s decision doc. Required, so a composition
    // root that forgets it is a `tsc` error rather than a silent gap.
    logger,
  };

  // #464, retargeted at Nous by ADR-0009. The off switch used to be the
  // absence of XAI_API_KEY; under a single provider that no longer works,
  // because the key this agent would use is the same one the debate requires.
  // So the switch is explicit: SAMURAI_SENTIMENT=off. Anything else runs it.
  //
  // Off is an honest state rather than a silent no-op — the analysts keep
  // reporting NO_DATA_MARKER (#463), which says "never had an input" rather
  // than presenting the absence as a neutral read.
  //
  // Metering is what makes this affordable to leave on: the agent records
  // every call into `llm_spend` under `stage: 'market_intelligence'`, so
  // ADR-0008's cap covers this stage too, and it checks that cap BEFORE
  // calling.
  const sentimentEnabled =
    config.sentimentEnabled ?? process.env.SAMURAI_SENTIMENT?.trim().toLowerCase() !== 'off';

  // #1035. Read ONCE here and passed down, so both spend sinks agree and
  // neither reads the environment for itself — the same rule the file sink
  // follows (`buildEntrypointLogger`).
  const captureLlmText = captureLlmTextFromEnvironment();

  /**
   * #1045. The row ceiling is read and APPLIED here, at boot, and again on the
   * daily timer below — two call sites, both at this composition root.
   *
   * Both, not one. Startup alone would fire once and then never again for the
   * length of an unattended run, which is precisely the run the ceiling exists
   * to bound; the daily sweep alone would leave a restart-heavy dev loop
   * pruning nothing until 24h of uptime accumulated. Neither is a hot path:
   * the statement is a no-op below the ceiling and the table has one writer.
   *
   * Wired here rather than inside `SqliteLlmSpendStore` on purpose. The store
   * writes rows; deciding how many the SYSTEM keeps is a deployment policy,
   * and burying it in the writer is how `pruneIngestedObservedFills` came to
   * exist, be tested, and never be called from anything that ships (#313).
   */
  const llmCallLogMaxRows = llmCallLogMaxRowsFromEnvironment();
  pruneLlmCallLogWithLog(config.db, llmCallLogMaxRows, logger, 'startup');

  /**
   * #1060. The specced 90-day MI archive purge, read and applied here at
   * boot and again on the daily timer below — same two-call-site shape as
   * the row ceiling immediately above, and for the same reason: startup
   * alone never fires again during an unattended run, and the daily sweep
   * alone leaves a restart-heavy dev loop pruning nothing.
   *
   * Wired here rather than inside `MiArchiveStore.write` on purpose, for the
   * same reason as above: the store persists rows, deciding how long the
   * SYSTEM keeps them is a deployment policy, and burying it in the writer
   * is exactly how the MI archive's purge went unimplemented in the first
   * place (#1060's own gap) and how `pruneIngestedObservedFills` (#313)
   * shipped uncalled.
   */
  const miArchiveRetentionDays = miArchiveRetentionDaysFromEnvironment();
  pruneMiArchiveWithLog(config.miArchive, miArchiveRetentionDays, clock, logger, 'startup');
  // `tryNousCredentials` rather than `nousCredentials`: an unconfigured Nous
  // environment degrades this optional stage to no-agent instead of failing
  // the boot, which is how the absent `XAI_API_KEY` behaved before ADR-0009
  // and what every test injecting its own `llmClient` relies on. An UNPRICED
  // model still throws from in there — that is a hole in the spend cap, not a
  // configuration gap.
  const sentimentCredentials = sentimentEnabled ? tryNousCredentials('sentiment') : undefined;
  /**
   * ONE `LlmClient` for the whole root. The debate stage and #552's MI scoring
   * pass both bill through it, so there is one spend meter and one config
   * rather than two clients disagreeing about either.
   */
  const llmClient =
    config.llmClient ??
    buildDefaultLlmClient(
      logger,
      new SqliteLlmSpendStore(guardedStore(config.db, 'debate-engine'), logger, captureLlmText),
    );

  /**
   * Whether the sentiment agent RETRIEVES (#969), as opposed to asking a model
   * what it remembers.
   *
   * A separate switch from `sentimentEnabled`, not a widening of it, and
   * DEFAULT OFF. Three reasons, in the order they bite:
   *
   * 1. It changes what the soak measures. `sentiment` has been excluded from
   *    the evidence average while mute (#676); real items put it back in, and
   *    that is the same gate that produced #625's zero-trade result. A run
   *    with this on is a different experiment from #625/#752, and flipping it
   *    by accident would make two soaks silently incomparable.
   * 2. It changes what the run costs. Search results ride in the prompt —
   *    roughly 5,300 input tokens per call at the default result count — so
   *    this is the soak's main LLM cost lever after the debate itself.
   * 3. The metered figure has not yet been reconciled against the provider's
   *    invoice (the plan's V3). Until it has, turning this on is a deliberate,
   *    dated act by an operator, not a default.
   *
   * `SAMURAI_X_MAX_RESULTS` is the dial, and it is read through the SHARED
   * `positiveIntegerFromEnv` (#1045) rather than a validator of its own. That
   * helper's header makes the argument — "two env vars in one system come to
   * disagree about whether `\"abc\"` means abc, the default, or 0" — and a
   * spend dial is the last place to disagree about it. Concretely it means a
   * malformed value **throws at startup naming the variable** instead of
   * silently falling back, which is the right failure for a setting whose
   * whole job is bounding cost: an operator who typed `SAMURAI_X_MAX_RESULTS=ten`
   * meant to change the spend and should not discover days later that nothing
   * changed.
   *
   * The ceiling is enforced separately and does NOT throw. `XSearchClient`
   * clamps to `[1, MAX_SEARCH_RESULTS_CEILING]` and warns, because 100 is a
   * well-formed integer that an operator plausibly meant as "as many as you
   * can" — refusing to boot over it would be worse than capping it and saying
   * so. So: unusable input refuses, excessive input clamps.
   */
  const sentimentRetrieval =
    config.sentimentRetrieval ??
    process.env.SAMURAI_SENTIMENT_RETRIEVAL?.trim().toLowerCase() === 'on';
  const xMaxSearchResults = positiveIntegerFromEnv(
    process.env[ENV_X_MAX_SEARCH_RESULTS],
    ENV_X_MAX_SEARCH_RESULTS,
    DEFAULT_MAX_SEARCH_RESULTS,
    1,
    "the number of X posts each sentiment call retrieves, the soak's main LLM cost lever after " +
      'the debate itself (#969)',
  );

  const grokAgent =
    sentimentCredentials === undefined
      ? undefined
      : new GrokAgent({
          // The ONE construction-time difference between a sentiment stage
          // that fills `social` and one that has never filled it. Everything
          // downstream — the spend gate, the evidence guard, the bucket cache
          // — is identical, which is the property `grok-agent.ts` claimed and
          // this line is the test of.
          client: sentimentRetrieval
            ? new XSearchClient({
                ...sentimentCredentials,
                // The credentials' model is the PINNED `x-ai/grok-4.5`, on
                // which `x_search` 400s ("supported only on OpenRouter-routed
                // models"). The routed alias is not a preference here, it is
                // the only thing that works — see `X_SEARCH_MODEL`.
                model: X_SEARCH_MODEL,
                maxSearchResults: xMaxSearchResults,
                windowMs: GROK_REFRESH_MS,
                logger,
              })
            : new NousSentimentClient({ ...sentimentCredentials, logger }),
          store: marketIntelligence,
          spendCap,
          spendSink: new SqliteLlmSpendStore(
            guardedStore(config.db, 'debate-engine'),
            logger,
            captureLlmText,
          ),
          clock,
          logger,
          // Absent on runs with no archive, which is a working configuration:
          // it costs replay and the post-hoc bot-share check, not correctness.
          archive: config.miArchive,
        });

  if (sentimentRetrieval && sentimentCredentials === undefined) {
    logger.log({
      trace_id: 'boot',
      stage: 'market_intelligence',
      level: 'warn',
      message:
        'SAMURAI_SENTIMENT_RETRIEVAL=on but no sentiment credentials are configured, so no ' +
        'sentiment agent was built at all. `social` will be empty for this run and the ' +
        'analysts will report NO DATA — the retrieval switch is doing nothing.',
    });
  }

  /**
   * The deterministic news path (map #552) — the writer that actually fills
   * `MarketIntelligenceStore`.
   *
   * PREFERRED OVER `grokAgent` when it can be built, and the reason is not
   * preference. `NousSentimentClient` hard-codes `retrievalEvidence: false` and
   * `GrokAgent.refresh` discards every item without evidence, so that path
   * ingests `[]` on every refresh BY CONSTRUCTION — its own spec section says
   * "the expected steady state of this stage is an empty item list". #625 then
   * measured the cost: with `sentiment` and `fundamental` both pinned at
   * confidence 0.05, the stocks conviction ceiling was 0.5478 against a 0.55
   * floor, so a stock could never trade at any RSI.
   *
   * This agent needs the same Nous credentials (for SCORING, not retrieval) and
   * Alpaca keys it already holds for bars, so it is available exactly when the
   * old path was — and when it is not, the fallback is the old agent rather
   * than nothing.
   */
  const miIngestAgent = buildMiIngestAgent({
    archive: config.miArchive,
    hasScoringCredentials: sentimentCredentials !== undefined,
    store: marketIntelligence,
    llmClient,
    clock,
    logger,
    assetClasses: universeAssetClasses(universe),
  });

  /**
   * The GDELT macro layer (#556). Runs whenever an archive exists — no
   * credentials to check, because GDELT is open data, and no LLM either: this
   * half only writes bytes.
   *
   * Independent of `miIngestAgent` on purpose. That path is the ticker layer
   * and its own header records the measured hole it cannot fill — the Benzinga
   * wire returns **zero** items for 3USL/3LDE/SGLN, the LSE ETPs ADR-0016
   * actually trades. Whether Alpaca credentials are present has no bearing on
   * whether the macro layer should run.
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
   * The Polymarket macro/event layer (#504) — the second `news` writer.
   *
   * Built unconditionally: no credentials to check (the read APIs are keyless),
   * no LLM call in the path, and its product is the store write, so unlike the
   * GDELT archiver it is useful even on a run with no MI archive. The archive
   * is passed when one exists, for the raw bytes replay needs.
   *
   * It writes the same `news` bucket `miIngestAgent` does, and that is the
   * point rather than a duplication: the Benzinga wire returns ZERO items for
   * 3USL/3LDE/SGLN, the LSE ETPs ADR-0016 actually trades, and a 3x FTSE ETP
   * has no company news to return. Macro is what moves it. Note plainly what
   * this does NOT do: these items are filed under macro series names, never
   * tickers, so `MiCoverageMonitor` — which matches `entity === instrument` —
   * will still report those three as uncovered. Filing them under tickers
   * would quiet the counter without telling the analysts anything about the
   * ticker.
   */
  const polymarketAgent = new PolymarketAgent({
    client: config.polymarketClient ?? new PolymarketClient(),
    store: marketIntelligence,
    clock,
    logger,
    ...(config.miArchive === undefined ? {} : { archive: config.miArchive }),
  });

  if (grokAgent === undefined) {
    logger.log({
      trace_id: 'startup',
      stage: 'market_intelligence',
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

  // The Trader's two entry points, built together so the tick path's exit
  // check and the decision path's full decision share one dependency set and
  // one diagnostic throttle (#743) — see `buildTraderSteps`.
  const traderStepDeps: TraderStepDeps = {
    ...breakerStateDeps,
    config: config.traderConfig,
    // #668: THE pair built above, not a fresh one. ADR-0014's flat-by-close
    // resolves through the instrument's own venue, so the Trader has to read
    // the same calendars the daily-PnL boundary and the volatility reading
    // do — a second literal here would be a second place for an override to
    // land on only some consumers.
    sessionCalendars,
    // #568: literally the `executionStore` above — the same instance
    // `getOpenPositions` reads and `ingestFills()` writes fills through — so
    // the Trader sizes an exit off the same fill record `executeExit`
    // re-derives it from. Two stores here would mean two answers to "what
    // does this lot still hold", which is the divergence #568 was.
    getExitFillSizes: (idempotency_keys) => executionStore.getExitFillSizes(idempotency_keys),
    setupStore,
    traderLog: new SqliteTraderLogStore(guardedStore(config.db, 'trader')),
    // #511: the declared capital ceiling, spread through rather than read
    // from the environment here — this is the ONE hop that carries it from
    // `liveStartingProfile` to the arithmetic that turns equity into a size.
    // Omitted (not passed as `undefined`) on every paper/backtest run under
    // `exactOptionalPropertyTypes`, which is the pre-#511 behaviour and the
    // same conditional-spread idiom `verdictAlerts` below uses.
    ...(config.capitalCeilingUsd === undefined
      ? {}
      : { capitalCeilingUsd: config.capitalCeilingUsd }),
    // #698: the diagnostic escalation, wired HERE and not only declared.
    // `TraderDiagnosticAlertChannel` would otherwise be the next instance of
    // this repo's dominant defect shape — a tested mechanism nothing calls
    // (#364's store, #388's rate limiter) — and the failure it reports is one
    // whose only other symptom is a book that quietly stops trading.
    //
    // Same conditional-spread idiom as `capitalCeilingUsd` above, required by
    // `exactOptionalPropertyTypes`: omitted rather than passed as `undefined`
    // under `log-only`, where the step's own logger is the whole reporting
    // path.
    ...(config.traderDiagnosticAlerts === undefined
      ? {}
      : { traderDiagnosticAlerts: config.traderDiagnosticAlerts }),
    // The sink for the diagnostics themselves, and for an alert the transport
    // could not deliver. Without it a log-only run would have nowhere to put
    // them at all.
    logger,
  };
  const traderSteps = buildTraderSteps(traderStepDeps);

  const riskStepDeps: RiskStepDeps = {
    ...breakerStateDeps,
    config: config.riskConfig,
    correlationConfig: config.correlationConfig,
    ciiConsumer,
    riskLog: new SqliteRiskLogStore(guardedStore(config.db, 'risk')),
    // #433: the live dial. Without this Risk freezes its RiskConfig at
    // construction and `autoTighten`'s response to a kill-line breach
    // changes no decision.
    thresholds: tuningStore,
    // #766: the live-read clamp trip escalation. Same conditional-spread
    // idiom as `traderDiagnosticAlerts` above, required by
    // `exactOptionalPropertyTypes`: omitted rather than passed as
    // `undefined` under `log-only`, where the catch's own logger is the
    // whole reporting path.
    ...(config.thresholdClampAlerts === undefined
      ? {}
      : { thresholdClampAlerts: config.thresholdClampAlerts }),
    // #726: sink for the catch's own guarded `riskLog.write` failure —
    // without it, a store failure while reporting a gate throw has nowhere
    // to go but silent loss (still fine; see that catch's doc comment) with
    // no trace at all.
    logger,
    // #957: check-pipeline step 7's producer. The SAME `llmClient` the
    // debate bills through, so there is one spend meter and one config —
    // the critic's calls land in `llm_spend` under `stage: 'risk_critic'`
    // and count against ADR-0008's ceiling like every other billed call.
    // `mode` picks the implementation: `backtest` gets a producer holding no
    // LLM client at all, which is what makes "no live call in a replayed
    // path" (ADR-0003 §2) structural rather than a runtime check.
    // `marketData` is where the invalidation conditions the same call emits are
    // MEASURED (#994). Not a new dependency — this is the service the risk step
    // already reads for `computeCorrelationEstimate` and `computePortfolioView`
    // — and required rather than optional so that deleting this line is a
    // compile error rather than a silently permanent `no_conditions`.
    critic: buildRiskCriticProducer({
      mode: config.mode,
      llm: llmClient,
      store: new SqliteRiskCriticStore(guardedStore(config.db, 'risk')),
      spendCap,
      marketData,
      logger,
    }),
  };

  const verdictStepDeps: VerdictStepDeps = {
    ...breakerStateDeps,
    // #465. Absent under `log-only` and in tests, so no verdict alerting;
    // present under `telegram`, filtered to notable verdicts only.
    ...(config.verdictAlerts === undefined ? {} : { verdictAlerts: config.verdictAlerts }),
    tradingCalendar,
    // Verdict's `PositionStore.findByKey` is a strict subset of Execution's
    // `SharedStore`; one store instance serves both rather than opening a
    // second connection with a divergent view of the same table.
    positionStore: executionStore,
    config: config.verdictConfig,
    // Unreachable by design since ADR-0007: `automation_level` is `auto` for
    // both classes, so gate 6 short-circuits and this is never called. It
    // THROWS rather than auto-approving, so that turning the dial back
    // without wiring a transport fails loudly instead of fabricating
    // consent — and, unlike `ConsoleApprovalChannel`, it constructs in
    // `live`, because refusing there would block a live start over a gate
    // that never fires.
    approvals: config.approvals ?? new UnwiredApprovalChannel(),
    // Backs LoggingVerdict's verdict_log write (#302) — the same handle
    // every other Sqlite* store in this function reads/writes through.
    store: config.db,
  };

  /**
   * FALSIFIER ARM 2 (#753) — the mandated matched control, composed here beside
   * the live arm rather than in a script of its own.
   *
   * ADR-0014 amendment 2 and ADR-0017 §Consequences make this benchmark
   * non-optional, and #753's ordering constraint is that it runs *in parallel
   * with the soak from the first day, not retrofitted later* — a control that
   * starts three months after the live arm cannot answer the question over the
   * same tape, and the tape is the only thing the two arms share. Wiring it
   * unconditionally into the one composition root every real run goes through
   * is what makes "from the first soak day" a property of the system rather
   * than of an operator remembering to start something.
   *
   * **No env flag, deliberately.** An opt-in control is a control that is off
   * during the run that mattered. The cost of leaving it on is bounded and
   * known: no LLM call (the arm's whole point), no venue call (a simulated
   * broker), no additional market-data fetch (it decides from the live arm's
   * own views), and one extra pass through the in-process stage code per tick.
   *
   * Three things are per-arm and every one of them is a way a shared instance
   * would corrupt the live arm rather than measure it — see
   * `control-arm-wiring.ts` for the full argument.
   */
  const controlExecutionStore = new SqliteExecutionStore(
    guardedStore(config.db, 'execution'),
    'control',
  );
  const controlBreakerState = new InMemoryBreakerStatePersistence();
  const controlArmWiring = buildControlArmWiring({
    trader: traderStepDeps,
    risk: riskStepDeps,
    verdict: verdictStepDeps,
    execution: executionDeps,
    store: controlExecutionStore,
    // A SIMULATED venue, never the live one. The book is £1,000 and ADR-0018 D5
    // deploys 35%/25% per position; a control arm placing real orders at the
    // same envelope doubles deployment, which no ADR authorises and which would
    // breach the drawdown envelope #925/#932 gate the live ramp on. Its fills
    // are priced through the SAME `CostModel` the live arm's backtesting uses,
    // so the control's returns are cost-inclusive — a zero-cost control would
    // flatter the indicator arm against ADR-0018 D3's round-trip bar and
    // invalidate the comparison this whole ticket exists to produce.
    broker: new SimulatedBrokerAdapter({
      clock,
      costModel: executionDeps.costModel,
      marketData,
      // The SAME simulated-adapter config the live arm's own execution config
      // declares, not a second one: fill modelling that differed between the
      // arms would show up as an edge that is really a fixture difference.
      config: config.executionConfig.simulated,
    }),
    circuitBreakers: new CircuitBreakers(config.breakerConfig, controlBreakerState.load()),
    breakerState: controlBreakerState,
    // The control arm's OWN account scalars, derived from its OWN book.
    //
    // The fourth per-arm thing, and the one that was missing: a shared
    // `AccountStateProvider` reads `GET /v2/account`, which only ever reflects
    // the LIVE arm's trades (the control's venue is simulated). Sharing it made
    // the control's D5 sizing — a fraction of `portfolio.equity` — and its
    // drawdown-halt timing functions of the live arm's realized cash, so the
    // control was not an independent measurement over the same tape. See
    // `control-account-state.ts`.
    accountState: new ControlArmAccountStateProvider({
      // The live arm's equity, observed ONCE at first boot and then persisted
      // first-write-wins — not the declared £1,000.
      //
      // A matched control starts at the same capital as the arm it is matched
      // against. In `paper` mode the live arm sizes against the broker's equity
      // (the £1,000 ceiling gate does not arm without `same_currency_verified`),
      // and `yarn smoke` proved what a declared-£1,000 control costs there:
      // every control intent came back `rounds_to_zero_shares` and the arm took
      // no trade at all. Reading it once is what keeps this an anchor rather
      // than a coupling — see `buildControlBookAnchorResolver`.
      resolveBook: buildControlBookAnchorResolver({
        liveAccountState: breakerStateDeps.accountState,
        store: new SqliteAccountStateStore(
          guardedStore(config.db, 'orchestrator'),
          CONTROL_BOOK_ANCHOR_KEY,
        ),
        // Gated on `same_currency_verified` exactly like the primary live-read
        // clamp below — an unverified ceiling must not cap one path and leave
        // the other uncapped, or #972 fix 3 reopens itself in that one state.
        fallbackBook:
          config.riskConfig.live_book_ceiling?.same_currency_verified === true
            ? config.riskConfig.live_book_ceiling.book
            : LIVE_BOOK_GBP,
        // #972 fix 3 — the same ceiling the fallback above resolves through,
        // applied to the primary live-read anchor path too.
        liveBookCeiling: config.riskConfig.live_book_ceiling,
      }),
      // `arm: 'control'` — the one caller that asks this store for the other
      // arm. Handing it the default would restore the coupling exactly.
      closedTrades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop'), 'control'),
      getOpenPositions: () => controlExecutionStore.getOpenPositions(),
      // The SAME two calendars the live provider is given: the arms must
      // measure a "day" over identical boundaries or their daily figures are
      // not comparable.
      calendars: sessionCalendars,
    }),
    costModel: executionDeps.costModel,
    marketData,
    executionConfig: config.executionConfig,
    logger,
  });

  const steps: TickSteps = {
    // #743: the tick path's position-facing exit check — the Trader's
    // exit-only entry point, runnable without analysts or a debate.
    exitCheck: traderSteps.exitCheck,
    // `logger` here is what makes an analyst failure visible at all — see the
    // adapter's doc comment (issue #358 item 4).
    analysts: buildAnalystsStep(analysts, logger, {
      skipAlerts: config.analystSkipAlerts ?? new LoggingAnalystSkipAlertChannel(logger),
      // #752: the per-name/per-subclass NO_DATA counter and the
      // degraded-coverage alert. `subclassOfUniverse` is the SAME derivation
      // #739 uses for the Risk Manager gate and the Trader's frozen bracket
      // (types.ts), so an unclassified instrument here is exactly the state
      // `DEFAULT_UNIVERSE` is in until the #749 pool file lands — bucketed as
      // `UNCLASSIFIED_SUBCLASS`, never dropped.
      coverage: {
        contextSource: marketIntelligence,
        subclassOf: subclassOfUniverse(universe),
        telemetry: new LoggingMiCoverageTelemetry(logger),
        alertChannel: config.miCoverageAlerts ?? new LoggingMiCoverageAlertChannel(logger),
        monitor: miCoverageMonitor,
        logger,
      },
      // The writers `MarketIntelligenceStore` has. Absent entirely under
      // SAMURAI_SENTIMENT=off with no archive — no agent, no calls, and the
      // analysts keep reporting NO_DATA_MARKER (#463), which is the honest
      // default rather than a silent no-op. Each agent's own refresh bucket
      // makes calling them on every pass cheap: they return immediately
      // unless the bucket rolled.
      //
      // BOTH, not one (#969). This was `miIngestAgent ?? grokAgent` — the
      // deterministic path preferred, the sentiment agent kept only as a
      // fallback — and #552's reasoning for that was sound at the time:
      // `GrokAgent` ingested `[]` by construction, so running it alongside
      // bought a second agent that contributed nothing.
      //
      // That inverts once sentiment retrieves. The two write DIFFERENT
      // buckets — `MiIngestAgent` fills `news`, `GrokAgent` fills `social` —
      // so picking one leaves the other empty by construction, and with the
      // news path available the empty one is `social`: the bucket #969 exists
      // to fill, and the one `sentiment-analyst.ts` has never once been given
      // data for. Composing them is what makes the retrieving client reachable
      // on the shipped path at all.
      ...(() => {
        const marketIntelligenceRefresh = composeMarketIntelligence([miIngestAgent, grokAgent]);
        return marketIntelligenceRefresh === undefined
          ? {}
          : { marketIntelligence: marketIntelligenceRefresh };
      })(),
    }),
    // Two independent stores hang off this one step, both over `config.db`:
    // #367's `SqliteLlmSpendStore` meters what the debate COSTS (the
    // dashboard's spend tile), and #364's `SqliteDebateLogStore` records what
    // the debate DECIDED. The latter was constructed for the Feedback Loop's
    // `feedbackStores.debate_log` to read and had no writer anywhere in the
    // tick path, so `attribution.ts` had nothing to attribute over the whole
    // soak.
    debate: buildDebateStep(
      llmClient,
      new SqliteDebateLogStore(guardedStore(config.db, 'debate-engine')),
      llmRateLimiter,
      spendCap,
      logger,
      // #435: the live `analyst_weights` table, read at every debate. Without
      // this the daily cycle steps a weight nothing reads — the write end
      // exists and the read end does not, which is the same shape as #433.
      tuningStore,
    ),
    // #328: `traderLog`/`riskLog` are what make the two stages that decide WHAT
    // to trade and HOW BIG reconstructible after the fact. Without them the
    // only record is an `audit_log` digest — enough to prove the stage ran,
    // never enough to say why a size came out at N or why a tick stopped at
    // `risk`. Both write on a skip/rejection too, which is the case with no
    // downstream record at all. Bound above via `buildTraderSteps` (#743).
    trader: traderSteps.trader,
    risk: buildRiskStep(riskStepDeps),
    verdict: buildVerdictStep(verdictStepDeps),
    execution: buildExecutionStep(executionDeps),
    // #753: falsifier arm 2, run on every tick beside the live arm. Bound
    // unconditionally — see `controlArmWiring`'s construction above for why
    // there is no flag.
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
    executionStore,
    executionDeps,
    controlArmWiring,
    llmRateLimiter,
    gdeltIngestAgent,
    polymarketAgent,
    marketIntelligence,
    marketIntelligenceCoverage: miCoverageMonitor,
  };
}

/**
 * The ticket's literal signature: all six stages bound into one runner.
 *
 * Constructs its own `ProductionComponents`, so a process must call this
 * **or** `buildProductionOrchestrator`, never both against the same account —
 * two `AlpacaBrokerAdapter`s would each hold half the bracket-leg map. The
 * orchestrator exposes its runner as `.tickRunner` for exactly that reason.
 */
export function buildProductionTickRunner(config: ProductionConfig): SequentialTickRunner {
  return new SequentialTickRunner(buildProductionComponents(config).steps);
}

/**
 * The deterministic MI ingest agent, or `undefined` when this run cannot build
 * one (#552).
 *
 * Split out and made total because there are THREE independent ways it can be
 * unavailable, and none of them may take down the boot: no archive, no scoring
 * credentials, or no Alpaca data keys. The last is the subtle one —
 * `AlpacaNewsClient` validates its keys in the constructor (deliberately, so a
 * refresh loop does not discover the gap mid-tick and report it as "no news
 * today"), which means constructing it inline would turn a missing optional
 * credential into a failed startup for the whole orchestrator.
 *
 * Degrading is safe here in a way it is not elsewhere: the caller falls back to
 * the retrieval-era agent, and the analysts already handle an empty store via
 * `NO_DATA_MARKER`. It is NOT free, though, and the log line says so — without
 * this agent the store ingests `[]` on every refresh, both news-fed analysts
 * report NO DATA, and #625's conviction ceiling stays in force.
 */
function buildMiIngestAgent(deps: {
  archive: MiArchiveStore | undefined;
  hasScoringCredentials: boolean;
  store: MarketIntelligenceStore;
  llmClient: LlmClient;
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
    clock: deps.clock,
    logger: deps.logger,
    assetClasses: deps.assetClasses,
  });
  // Startup hydration (#554): the store is in-memory, so without this a restart
  // loses every item ingested before it and the run silently measures less than
  // it appears to.
  agent.hydrate();

  return agent;
}

/**
 * The tick loop. Self-scheduling (`setTimeout`) rather than `setInterval`, with
 * a PER-INSTRUMENT in-flight guard.
 *
 * ## Why the guard is per-instrument (#669)
 *
 * It used to be global: one `inFlight` promise, and a tick arriving while any
 * instrument was still working was dropped whole, logging "tick skipped:
 * previous tick still running". That made starvation systematically
 * one-directional. A debate is 4 LLM calls and ~13s measured, crypto runs 24/7
 * and produced 33 debates per instrument against 7 per equity instrument over
 * 42.6h — so in practice it was always a slow CRYPTO debate costing the equity
 * leg a tick, never the reverse. Under the old weeks-to-months horizon that was
 * nearly free. Under ADR-0014's intraday horizon the equity leg's window is
 * about two hours, and David's stop rule is −0.5% with an indicator-based early
 * exit, so on a 3x leveraged ETP a lost tick is real slippage on the exit.
 *
 * ## Why dropping the global guard is safe
 *
 * The original doc justified it as LLM-concurrency control: "overlapping ticks
 * would multiply concurrent LLM calls beyond `max_concurrent_instruments`'
 * cap — the cap bounds instruments *within* a tick and knows nothing about
 * ticks racing each other". That reasoning predates the mechanisms that now own
 * this. `RateLimiter.reserve` (#388) admits or refuses every debate against a
 * per-asset-class window BEFORE any call is made — that check IS indifferent
 * to which tick a debate belongs to: `debatesUsed` is incremented
 * synchronously and atomically per reservation regardless of tick or
 * instrument, so the window's admission count is exact no matter how many
 * ticks or passes overlap. The global lock was doing rate limiting's job,
 * coarsely, and paying for it in dropped equity ticks.
 *
 * **`SpendCap` (ADR-0008) is NOT the same shape, and it is worth being exact
 * about (#1013 fix-up H2) rather than lumping it in with `RateLimiter`.**
 * `SpendCap.check()` is a synchronous PURE READ against cumulative
 * `llm_spend.cost_usd` — it admits or refuses, but reserves nothing, and
 * nothing debits the figure it read until the admitted debate's calls are
 * actually recorded later. Concurrent instruments can therefore all read the
 * SAME pre-spend total and all pass `check()` before any of their spend
 * lands, so the cap's overshoot bound scales with how many debates can be
 * concurrently admitted, not with ticks. See `debate-adapter.ts`'s
 * `spendCap.check()` call site for the concurrency-scaled overshoot figure —
 * accepted there as financially trivial at this PR's width.
 *
 * What remains genuinely per-instrument is pipeline reentrancy: one instrument
 * must not have two passes in flight, or the second would decide against
 * position state the first has not finished writing. That is exactly what
 * `running` guards, and nothing wider.
 *
 * ### Persistence under interleaved passes
 *
 * The argument above covers LLM concurrency but not the two stores every pass
 * writes, and passes from different ticks CAN now overlap — a state the global
 * lock made unreachable by construction. Audited rather than assumed:
 *
 * - **`current_tick` is keyed `instrument TEXT PRIMARY KEY`** (migration 0001),
 *   and `SqliteCurrentTickStore` only ever upserts or deletes BY instrument.
 *   Two overlapping passes therefore touch different rows unless they share an
 *   instrument — which the guard makes impossible. There is no last-write-wins
 *   hazard to key around; the row is already keyed more finely than a pass.
 * - **`audit_log` is append-only** — `SqliteAuditLog.record` is a bare INSERT
 *   with no key to collide on, so interleaving reorders rows at worst, and
 *   readers already sort (`ORDER BY timestamp, rowid`).
 * - **Writes are synchronous.** `better-sqlite3` statements do not yield, so
 *   there is no interleaving *within* a statement for either store — only
 *   between them, which is what the two points above cover.
 *
 * So neither store assumes a single writer; both assume a single writer PER
 * INSTRUMENT, which is precisely the invariant this guard holds.
 *
 * **This section covers PERSISTENCE only — `current_tick`, `audit_log`, and
 * the synchronous-write guarantee underneath both. It says nothing about
 * whether the Risk/Execution DECISION path is safe under the same
 * interleaving, and it is not (#1013 fix-up H3).** Portfolio-level risk caps
 * (`perSubclassDeploymentCap`, `risk-manager/index.ts`) net exposure across
 * concurrently-armed instruments by reading `position.filled_size`, which is
 * zero for an order this tick has not yet had a fill poll for — at
 * `maxConcurrentInstruments: 6` (#1013), sibling instruments' Risk
 * evaluations routinely run before any fill poll intervenes, so that netting
 * cannot see same-tick concurrent exposure. See #1019 for the full mechanism,
 * why it is bounded today (no subclass classification on `DEFAULT_UNIVERSE`),
 * and why it stops being bounded once #895's pool arms D5 classification.
 *
 * **#1040 narrowed that to the CROSS-PASS case, and only that.** The phase
 * split (`tick-loop.ts`'s `TailSequencer`) makes the portfolio-mutating tail
 * of one plan run one instrument at a time, in plan order, so two instruments
 * of the SAME pass can no longer reach Risk against the same pre-trade
 * snapshot. What it does not close is two overlapping PASSES — the state this
 * whole section is about, reachable because the interval is re-armed ahead of
 * the pass (#669) — since each pass carries its own sequencer over its own
 * plan and the two do not order against each other. #1019's submit-time
 * reservation ledger is still the fix for that, and remains open.
 *
 * ## Scheduling
 *
 * The next tick is scheduled when the previous pass STARTS, not when it
 * finishes, so the cadence is the interval rather than interval-plus-duration.
 * Under the old shape a 40-second pass stretched every subsequent tick by 40
 * seconds, which is the same starvation seen from the other end.
 *
 * The first tick fires one interval after `start()`, not immediately: startup
 * (orphan scan, heartbeat) should settle before the first pipeline pass, and
 * a tick at t=0 would race the scan's read of `audit_log` against the
 * runner's first write to it.
 *
 * ## `maxConcurrentInstruments` is a per-pass bound (#692)
 *
 * It read as a global ceiling before #669 re-armed the interval ahead of the
 * pass. Now several passes can legitimately be in flight at once across
 * disjoint instruments, and each is handed this full value — so the real bound
 * on concurrent pipelines is `maxConcurrentInstruments x passes in flight`.
 *
 * Left per-pass deliberately rather than made global. The per-instrument guard
 * means overlapping passes never share an instrument, so the overlap is breadth
 * across the universe rather than reentrancy on one name; and the resource this
 * was really protecting — LLM concurrency and spend — is bounded independently
 * by `RateLimiter` and `SpendCap`, which ARE process-wide. What was wrong was
 * the silence, not the value: an operator sizing the knob had no way to know it
 * had stopped meaning what its name says.
 */
export function startTickLoop(deps: {
  scheduler: Scheduler;
  runner: TickRunner;
  clock: Clock;
  logger: Logger;
  persistence: PersistenceInstances;
  tickIntervalMs: number;
  /** Per PASS, not process-wide: the real ceiling is this x passes in flight (#692). */
  maxConcurrentInstruments: number;
  /** The tick/decision split's gate (#743) — see `TickLoopConfig.decisionGate`. */
  decisionGate: DecisionGate;
}): { stop: () => Promise<void> } {
  let stopped = false;
  /**
   * Instruments with a pass still in flight — the reentrancy guard (#669) —
   * each mapped to the TOKEN of the claim that owns it.
   *
   * A bare `Set` was not enough, and the failure needs three passes to see.
   * Claims are released per instrument as each pipeline settles, so a fast
   * instrument is free again long before its own pass finishes. Suppose pass 1
   * claims A and B; A settles at t+100ms and is released; tick 2 fires and
   * re-claims A into pass 2; B settles at t+4s and pass 1's backstop finally
   * runs, deleting EVERY asset pass 1 claimed — including A, which pass 2 now
   * owns. Tick 3 then starts a second concurrent pass on A: precisely the
   * reentrancy #669 exists to prevent, reintroduced by the guard meant to
   * protect it.
   *
   * The token makes release ownership-aware: a holder deletes the entry only
   * if it is still its own. A stale release is then a no-op instead of
   * unlocking someone else's claim.
   */
  const running = new Map<string, symbol>();
  /** Outstanding passes, so `stop()` awaits them instead of abandoning them mid-pipeline. */
  const passes = new Set<Promise<void>>();
  let handle: NodeJS.Timeout | undefined;

  /** Releases `asset` only if `token` still owns it. See `running`. */
  const release = (asset: string, token: symbol): void => {
    if (running.get(asset) === token) {
      running.delete(asset);
    }
  };

  /**
   * Clears each instrument's guard when THAT instrument's pipeline settles,
   * rather than when the whole pass does.
   *
   * The distinction is the entire point of #669 and is easy to get wrong — I
   * did, first time. Releasing on pass completion is still a per-PASS guard
   * wearing a per-instrument shape: a two-instrument plan where one is slow
   * keeps the fast one marked running until the slow one finishes, which
   * reproduces exactly the starvation this ticket exists to remove.
   *
   * Wrapping the runner is what makes it genuinely per-instrument, and it is
   * also the narrowest seam that knows an instrument is done — `runTickPlan`
   * reports only the whole plan's completion.
   *
   * Built PER PASS rather than once, so it closes over that pass's claim
   * tokens and can release only what it actually claimed.
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

  const runOnce = async (): Promise<void> => {
    try {
      const plan = deps.scheduler.nextTick(deps.clock);

      // Claim inside ONE loop — check and claim per asset, not filter-then-add.
      // A `filter` followed by a separate `add` loop is not atomic per asset:
      // if `nextTick` ever returned the same asset twice, both entries would
      // pass the filter before either was claimed and both would run
      // concurrently, silently violating the one-pass-per-instrument invariant
      // this guard exists to hold. Claiming as we go makes the duplicate lose
      // to itself.
      const claims = new Map<string, symbol>();
      const ready: typeof plan.instruments = [];
      const busy: string[] = [];
      // Separated from `busy` (#692): a within-plan duplicate and a still-running
      // instrument are skipped by the same check but mean opposite things. One
      // is a slow pass — the steady state this guard exists to tolerate. The
      // other is `nextTick` handing back a malformed plan, which is a bug in the
      // scheduler and should never be reported as "still running from a previous
      // pass". Collapsing them hid the second exactly when the guard caught it.
      const duplicated: string[] = [];
      // Duplicate detection reads THIS set, not `claims`. Keying off `claims`
      // detected a duplicate only when the first occurrence was claimable: if
      // that first occurrence was already running from a prior pass it never
      // entered `claims`, so the second occurrence fell through to the
      // `running` check and was reported as an ordinary slow pass — the
      // malformed plan hidden again, in exactly the case where a duplicate is
      // most likely to matter. Seen-in-plan has to be tracked independently of
      // whether the instrument was claimable.
      const seenInPlan = new Set<string>();
      for (const instrument of plan.instruments) {
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
          // INFO, not warn. A partially-busy tick is the steady state, not an
          // anomaly: this PR's own reasoning is that slow crypto debates
          // routinely outlast the interval, so at `warn` this line fires every
          // interval for the whole life of every slow debate and buries the
          // case the message exists to surface — the equity leg falling behind
          // inside its two-hour window. A level that is always on carries no
          // information; `skipped` is still named so that case stays greppable.
          level: 'info',
          // Named, not counted. The whole point of #669 is that WHICH
          // instrument is late decides whether this is benign; a bare count
          // cannot distinguish "crypto is slow again" from "the equity leg has
          // stopped keeping up inside its two-hour window".
          message: `tick: ${busy.length} instrument(s) still running from a previous pass, skipped this tick`,
          payload: { skipped: busy, ran: ready.length },
        });
      }

      if (duplicated.length > 0) {
        // WARN, unlike `busy` above. This one is not a steady state: the
        // scheduler returned the same asset twice in one plan, which no
        // correct `nextTick` does. The guard already made the duplicate lose
        // to itself, so the tick is safe — but the plan that produced it is
        // not, and nothing else in the process would report it.
        deps.logger.log({
          trace_id: 'tick-loop',
          stage: 'tick-loop',
          level: 'warn',
          message: `tick: scheduler returned ${duplicated.length} duplicate instrument(s) in one plan, extras dropped`,
          payload: { duplicated },
        });
      }

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
          // Backstop only — `buildGuardedRunner` clears each instrument as its
          // own pipeline settles. This catches an instrument the plan claimed
          // but `runTickPlan` never dispatched (a throw between claim and
          // call), which would otherwise leave it marked running forever and
          // silently stop trading it for the rest of the process.
          //
          // Ownership-aware: it releases only claims THIS pass still owns. A
          // blanket delete would unlock an instrument a newer pass had already
          // re-claimed, which is how a backstop turns into the reentrancy it
          // was guarding against.
          for (const [asset, token] of claims) release(asset, token);
        });

      // What `stop()` awaits is a SHIELDED view of the pass, not the pass
      // itself (#692). `runOnce`'s own catch below handles its own `await`; it
      // does not mark the promise handled for anyone else, and `Promise.all` in
      // `stop()` attaches a second, independent handler to the same object. So
      // a pass failing after `stop()` snapshotted the set used to reject
      // `Promise.all`, throw out of `stop()`, and abandon every OTHER
      // outstanding pass mid-pipeline — the precise thing `passes` exists to
      // prevent, in the one place it matters most.
      //
      // The failure is not swallowed: `runOnce` still awaits the raw `pass` and
      // logs it below. Only the shutdown path's view of it is shielded.
      const settled = pass.catch(() => undefined);
      passes.add(settled);
      try {
        await pass;
      } finally {
        passes.delete(settled);
      }
    } catch (error) {
      // A thrown tick must not kill the process: the heartbeat's silence is
      // the intended external failure signal, and a transient stage/transport
      // error should cost one tick, not the run (same posture as
      // `Heartbeat.emit`).
      deps.logger.log({
        trace_id: 'tick-loop',
        stage: 'tick-loop',
        level: 'error',
        message: 'tick failed',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    handle = setTimeout(() => {
      // Re-armed BEFORE the pass rather than after it (#669). Chaining on
      // completion made the real period `interval + passDuration`, so one slow
      // crypto debate pushed back every instrument's next tick — the same
      // starvation the per-instrument guard removes, arriving by the other
      // route. The guard is what makes this safe: an instrument still working
      // is skipped by name, so re-arming cannot stack two passes on one
      // instrument.
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
      // Every outstanding pass, not just the newest: with the interval re-armed
      // ahead of the pass, more than one can legitimately be in flight across
      // different instruments.
      //
      // This only ever waits because `passes` holds SHIELDED promises (#692),
      // not because `runOnce` catches. That distinction was previously stated
      // the wrong way round: `runOnce`'s catch covers its own `await` and
      // nothing else, so with the raw chain in this set a pass failing here
      // would reject `Promise.all` and drop the remaining passes on the floor.
      //
      // The wait now spans up to W passes serialized behind one another's
      // portfolio tails (#1040), not W fully-parallel passes. It is still
      // bounded, but NOT because a tail is cheap: since #957 folded the Risk
      // Critic into `steps.risk`, a tail contains a live LLM call of its own,
      // bounded by `DEFAULT_CRITIC_BUDGET_MS` (10s, `risk-manager/critic.ts`)
      // and by nothing here. So each tail costs that budget plus sub-second
      // book operations, the head's LLM work is capped by `raceWithTimeout` in
      // `debate-engine/analyst-response-collector.ts`, and this waits at most
      // W x (head timeout + critic budget).
      await Promise.all([...passes]);
    },
  };
}

/**
 * The equity venue's calendar, chosen by MODE rather than hardcoded (#668).
 *
 * `LseRegularHoursCalendar` landed with #668 and had no production caller —
 * this repo's dominant defect shape, and the one that matters most here: every
 * flatten decision on the live leg would have resolved through the US 16:00 ET
 * boundary, which is 20:00 or 21:00 London, **hours after the 16:30 LSE
 * close**. The overnight carry #668 exists to prevent, arriving through the
 * composition root rather than through the rule.
 *
 * The venues genuinely differ per ADR-0015: live equity is a Saxo Capital
 * Markets UK GIA (ADR-0015's 2026-08-30 amendment; this comment said
 * "Trading 212 ISA" until #946), restricted to GBP LSE-listed ETFs/ETCs
 * (#659), while paper runs Alpaca US
 * equities. #656 measured the two sessions overlapping by only two hours, so
 * one calendar cannot serve both — which is exactly why #668 made the flatten
 * an offset resolved through the instrument's own calendar rather than a shared
 * wall-clock constant.
 *
 * A FUNCTION rather than a literal at each site, because there are two sites —
 * the component root and the scheduler — and they were already two independent
 * `?? new UsEquityRegularHoursCalendar()` defaults. That was harmless while both
 * defaults were the same class; the moment the default depends on mode, two
 * copies means the scheduler gating market hours on New York while the flatten
 * resolves against London. `config.tradingCalendar` still overrides both.
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
 * The full composition root: every stage bound, every store constructed, and
 * a `start`/`stop` pair for the entrypoint. Startup order is
 * orphan-scan-then-loop (ADR-0004 §3, ticket #236): the scan reports `go`
 * verdicts a prior crash stranded before Execution, and must read the audit
 * trail before this run starts writing to it.
 */
export function buildProductionOrchestrator(config: ProductionConfig): ProductionOrchestrator {
  const logger = config.logger ?? new JsonLogger();
  const clock = config.clock;
  const components = buildProductionComponents(config);

  const persistence = buildPersistence(config.db);
  const tickRunner = new SequentialTickRunner(components.steps);
  // ONE calendar object, shared by the scheduler's gate and the flatten tail
  // below — the two-copies hazard `equityCalendarFor`'s docblock exists to
  // prevent applies with more force now that the tick window is derived from
  // `sessionEnd` rather than merely gated beside it.
  const equityCalendar = equityCalendarFor(config);
  const scheduler = new UniverseScheduler({
    universe: config.universe ?? SMOKE_TEST_UNIVERSE,
    calendar: equityCalendar,
    // Passed through rather than defaulted here (#706). The composition root
    // is where a run's policy is chosen; a default in this line would apply
    // the window to the backtest harness and to every programmatic caller,
    // neither of which asked for it.
    //
    // Widened to the flatten tail before it reaches the scheduler. The window
    // reads as an entry narrowing but gates the whole pipeline pass, and the
    // Trader is the only thing that flattens — so the entry window alone
    // removes every tick that could satisfy flat-by-close. See
    // `withFlattenTail` for why the union cannot open a position and why the
    // composition root is the only place that can compose it.
    ...(config.stocksTradingWindow === undefined
      ? {}
      : {
          stocksTradingWindow: withFlattenTail(
            config.stocksTradingWindow,
            equityCalendar,
            config.traderConfig.flatten_before_close_ms,
          ),
        }),
  });
  const heartbeat = new Heartbeat(
    config.heartbeatChannel ?? new LoggingHeartbeatChannel(logger),
    logger,
  );

  let loop: { stop: () => Promise<void> } | undefined;
  let fillSync: { stop: () => Promise<void> } | undefined;
  /**
   * #753: falsifier arm 2's own fill poller.
   *
   * A SECOND loop rather than a widened first one, because `ingestFills()` and
   * `reconcile()` are bound to one Execution surface, and that surface is bound
   * to one store and one broker — and the arms deliberately have neither in
   * common. Without this the control arm's lots stop dead at `submitted`:
   * `writeClosedTrade` is only reached from `ingestFills`, so the control would
   * emit no `ClosedTrade` at all and the comparison report would show it making
   * zero trades — indistinguishable from a control that found no setups. That
   * is exactly the "one missing caller, four silent failures" shape
   * `fill-sync.ts` was written to fix, and leaving it out here would recreate it.
   */
  let controlFillSync: { stop: () => Promise<void> } | undefined;
  let heartbeatHandle: NodeJS.Timeout | undefined;
  let feedbackHandle: NodeJS.Timeout | undefined;
  let gdeltHandle: NodeJS.Timeout | undefined;
  let polymarketHandle: NodeJS.Timeout | undefined;

  // Execution's two polled surfaces, bound once. Built from the same
  // `ExecutionStepDeps` the tick step uses, so the two paths cannot drift.
  const fillSyncExecution = buildExecutionSurface(components.executionDeps, FILL_SYNC_TRACE_ID);
  const reconcileExecution = buildExecutionSurface(components.executionDeps, RECONCILE_TRACE_ID);

  /**
   * Feedback Loop's daily batch on its own timer — not a `TickSteps` member
   * (ADR-0004 §3). Synchronous and store-driven, so a throw here would take
   * the timer callback down with it; caught and logged for the same reason
   * the tick loop catches (one bad cycle must not end the run).
   */
  // Constructed once and closed over, not per invocation — the stores are
  // stateless over the shared handle, so a fresh set each cycle bought
  // nothing (code-review 2026-08-01, H7).
  const feedbackStores = {
    trades: new SqliteClosedTradeStore(guardedStore(config.db, 'feedback-loop')),
    debate_log: new SqliteDebateLogStore(guardedStore(config.db, 'debate-engine')),
    tuning: components.tuning,
    adjustments: new SqliteAdjustmentLog(guardedStore(config.db, 'feedback-loop')),
  };
  /**
   * #366, retargeted by #736. Resolved once, outside the timer callback, for
   * `feedbackStores`' reason — and read in the same precedence order the alert
   * channels use: an explicit per-cycle override first, then the transport
   * `SAMURAI_ALERTS` selected, then the log-only stand-in.
   *
   * Whichever wins, none of them gates anything: the port returns `void` and
   * is asked nothing. Since ADR-0013 Decision 2 the cycle applies its own
   * bounded loosenings and this channel only reports them, so a channel that
   * fails to deliver costs visibility of a move that already happened — the
   * bounds are what keep it safe, not the notice.
   */
  const loosenNotices =
    config.feedback?.loosenNotices ??
    config.loosenNotices ??
    new LoggingLoosenNotificationChannel(logger);

  /**
   * The detector's source, built once at construction (#379) — never per cycle,
   * for `feedbackStores`' reason, and never per tick: nothing about it is
   * per-day. `undefined` here means exactly what it meant before, that no
   * detector was asked for.
   *
   * A factory is called eagerly rather than at first cycle deliberately: the
   * first cycle is up to 24h away, and a construction error (e.g.
   * `minReturnObservations` below the floor, which
   * `SqliteDailyEquityMetricsSource` refuses) must fail the start it belongs to
   * rather than surface a day later inside a caught timer callback.
   */
  /**
   * The frozen Stage 2 selections (#375, #384). One instance, read by two
   * consumers: the metrics source (for `revalidation`) and the divergence
   * baseline below. Both must see the same row — a selection good enough to
   * arm three kill-lines and not the fourth would be incoherent.
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
   * `computeMetrics`'s production caller (#327) — the thing that makes the
   * four kill-lines reachable in a paper run at all. Runs inside the same
   * daily timer as `runDailyCycle`, after it, so a breach's defensive
   * auto-tighten lands on thresholds the cycle has already finished writing
   * rather than racing it.
   *
   * Returns without computing when no suite is available. That is the honest
   * path, not a failure: see `DailyMetricsSource`. It is logged at `warn`
   * every time, because a cycle that checked nothing must never look like a
   * cycle that found nothing.
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
      // what a breach auto-tightens.
      config: feedbackConfig,
      alerts: components.breachAlerts,
    });

    logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      // A breach is an `error` even though the alert channel also carries it:
      // the log is the record an operator reads back after the fact.
      level: report.breaches.length > 0 ? 'error' : 'info',
      message:
        report.breaches.length > 0
          ? 'daily metrics computed — KILL-THRESHOLD BREACH (alerted, thresholds auto-tightened)'
          : 'daily metrics computed',
      payload: {
        breaches: report.breaches,
        // Carried into the log as well as the report so a revalidation-less
        // day is legible in the log stream, not only to a caller holding the
        // returned `MetricsReport`.
        not_evaluated: report.not_evaluated,
        revalidation_present: report.revalidation !== undefined,
        daily: report.daily,
      },
    });
  };

  /**
   * The matched-control comparison's production caller (#971, under #636 and
   * #913) — the thing that makes falsifier arm 2's numbers reach an operator at
   * all, rather than only `yarn report:arms` when a human remembers to run it.
   *
   * Runs inside the same daily timer as `runDailyCycle`, per #636 ("additional
   * columns in the existing daily/weekly suite, no new scheduling primitive"),
   * and deliberately NOT inside `runMetricsCheck`: that function returns early
   * whenever no `MetricsSuite` is available, and the arm comparison is derived
   * from `closed_trades` — it is computable on every one of those days. Nesting
   * it there would leave this mechanism silently un-run for exactly the runs it
   * exists to measure, which is this repo's dominant defect class.
   *
   * The reader is `SqliteArmComparisonSource` (control-arm/), NOT
   * `feedbackStores.trades`: the latter is scoped to `arm = 'live'` so the loop
   * never tunes on the control's outcomes, and this question needs both arms out
   * of ONE window query (doc 12 gate 4).
   */
  const armComparisonSource = new SqliteArmComparisonSource(guardedStore(config.db, 'control-arm'));
  const armComparisonSamples = new SqliteArmComparisonSampleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  /**
   * The outside benchmarks' production caller (#981, under #636) — the half of
   * #636 that #971 left open. SPY and 60/40 over the MATCHED CONTROL'S window,
   * on FL's existing daily cadence.
   *
   * The series come from `components.benchmarkSeries` — the benchmarks' OWN
   * reader, resolved in `buildProductionComponents` over a stocks-rooted
   * source that takes no `universe`, and NOT from `components.marketData`.
   * That distinction is load-bearing rather than tidy: `marketData` is
   * universe-derived and becomes `LseMarkDataSource` exclusively on #751's
   * cutover, and that source refuses `'SPY'` by design (#734), which would put
   * both benchmarks permanently in `unmeasured`. See the construction site for
   * the full argument.
   *
   * SPY and AGG are ordinary US-listed instruments on Alpaca's `/v2/stocks`
   * root, verified obtainable as daily bars on the free-tier `iex` feed this
   * codebase defaults to. No new vendor, key or spend — and #895 (the LSE
   * real-time L1 mark vendor) is a different data need and does not gate this.
   */
  const outsideBenchmarkSeries = components.benchmarkSeries;
  const outsideBenchmarkSamples = new SqliteOutsideBenchmarkSampleStore(
    guardedStore(config.db, 'feedback-loop'),
  );

  /**
   * Fire-and-forget, but NEVER unhandled.
   *
   * `runFeedbackCycle` is synchronous and is called from a `setInterval`, so
   * there is no `await` seam here. An unawaited promise whose fetch rejects
   * would be an unhandled rejection AND a benchmark that silently never
   * persists — this repo's dominant defect class arriving through the back
   * door. So the rejection is handled explicitly, and logged, rather than left
   * to the runtime.
   *
   * It runs AFTER the arm comparison and takes its `comparison`: the window is
   * inherited, never recomputed (#636's exact-window condition).
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
          // `warn` only when a benchmark could not be measured at all. A
          // benchmark out-performing the book is NOT a warning — it is context,
          // and an outside benchmark can never raise a verdict (#636: secondary,
          // never a replacement for the matched control).
          level: result.unmeasured.length > 0 ? 'warn' : 'info',
          message:
            result.unmeasured.length > 0
              ? 'outside benchmarks computed — SOME NOT MEASURED (absent, not zeroed)'
              : 'outside benchmarks computed',
          payload: {
            window_from: comparison.from.toISOString(),
            window_to: comparison.to.toISOString(),
            // Return AND drawdown together on every measured benchmark
            // (`docs/research/12-edge-hypothesis-critique.md` D4).
            measured: result.measured.map((sample) => sample.performance),
            // The reason a benchmark is absent lives HERE and nowhere else: FL
            // persists no row for it, so without this line "the vendor failed"
            // and "FL never ran" are the same empty panel.
            unmeasured: result.unmeasured,
          },
        });
      })
      .catch((error: unknown) => {
        logger.log({
          trace_id: 'feedback-cycle',
          stage: 'feedback-loop',
          level: 'error',
          message: 'outside benchmark cycle failed',
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      });
  };

  const runArmComparison = (): ArmComparison => {
    const sample = runArmComparisonCycle({
      clock,
      trades: armComparisonSource,
      samples: armComparisonSamples,
      alerts: components.armDivergenceAlerts,
      // The declared book, not live equity: both arms must be divided by the
      // SAME denominator or their two `return_pct` figures are not comparable.
      // Same choice `report-arm-comparison.ts` makes, for the same reason.
      basis: LIVE_BOOK_GBP,
      window_ms: DEFAULT_ARM_COMPARISON_WINDOW_MS,
      thresholds: DEFAULT_ARM_DIVERGENCE_THRESHOLDS,
    });

    logger.log({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      // A divergence is `warn`, not `error`: nothing failed and no dial moved
      // (contrast the kill-line breach above, which auto-tightens). It is the
      // measurement #636 asked for, and the operator decides what it means.
      level: sample.divergence.diverged ? 'warn' : 'info',
      message: sample.divergence.diverged
        ? 'arm comparison computed — ARM DIVERGENCE (alerted, nothing auto-tightened)'
        : 'arm comparison computed',
      payload: {
        window_from: sample.comparison.from.toISOString(),
        window_to: sample.comparison.to.toISOString(),
        basis: sample.comparison.basis,
        // Both arms, both columns — never a return without its drawdown
        // (`docs/research/12-edge-hypothesis-critique.md` D4).
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

  // #1045. Read here as well as in `buildProductionComponents`, not passed
  // between them: these are two separate composition roots, the read is pure
  // and validated, and both resolve the same variable in the same process, so
  // they cannot disagree. Threading it through `ProductionComponents` would
  // widen a public shape to carry a housekeeping constant.
  const llmCallLogMaxRows = llmCallLogMaxRowsFromEnvironment();
  // #1060. Same reasoning, same shape, for the MI archive's 90-day window.
  const miArchiveRetentionDays = miArchiveRetentionDaysFromEnvironment();

  const runFeedbackCycle = (feedback: FeedbackCycleConfig): void => {
    // #1045, and FIRST — outside the try below, before any of the tuning work.
    //
    // Placement is the whole point. Inside that try, after `runDailyCycle`, a
    // persistently throwing feedback cycle would silently disable retention
    // too: the catch would fire every day and the table would grow forever
    // while the log showed only a feedback failure. Housekeeping that depends
    // on unrelated work succeeding is not housekeeping. `pruneLlmCallLogWithLog`
    // swallows its own errors, so it cannot cost the cycle anything either.
    //
    // Riding this existing 24h timer rather than adding a scheduler follows
    // #636's rule, stated at `runOutsideBenchmarks` below: additional work
    // joins the existing daily suite, no new scheduling primitive. Note it is
    // a plain `setInterval` from process start, so "daily" means every ~24h of
    // uptime, not a calendar midnight — fine for a retention sweep, but it is
    // not a nightly job and should not be described as one.
    pruneLlmCallLogWithLog(config.db, llmCallLogMaxRows, logger, 'daily');
    // #1060. Same placement rule applies: outside the try, so a persistently
    // failing feedback cycle cannot silently disable the MI archive's purge.
    pruneMiArchiveWithLog(config.miArchive, miArchiveRetentionDays, clock, logger, 'daily');

    try {
      const result = runDailyCycle({
        clock,
        ...feedbackStores,
        config: feedback.config,
        loosen_notices: loosenNotices,
        proposals: feedback.proposals ?? [],
        // No `mode` here since #736: the cycle ran one path in backtest and a
        // different, gated one in paper and live, and the gate is gone.
      });
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'info',
        message: 'daily feedback cycle complete',
        payload: result,
      });

      // Inside the same try/catch — a throw here must not take the timer down
      // either — and deliberately AFTER the cycle's own log line, so a metrics
      // failure cannot erase the record that the tuning cycle itself
      // succeeded: the 'complete' line is already written by then, and the
      // catch below adds a 'failed' line rather than replacing it.
      if (feedback.metrics !== undefined && metricsSource !== undefined) {
        runMetricsCheck(metricsSource, feedback.metrics, feedback.config);
      }

      // #971: OUTSIDE the `feedback.metrics` guard above, deliberately. The
      // comparison needs no `MetricsSuite` and no Stage 2 selection — only
      // `closed_trades` — so gating it on the metrics source would make the
      // matched control invisible on every day the equity series is thin,
      // which is most of them early in a soak.
      const comparison = runArmComparison();

      // #981: the outside benchmarks, over the window `runArmComparison` just
      // measured the arms over. Inside the same try/catch and AFTER the arm
      // comparison, both deliberately — a benchmark is secondary and must never
      // be able to cost the operator the matched control's reading.
      runOutsideBenchmarks(comparison);
    } catch (error) {
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'error',
        message: 'daily feedback cycle failed',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });

      // #766: the daily kill-line check's half of #638's clamp — a throw here
      // (`computeMetrics` via `assertKillThresholdsWithinBounds` /
      // `assertThresholdsWithinBounds`, metrics.ts) previously left the cycle
      // silently un-run with nothing beyond this log line. Runs once a day at
      // most (this catch fires at most once per `runFeedbackCycle` call), so
      // no latch is needed the way the live-read seam's per-tick catch needs
      // one.
      if (isThresholdBoundViolation(error)) {
        config.thresholdClampAlerts?.postThresholdClampAlert({
          where: 'daily-kill-line-check',
          message: error instanceof Error ? error.message : String(error),
          reported_at: clock.now(),
        });
      }
    }
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
    marketIntelligenceCoverage: components.marketIntelligenceCoverage,
    marketIntelligence: components.marketIntelligence,

    async start(): Promise<OrphanGoVerdict[]> {
      const orphans = await persistence.orphanScanner.scan(
        config.db,
        config.orphanAlerts ?? new LoggingOrphanAlertChannel(logger),
        logger,
      );

      // Reconcile BEFORE the tick loop and before the first fill poll, and
      // awaited rather than fired off. A crash leaves lots stranded
      // `pending`/`submitted`, and starting to trade against a store that
      // still disagrees with the venue is what reconcile exists to prevent —
      // so a failure here propagates out of `start()` instead of being
      // logged and stepped over.
      await runStartupReconcile({ execution: reconcileExecution, logger });

      // #753: the control arm's own startup reconcile, for the reason the live
      // arm's runs before the tick loop — a crash leaves control lots stranded
      // `pending`/`submitted`, and the simulated adapter's bracket registry is
      // process-local, so nothing repopulates it until `getOrder` is called.
      // Awaited alongside the live one, and allowed to propagate for the same
      // reason: it writes through the SAME database handle the live arm trades
      // against, so a store that will not take this write is a store the process
      // must not go on to place orders against.
      await runStartupReconcile({
        execution: components.controlArmWiring.reconcileExecution,
        logger,
      });

      // #371, and deliberately HERE — beside reconcile, before the tick loop,
      // the fill poll and the heartbeat all start.
      //
      // ## This path fails fast on purpose, unlike its siblings below
      //
      // Every other feedback-loop startup problem in this function degrades to
      // a logged warn, so the difference needs saying rather than being left
      // to look like an oversight (PR #376 review). Those warns cover a
      // MISSING FEATURE: `feedback` unset, `metrics` unset (the paper profile
      // sets it since #379, but a caller's own config need not), or a kill-line
      // whose input nothing produces. Nothing is broken — a capability is
      // absent, and announcing it is the whole fix.
      //
      // A throw out of this call is a different animal: it means the shared
      // store would not take a single-row insert. That same handle carries
      // open positions, fills, closed trades and the broker's bracket index,
      // so a process that cannot write to it must not go on to place orders
      // against it — the exact reasoning `runStartupReconcile` above is
      // already allowed to propagate on, and for the same store. Catching
      // here would buy a soak that trades with an unwritable database and no
      // weight rows, which is both halves of #366/#371 dead again plus a live
      // broker. So it propagates out of `start()`, before anything has traded.
      //
      // No defensive check on `feedback.config.weights` either: `FeedbackConfig
      // .weights` is a required `TunableDial`, so an absent one is reachable
      // only by casting past the compiler. Guarding a state the type system
      // already forbids would just hide the cast.
      if (config.feedback !== undefined) {
        // `runDailyCycle` steps only analysts that already have an
        // `analyst_weights` row, so before this every cycle attributed real
        // trades and then skipped every analyst — an empty table and a soak
        // that "ran cleanly" while learning nothing. First-write-wins in the
        // store, so the restarts a 14-day soak (#238) will see cannot flatten
        // what the loop has learned; see `seedAnalystWeights`.
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
       * #433, and NOT gated on `config.feedback`: the rows seeded here are the
       * caps the Risk Manager reads at every `evaluate()`, whether or not a
       * daily cycle ever runs. Seeding is also what makes `autoTighten`
       * reachable at all — it steps a value it can already read and skips a
       * dial whose `current` is undefined, so an unseeded table meant a
       * kill-line breach tightened nothing.
       *
       * First-write-wins in the store, so a restart cannot re-open a cap the
       * loop has already narrowed.
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
      if (gdeltIngestAgent !== undefined) {
        /**
         * GDELT polls on its OWN timer, deliberately not from the analysts step
         * where `MiIngestAgent` runs (#556).
         *
         * Two reasons. It is not per-instrument — one batch is the whole
         * world's macro news, so hanging it off a per-instrument refresh would
         * poll it once per universe member for one shared result. And a batch
         * is a ~3.4MB download that inflates to ~10.5MB; doing that on the
         * tick's critical path would add seconds BEFORE the analysts run, which
         * is the same starvation shape #669 had to unpick.
         *
         * Fire-and-forget is safe here specifically because `refresh` never
         * throws and returns `false` on any vendor failure — the contract its
         * own tests pin.
         */
        // Immediately, then on the interval: waiting a full period before the
        // first poll would throw away the oldest 15 minutes of every restart,
        // and the baseline this archive exists to accumulate is measured in
        // hours.
        void gdeltIngestAgent.refresh('startup');
        gdeltHandle = setInterval(() => {
          void gdeltIngestAgent.refresh('gdelt-poll');
        }, config.gdeltPollIntervalMs ?? DEFAULT_GDELT_POLL_INTERVAL_MS);
      }

      /**
       * Polymarket polls on its OWN timer too (#504), for GDELT's first
       * reason: the curated table is macro, not per-instrument, so hanging it
       * off the per-instrument analysts step would poll it once per universe
       * member for one shared result. The download argument does not apply
       * (these are small JSON documents), but the agent's hourly bucket means
       * most polls make no request at all, so the tick path would gain
       * nothing by owning it.
       *
       * Fire-and-forget is safe for the same reason: `refresh` never throws
       * and returns `false` on any vendor failure — the contract its own tests
       * pin. Immediately, then on the interval, so a restart does not start
       * the run with an empty `news` bucket for up to a full period.
       */
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
      });

      fillSync = startFillSync({
        execution: fillSyncExecution,
        clock,
        logger,
        fillPollIntervalMs: config.fillPollIntervalMs ?? DEFAULT_FILL_POLL_INTERVAL_MS,
      });

      loop = startTickLoop({
        scheduler,
        runner: tickRunner,
        clock,
        logger,
        persistence,
        tickIntervalMs: config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
        maxConcurrentInstruments: config.maxConcurrentInstruments ?? 1,
        // #743: one gate per orchestrator, held across ticks — its per-bar
        // claims are what turn the 2-minute tick into a once-per-bar decision.
        decisionGate: new DebateBarDecisionGate(),
      });

      // #327: both of these degraded modes were previously reached by pure
      // omission — no warn, no log line, no trace. An operator who forgot the
      // config got a system that looked healthy and never learned anything.
      // Warned at STARTUP, not at first use: the first daily cycle is up to
      // 24h away, and "silent for a day" is indistinguishable from "broken".
      const feedback = config.feedback;
      if (feedback === undefined) {
        logger.log({
          trace_id: 'startup',
          stage: 'feedback-loop',
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
        // of the loops started (#371).
        if (feedback.metrics === undefined) {
          logger.log({
            trace_id: 'startup',
            stage: 'feedback-loop',
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
           * #379 — the wired case, announced for the same reason the unwired
           * one is, and in the same place: at startup, once, before anything
           * has run. A detector that will not produce a suite for a calendar
           * quarter (the 60-observation gate, ADR-0006 §5) is not the same
           * thing as a detector that ran and found nothing, and the first daily
           * cycle is up to 24h away from here.
           *
           * `info`, not `warn`: this line says the wiring exists. What is
           * *inert* despite the wiring is warned about immediately below —
           * because removing the "metrics is not set" warn removed the only
           * startup statement that the kill-lines were unevaluated, and
           * replacing one silence with another is the thing #379 must not do.
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
           * The three revalidation-gated lines, stated at startup because
           * nothing else does until a suite exists.
           *
           * `pbo_over_max`, `oos_sharpe_under_min` and `dsr_insignificant` are
           * computed only from `DailyMetricsSample.revalidation`.
           * `SqliteDailyEquityMetricsSource.revalidation()` produces that
           * snapshot (#384) from the frozen Stage 2 selection, so the honest
           * startup statement is CONDITIONAL on the store (#579).
           *
           * The decision itself is `usableRevalidationSelections` — the SAME
           * predicate the metrics source applies — read over the same store,
           * so this line cannot drift from the decision it reports. Stated at
           * startup rather than on the first suite because the first suite is
           * ~60 sessions out (ADR-0006 §5) and a warn that arrives then is a
           * warn nobody reads at the time it matters.
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
           * #375, kept visible where an operator will actually see it.
           *
           * This used to be announced on the first computed suite. With
           * `metrics` unwired that was equivalent — the blanket "all four
           * kill-lines stay unevaluated" warn above covered it — but wiring the
           * source (#379) removes that warn while the gate keeps the first
           * suite ~60 sessions away, so the divergence line's inertness would
           * have gone unannounced for the whole soak. Stated here instead: once
           * per process by construction, since `start()` runs once and the
           * value is frozen config rather than a property of the day.
           */
          if (feedback.metrics.backtest_reference_sharpe <= 0) {
            logger.log({
              trace_id: 'startup',
              stage: 'feedback-loop',
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
        feedbackHandle = setInterval(
          () => runFeedbackCycle(feedback),
          feedback.intervalMs ?? DEFAULT_FEEDBACK_INTERVAL_MS,
        );
      }

      return orphans;
    },

    async stop(): Promise<void> {
      // Timers first, in-flight drain second: nothing new may start while the
      // current pass finishes.
      if (heartbeatHandle !== undefined) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = undefined;
      }
      if (feedbackHandle !== undefined) {
        clearInterval(feedbackHandle);
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
      // tick and a fill poll rather than the longer of the two.
      const stopping = loop?.stop();
      const stoppingFillSync = fillSync?.stop();
      // #753: drained beside the live poller, started before either is awaited,
      // for the same reason the two above are — independent loops, so shutdown
      // takes the longest rather than the sum.
      const stoppingControlFillSync = controlFillSync?.stop();
      // Clearing the timer stops the NEXT GDELT poll, not the one already
      // downloading — and that one ends in an archive write, which without this
      // drain can land after the store is closed. The write is guarded, so this
      // makes shutdown ordering deterministic rather than fixing a crash.
      const drainingGdelt = components.gdeltIngestAgent?.whenIdle();
      // Same ordering argument as the GDELT drain: clearing the timer stops
      // the NEXT poll, not the one already in flight, and that one ends in a
      // store and archive write.
      const drainingPolymarket = components.polymarketAgent.whenIdle();
      loop = undefined;
      fillSync = undefined;
      controlFillSync = undefined;
      // `allSettled`, not two sequential awaits: `buildShutdownHandler`'s doc
      // comment records that `stop()` CAN reject (a pass that rejects after
      // `stop()` captured `inFlight` rejects in the caller too). Awaiting in
      // series would leave the second drain's promise unawaited on that path
      // — an unhandled rejection, and the fill poll's drain silently
      // discarded during shutdown. This still drains both concurrently.
      await Promise.allSettled([
        stopping,
        stoppingFillSync,
        stoppingControlFillSync,
        drainingGdelt,
        drainingPolymarket,
      ]);
    },
  };
}
