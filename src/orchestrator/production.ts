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
 * the LLM provider, the Telegram/Discord trade channel, WorldMonitor's CII
 * feed) exists in the codebase as an *interface only* — there is no HTTP
 * implementation of `AlpacaClient`, `AnthropicMessagesClient`,
 * `TelegramClient`, or `CiiScoreProvider` anywhere in `src/`, and `ccxt` is
 * not a dependency. Writing them here would be implementing three or four
 * components under a wiring ticket. So they are required `ProductionConfig`
 * fields instead: this module composes everything that *can* be composed
 * from in-repo code and names the rest as explicit seams. That is exactly
 * the precedent #234 set one level down with `AccountStateProvider` /
 * `VolatilityReadingProvider` — an honest injected seam beats a fabricated
 * implementation.
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
 * ## Not wired here (and why), per ADR-0004 §3
 *
 * ADR-0004 asks for Feedback Loop's `onTradeClose` and `runDailyCycle` at
 * this composition point, "not as `TickSteps` members". `runDailyCycle` is
 * wired, on its own daily timer independent of the tick chain, and starts
 * only when `ProductionConfig.feedback` supplies the two inputs with no
 * in-repo source (its `FeedbackConfig` values and the loosen-approval
 * channel); its four stores are all SQLite-backed and constructed here.
 * `onTradeClose` is **not** wired: it takes a `ClosedTrade`, and
 * `ExecutionResult` is not one — a `ClosedTrade` is emitted by
 * `ingestFills()` writing to the store on a round-trip-to-flat, with no
 * in-process event to subscribe to and no fill-polling loop in the codebase
 * to host the hook. Wiring it needs a trade-close event source that does not
 * exist yet; inventing one here would be new Execution behaviour under a
 * wiring ticket. Flagged as a follow-up rather than faked.
 */
import { AnalystOrchestrator } from '../analysts/index.js';
import { CostModelImpl } from '../cost-model-backtest/cost-model.js';
import type { CostConfig } from '../cost-model-backtest/types.js';
import type { LlmClient } from '../debate-engine/llm/types.js';
import { SqliteDebateLogStore } from '../debate-engine/sqlite-debate-log-store.js';
import { AlpacaBrokerAdapter } from '../execution/adapters/alpaca-adapter.js';
import type { AlpacaClient as AlpacaBrokerClient } from '../execution/adapters/alpaca-client.js';
import { SqliteExecutionStore } from '../execution/sqlite-shared-store.js';
import type { BrokerAdapter, ExecutionConfig } from '../execution/types.js';
import { runDailyCycle } from '../feedback-loop/daily-cycle.js';
import { SqliteAdjustmentLog } from '../feedback-loop/sqlite-adjustment-log.js';
import { SqliteClosedTradeStore } from '../feedback-loop/sqlite-closed-trade-store.js';
import { SqliteTuningStore } from '../feedback-loop/sqlite-tuning-store.js';
import type {
  FeedbackConfig,
  LoosenApprovalChannel,
  TuningProposal,
} from '../feedback-loop/types.js';
import type { MarketDataService } from '../market-data-service/index.js';
import { MarketDataServiceImpl } from '../market-data-service/service.js';
import type { AlpacaClient as AlpacaDataClient } from '../market-data-service/sources/alpaca-source.js';
import { AlpacaDataSource } from '../market-data-service/sources/alpaca-source.js';
import { SqliteMarketDataStore } from '../market-data-service/sqlite-market-data-store.js';
import {
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../market-data-service/trading-calendar.js';
import { MarketIntelligenceStore } from '../market-intelligence/index.js';
import {
  CiiConsumer,
  type CiiConsumerConfig,
  type CiiScoreProvider,
} from '../market-intelligence/worldmonitor-adapter/cii-consumer.js';
import { type BreakerConfig, CircuitBreakers } from '../risk-manager/breakers.js';
import type { CorrelationConfig } from '../risk-manager/correlation.js';
import type { PersistedBreakerState, RiskConfig } from '../risk-manager/types.js';
import type { Clock } from '../shared/clock.js';
import type { SharedStore as SqliteHandle } from '../shared/store/open-shared-store.js';
import type { TraderConfig } from '../trader/types.js';
import type { ApprovalChannel, VerdictConfig } from '../verdict/types.js';
import { Heartbeat, type HeartbeatChannel } from './heartbeat.js';
import { JsonLogger } from './logger.js';
import type {
  OrphanAlertChannel,
  OrphanGoVerdict,
  OrphanVerdictScanner,
} from './orphan-verdict-scan.js';
import { buildAnalystsStep } from './production/analysts-adapter.js';
import { buildDebateStep } from './production/debate-adapter.js';
import {
  type AccountStateProvider,
  buildExecutionStep,
  buildPersistence,
  buildRiskStep,
  buildTraderStep,
  buildVerdictStep,
  type PersistenceInstances,
  type VolatilityReadingProvider,
} from './production/direct-bind.js';
import { UniverseScheduler } from './scheduler.js';
import { runTickPlan } from './tick-loop.js';
import { SequentialTickRunner } from './tick-runner.js';
import type { Logger, Scheduler, TickRunner, TickSteps, UniverseInstrument } from './types.js';

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
 * Everything the composition root cannot build from in-repo code. See the
 * file doc comment for why the transports are injected rather than
 * constructed.
 */
export interface ProductionConfig {
  /** The shared SQLite handle (`openSharedStore(...)`) every store here is built over. */
  db: SqliteHandle;
  clock: Clock;
  /** `paper` for the first run; `live` only after graduation (CLAUDE.md). */
  mode: 'live' | 'paper' | 'backtest';

  // --- Transports with no in-repo implementation (see file doc comment) ---
  /** Alpaca trading REST surface, for order submission. */
  alpacaBrokerClient: AlpacaBrokerClient;
  /** Alpaca market-data REST surface, for bars and latest quotes. */
  alpacaDataClient: AlpacaDataClient;
  /** LLM provider behind the Debate personas (and, indirectly, disagreement detection). */
  llmClient: LlmClient;
  /** Trade channel the dead-man's-switch heartbeat posts over. */
  heartbeatChannel: HeartbeatChannel;
  /** HITL approval round-trip (Verdict gate 6). */
  approvals: ApprovalChannel;
  /** Where a restart-time orphaned `go` verdict is reported. */
  orphanAlerts: OrphanAlertChannel;
  /** WorldMonitor CII reads (ADR-0002; live wiring parked during paper trading). */
  ciiScoreProvider: CiiScoreProvider;
  /** Account accounting scalars — no in-repo realized-PnL tracker (#234). */
  accountState: AccountStateProvider;
  /** Realized-vol reading for the volatility breaker tier — no in-repo indicator (#234). */
  volatility: VolatilityReadingProvider;

  // --- Stage configuration (shapes, not values — tuned in paper trading) ---
  traderConfig: TraderConfig;
  riskConfig: RiskConfig;
  verdictConfig: VerdictConfig;
  executionConfig: ExecutionConfig;
  correlationConfig: CorrelationConfig;
  breakerConfig: BreakerConfig;
  costConfig: CostConfig;
  ciiConsumerConfig: CiiConsumerConfig;

  // --- Optional composition knobs ---
  /**
   * Defaults to `SMOKE_TEST_UNIVERSE`. Widening to `DEFAULT_UNIVERSE` also
   * needs a multi-asset-class data source (see `dataSourceAssetClass`).
   */
  universe?: readonly UniverseInstrument[];
  /**
   * `AlpacaDataSource` normalizes for exactly one asset class (its calendar
   * is chosen at construction), so a single instance cannot serve a mixed
   * universe. Defaults to `'crypto'`, matching `SMOKE_TEST_UNIVERSE`. A
   * routing data source that fans across asset classes is a follow-up, not
   * something to invent under a wiring ticket.
   */
  dataSourceAssetClass?: 'crypto' | 'stocks';
  /** Session calendar for stock gating (scheduler + Verdict gate). */
  tradingCalendar?: TradingCalendar;
  /** Sticky breaker rows recovered from a prior process, if any. */
  initialBreakerState?: readonly PersistedBreakerState[];
  /** Wall-clock gap between tick starts. Default 60s. */
  tickIntervalMs?: number;
  /** Heartbeat cadence, independent of the tick cadence. Default 60s. */
  heartbeatIntervalMs?: number;
  /** Bounds concurrent instrument passes within one tick (LLM rate limit). Default 1. */
  maxConcurrentInstruments?: number;
  /**
   * Feedback Loop's daily batch (ADR-0004 §3: wired at this composition
   * point, deliberately *not* as a `TickSteps` member — it runs on its own
   * schedule, not per instrument). Optional because its two remaining inputs
   * have no in-repo source: `FeedbackConfig`'s values are tuned in paper
   * trading, and `LoosenApprovalChannel` is another human-facing transport
   * with no implementation. Its four stores are all SQLite-backed and built
   * here. Omit it and the daily timer simply never starts.
   */
  feedback?: FeedbackCycleConfig;
  logger?: Logger;
  /** Injected for tests; production uses the real timer functions. */
  timers?: LoopTimers;
}

export interface FeedbackCycleConfig {
  config: FeedbackConfig;
  approvals: LoosenApprovalChannel;
  /**
   * Param/threshold moves to consider this cycle. Empty is a valid, meaningful
   * cycle: analyst weights are attributed from closed trades, not proposed.
   */
  proposals?: TuningProposal[];
  /** Default 24h. */
  intervalMs?: number;
}

/** `setTimeout`/`setInterval` as an injected seam so the loop is testable under fake timers. */
export interface LoopTimers {
  setTimeout: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (handle: NodeJS.Timeout) => void;
  setInterval: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (handle: NodeJS.Timeout) => void;
}

const REAL_TIMERS: LoopTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle),
};

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_FEEDBACK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

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
  /**
   * Runs the orphan scan once, then starts the heartbeat interval and the
   * tick loop. Resolves once startup is done — the loop keeps running after.
   */
  start(): Promise<OrphanGoVerdict[]>;
  /** Stops the loop and the heartbeat. Idempotent. */
  stop(): void;
}

/** Everything composed from in-repo code, built exactly once per process. */
export interface ProductionComponents {
  steps: TickSteps;
  marketData: MarketDataService;
  broker: BrokerAdapter;
  analysts: AnalystOrchestrator;
  circuitBreakers: CircuitBreakers;
  executionStore: SqliteExecutionStore;
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
export function buildProductionComponents(config: ProductionConfig): ProductionComponents {
  const clock = config.clock;
  const tradingCalendar = config.tradingCalendar ?? new UsEquityRegularHoursCalendar();

  const dataSource = new AlpacaDataSource(config.alpacaDataClient, {
    asset_class: config.dataSourceAssetClass ?? 'crypto',
    calendar: config.tradingCalendar,
  });
  const marketData: MarketDataService = new MarketDataServiceImpl(
    dataSource,
    clock,
    // `MarketDataServiceImpl`'s mode is live-vs-backtest only; `paper` reads
    // the same live feed `live` does — paper differs at the broker, not at
    // the data source.
    config.mode === 'backtest' ? 'backtest' : 'live',
    new SqliteMarketDataStore(config.db),
  );

  // `MarketIntelligenceStore` is deliberately empty at construction: it is an
  // in-memory, restart-clean seam that DeepResearch/Grok agents ingest into
  // (market-intelligence/index.ts), and no such agent runs in this process
  // yet. Analysts that need intelligence degrade per their own spec rather
  // than this module inventing items to seed it with.
  const analysts = new AnalystOrchestrator({
    market_intelligence: new MarketIntelligenceStore(clock),
    market_data: marketData,
  });

  const executionStore = new SqliteExecutionStore(config.db);
  const broker = new AlpacaBrokerAdapter({ client: config.alpacaBrokerClient });
  const circuitBreakers = new CircuitBreakers(config.breakerConfig, config.initialBreakerState);
  const ciiConsumer = new CiiConsumer(config.ciiScoreProvider, clock, config.ciiConsumerConfig);

  // Shared by the trader/risk/verdict binds: all three derive the current
  // portfolio + breaker state from the same sources, fetched fresh at their
  // own call time (#234).
  const breakerStateDeps = {
    marketData,
    circuitBreakers,
    accountState: config.accountState,
    volatility: config.volatility,
    getOpenPositions: () => executionStore.getOpenPositions(),
    mode: config.mode,
  };

  const steps: TickSteps = {
    analysts: buildAnalystsStep(analysts),
    debate: buildDebateStep(config.llmClient),
    trader: buildTraderStep({ ...breakerStateDeps, config: config.traderConfig }),
    risk: buildRiskStep({
      ...breakerStateDeps,
      config: config.riskConfig,
      correlationConfig: config.correlationConfig,
      ciiConsumer,
    }),
    verdict: buildVerdictStep({
      ...breakerStateDeps,
      tradingCalendar,
      // Verdict's `PositionStore.findByKey` is a strict subset of Execution's
      // `SharedStore`; one store instance serves both rather than opening a
      // second connection with a divergent view of the same table.
      positionStore: executionStore,
      config: config.verdictConfig,
      approvals: config.approvals,
    }),
    execution: buildExecutionStep({
      clock,
      broker,
      store: executionStore,
      costModel: new CostModelImpl(config.costConfig),
      marketData,
      config: config.executionConfig,
      mode: config.mode,
    }),
  };

  return { steps, marketData, broker, analysts, circuitBreakers, executionStore };
}

/** The ticket's literal signature: all six stages bound into one runner. */
export function buildProductionTickRunner(config: ProductionConfig): SequentialTickRunner {
  return new SequentialTickRunner(buildProductionComponents(config).steps);
}

/**
 * The tick loop. Self-scheduling (`setTimeout` after each tick completes)
 * rather than `setInterval`, plus an explicit in-flight guard: a tick that
 * outruns `tickIntervalMs` must not have a second tick stacked behind it.
 * Overlapping ticks would multiply concurrent LLM calls beyond
 * `max_concurrent_instruments`' cap — the cap bounds instruments *within* a
 * tick and knows nothing about ticks racing each other — and CLAUDE.md
 * treats LLM rate limiting as a hard stop. Belt and braces: the guard also
 * covers a caller supplying its own timer seam that fires eagerly.
 *
 * The first tick fires one interval after `start()`, not immediately: startup
 * (orphan scan, heartbeat) should settle before the first pipeline pass, and
 * a tick at t=0 would race the scan's read of `audit_log` against the
 * runner's first write to it.
 */
export function startTickLoop(deps: {
  scheduler: Scheduler;
  runner: TickRunner;
  clock: Clock;
  logger: Logger;
  persistence: PersistenceInstances;
  tickIntervalMs: number;
  maxConcurrentInstruments: number;
  timers?: LoopTimers;
}): { stop: () => void } {
  const timers = deps.timers ?? REAL_TIMERS;
  let stopped = false;
  let inFlight = false;
  let handle: NodeJS.Timeout | undefined;

  const runOnce = async (): Promise<void> => {
    if (inFlight) {
      deps.logger.log({
        trace_id: 'tick-loop',
        stage: 'tick-loop',
        level: 'warn',
        message: 'tick skipped: previous tick still running',
      });
      return;
    }
    inFlight = true;
    try {
      const plan = deps.scheduler.nextTick(deps.clock);
      await runTickPlan(plan, deps.runner, deps.clock, {
        max_concurrent_instruments: deps.maxConcurrentInstruments,
        logger: deps.logger,
        auditLog: deps.persistence.auditLog,
        currentTickStore: deps.persistence.currentTickStore,
      });
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
    } finally {
      inFlight = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      void runOnce().then(schedule);
    }, deps.tickIntervalMs);
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
    },
  };
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
  const scheduler = new UniverseScheduler({
    universe: config.universe ?? SMOKE_TEST_UNIVERSE,
    calendar: config.tradingCalendar ?? new UsEquityRegularHoursCalendar(),
  });
  const heartbeat = new Heartbeat(config.heartbeatChannel, logger);

  const timers = config.timers ?? REAL_TIMERS;
  let loop: { stop: () => void } | undefined;
  let heartbeatHandle: NodeJS.Timeout | undefined;
  let feedbackHandle: NodeJS.Timeout | undefined;

  /**
   * Feedback Loop's daily batch on its own timer — not a `TickSteps` member
   * (ADR-0004 §3). Synchronous and store-driven, so a throw here would take
   * the timer callback down with it; caught and logged for the same reason
   * the tick loop catches (one bad cycle must not end the run).
   */
  const runFeedbackCycle = (feedback: FeedbackCycleConfig): void => {
    try {
      const result = runDailyCycle({
        clock,
        trades: new SqliteClosedTradeStore(config.db),
        debate_log: new SqliteDebateLogStore(config.db),
        tuning: new SqliteTuningStore(config.db, clock),
        adjustments: new SqliteAdjustmentLog(config.db),
        config: feedback.config,
        approvals: feedback.approvals,
        proposals: feedback.proposals ?? [],
        mode: config.mode,
      });
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'info',
        message: 'daily feedback cycle complete',
        payload: result,
      });
    } catch (error) {
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'error',
        message: 'daily feedback cycle failed',
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
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

    async start(): Promise<OrphanGoVerdict[]> {
      const orphans = await persistence.orphanScanner.scan(config.db, config.orphanAlerts, logger);

      heartbeatHandle = timers.setInterval(() => {
        void heartbeat.emit(clock);
      }, config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

      loop = startTickLoop({
        scheduler,
        runner: tickRunner,
        clock,
        logger,
        persistence,
        tickIntervalMs: config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
        maxConcurrentInstruments: config.maxConcurrentInstruments ?? 1,
        timers,
      });

      const feedback = config.feedback;
      if (feedback !== undefined) {
        feedbackHandle = timers.setInterval(
          () => runFeedbackCycle(feedback),
          feedback.intervalMs ?? DEFAULT_FEEDBACK_INTERVAL_MS,
        );
      }

      return orphans;
    },

    stop(): void {
      loop?.stop();
      loop = undefined;
      if (heartbeatHandle !== undefined) {
        timers.clearInterval(heartbeatHandle);
        heartbeatHandle = undefined;
      }
      if (feedbackHandle !== undefined) {
        timers.clearInterval(feedbackHandle);
        feedbackHandle = undefined;
      }
    },
  };
}
