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
 * the Telegram/Discord trade channel, WorldMonitor's CII feed) exists in the
 * codebase as an *interface only* — there is no HTTP implementation of
 * `AlpacaClient`, `TelegramClient`, or `CiiScoreProvider` anywhere in `src/`,
 * and `ccxt` is not a dependency. Writing them here would be implementing
 * three or four components under a wiring ticket. So they are required
 * `ProductionConfig` fields instead: this module composes everything that
 * *can* be composed from in-repo code and names the rest as explicit seams.
 * That is exactly the precedent #234 set one level down with
 * `AccountStateProvider` / `VolatilityReadingProvider` — an honest injected
 * seam beats a fabricated implementation.
 *
 * The LLM provider is the one exception: since #274, `AnthropicHttpMessagesClient`
 * (debate-engine/llm/anthropic-http-client.ts) is a real, in-repo
 * `AnthropicMessagesClient` implementation, so this module builds the
 * `AnthropicLlmClient` Debate/disagreement-detection close over by default —
 * `ProductionConfig.llmClient` is now an optional override (same shape as
 * `broker`/`dataSource` below), not a required seam. The default reads
 * `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` from the environment (see
 * `buildDefaultLlmClient`), which logs a `warn` at build time so a live
 * client being constructed — real per-call spend — is never silent.
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
 * only when `ProductionConfig.feedback` supplies the two inputs with no
 * in-repo source (its `FeedbackConfig` values and the loosen-approval
 * channel); its four stores are all SQLite-backed and constructed here.
 * `onTradeClose` IS wired (#237, superseding this file's earlier note that it
 * was not): a `ClosedTrade` is never reachable from `TickOutcome.execution_result`
 * (`ExecutionImpl.execute()` returns a submission ack only, and
 * `intent_type: 'exit'` is unimplemented — #82/#83) — the only place one is
 * ever produced is `ingestFills()` calling `SharedStore.writeClosedTrade()`
 * (src/execution/ingest-fills.ts), on its own polling path. So
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
import { AnalystOrchestrator } from '../analysts/index.js';
import type { CostConfig } from '../cost-model-backtest/index.js';
import { CostModelImpl } from '../cost-model-backtest/index.js';
import type { AnthropicLlmClientConfig, LlmClient } from '../debate-engine/index.js';
import {
  AnthropicHttpMessagesClient,
  AnthropicLlmClient,
  DEFAULT_ANTHROPIC_MODEL,
  SqliteDebateLogStore,
} from '../debate-engine/index.js';
import type {
  AlpacaClient as AlpacaBrokerClient,
  BrokerAdapter,
  ExecutionConfig,
  SharedStore as ExecutionSharedStore,
} from '../execution/index.js';
import { AlpacaBrokerAdapter, SqliteExecutionStore } from '../execution/index.js';
import type {
  FeedbackConfig,
  LoosenApprovalChannel,
  TuningProposal,
} from '../feedback-loop/index.js';
import {
  runDailyCycle,
  SqliteAdjustmentLog,
  SqliteClosedTradeStore,
  SqliteTuningStore,
} from '../feedback-loop/index.js';
import type {
  AlpacaClient as AlpacaDataClient,
  DataSource,
  MarketDataService,
} from '../market-data-service/index.js';
import {
  AlpacaDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../market-data-service/index.js';
import {
  CiiConsumer,
  type CiiConsumerConfig,
  type CiiScoreProvider,
  MarketIntelligenceStore,
} from '../market-intelligence/index.js';
import type {
  CorrelationConfig,
  PersistedBreakerState,
  RiskConfig,
} from '../risk-manager/index.js';
import { type BreakerConfig, CircuitBreakers } from '../risk-manager/index.js';
import type { Clock } from '../shared/index.js';
import { TokenBucket } from '../shared/index.js';
import type { SharedStore as SqliteHandle } from '../shared/store/index.js';
import type { TraderConfig } from '../trader/index.js';
import { SqliteSetupStore } from '../trader/index.js';
import type { ApprovalChannel, VerdictConfig } from '../verdict/index.js';
import {
  FILL_SYNC_TRACE_ID,
  RECONCILE_TRACE_ID,
  runStartupReconcile,
  startFillSync,
} from './fill-sync.js';
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
  buildExecutionSurface,
  buildPersistence,
  buildRiskStep,
  buildTraderStep,
  buildVerdictStep,
  type ExecutionStepDeps,
  type PersistenceInstances,
  type VolatilityReadingProvider,
} from './production/direct-bind.js';
import { withOnTradeClose } from './production/on-trade-close-hookup.js';
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
  /**
   * Trade channel the dead-man's-switch heartbeat posts over. Taken as the
   * port, not as a Telegram/Discord client: `TradeChannelHeartbeat`
   * (heartbeat-channel.ts) is the in-repo implementation to pass here, and it
   * still needs a `TelegramClient` that this codebase does not implement.
   */
  heartbeatChannel: HeartbeatChannel;
  /**
   * HITL approval round-trip (Verdict gate 6). Same shape as
   * `heartbeatChannel`: pass `SignedApprovalChannel`
   * (verdict/notifications/verified-approval-channel.ts) so #207's HMAC
   * verification is in the path — the composition root cannot construct it
   * for you, because its `ApprovalRequestSender` leaf is another
   * unimplemented transport.
   */
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
  /**
   * Overrides the `AlpacaBrokerAdapter` this module would otherwise build.
   * The `BrokerAdapter` port is dual-target by design (ADR-0001) — this is
   * where `SimulatedBrokerAdapter` (backtest, and the composed-chain
   * integration test) or a future ccxt/IBKR adapter binds without the
   * composition root growing a broker-selection branch.
   */
  broker?: BrokerAdapter;
  /**
   * Overrides the `AlpacaDataSource` this module would otherwise build —
   * same rationale as `broker`, for `FixtureDataSource`/ccxt/IBKR.
   */
  dataSource?: DataSource;
  /**
   * Overrides the `AnthropicLlmClient` this module would otherwise build
   * around `AnthropicHttpMessagesClient` (#274) — same rationale as
   * `broker`/`dataSource`, for tests (`MockLlmClient`) or a future non-
   * Anthropic provider. When omitted, the default reads `ANTHROPIC_API_KEY`
   * (required) and `ANTHROPIC_MODEL` (optional, defaults to
   * `DEFAULT_ANTHROPIC_MODEL`) from the environment — and logs a `warn` via
   * `ProductionConfig.logger` at build time, since this silently turns on
   * real, billed Anthropic API calls whenever the key happens to be set.
   */
  llmClient?: LlmClient;
  /** Session calendar for stock gating (scheduler + Verdict gate). */
  tradingCalendar?: TradingCalendar;
  /** Sticky breaker rows recovered from a prior process, if any. */
  initialBreakerState?: readonly PersistedBreakerState[];
  /** Wall-clock gap between tick starts. Default 60s. */
  tickIntervalMs?: number;
  /** Heartbeat cadence, independent of the tick cadence. Default 60s. */
  heartbeatIntervalMs?: number;
  /**
   * Gap between fill polls (`ingestFills()`), measured from the end of one
   * poll to the start of the next. Default 15s — deliberately tighter than
   * the tick cadence: a lot's protective legs are resized from cumulative
   * filled quantity, so the poll interval is how long a partially-filled lot
   * can sit under-protected. Each poll costs one `getOrder` per open bracket
   * against the adapter's token bucket, which is what bounds how low this can
   * usefully go.
   */
  fillPollIntervalMs?: number;
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

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_FILL_POLL_INTERVAL_MS = 15_000;
const DEFAULT_FEEDBACK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Debate/disagreement-detection's LLM knobs (max tokens, per-attempt
 * timeout, retry budget) are not yet exposed as their own `ProductionConfig`
 * field — no ticket has asked for them to be tuned independently of these
 * defaults, which match the values `disagreement-detector.integration.test.ts`
 * already exercises against the real API. `model` is the one knob threaded
 * from the environment (#274 AC), since a stale/rotated model id is the one
 * failure mode ops needs to fix without a redeploy.
 */
/** Exported for `production.test.ts` — asserts the actual retry/timeout budget wired into the live default, not just the model threaded through the startup warn log (PR #284 review). */
export const DEFAULT_LLM_CLIENT_CONFIG: Omit<AnthropicLlmClientConfig, 'model'> = {
  max_tokens: 1024,
  timeoutMs: 30_000,
  retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
};

/**
 * The default `LlmClient`: `AnthropicHttpMessagesClient` (#274, real
 * `fetch`-based `AnthropicMessagesClient`) wrapped in the pre-existing
 * `AnthropicLlmClient` (retry/timeout/error-classification/prompt-safety
 * unchanged by this ticket). `ANTHROPIC_MODEL` overrides
 * `DEFAULT_ANTHROPIC_MODEL`; `ANTHROPIC_API_KEY` is read by
 * `AnthropicHttpMessagesClient` itself (and throws if absent) rather than
 * duplicated here.
 *
 * `AnthropicHttpMessagesClient` keeps its own default `fetchWithTimeout`
 * budget rather than being handed `config.timeoutMs` here: that value already
 * governs the outer race in `AnthropicLlmClient.callWithTimeout`, which starts
 * its timer strictly before `createMessage()` is even called, so it is the
 * one that actually decides a slow call's `LlmTimeoutError`. Threading the
 * same number into the inner `fetchWithTimeout` as well would invite exactly
 * that ambiguity — two timers racing on an identical deadline — for no
 * observable benefit; the inner timeout stays a wider, independent backstop
 * so an in-flight request is not left dangling after the outer race settles.
 */
/** Exported for `production.test.ts` — lets the test assert the constructed client's actual shape (instance type, model, retry/timeout config) rather than only the startup warn log's side effect (PR #284 review). */
export function buildDefaultLlmClient(logger: Logger): LlmClient {
  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  // Loud, not silent: omitting `ProductionConfig.llmClient` now means a real,
  // billed Anthropic API call per debate round rather than a required seam
  // (kimi-3-review on #284) — this is the one signal that the live default
  // was built instead of a test/mock override.
  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: 'warn',
    message:
      'ProductionConfig.llmClient not supplied — building live AnthropicHttpMessagesClient default',
    payload: { model },
  });
  const config: AnthropicLlmClientConfig = {
    ...DEFAULT_LLM_CLIENT_CONFIG,
    model,
  };
  const client = new AnthropicHttpMessagesClient();
  return new AnthropicLlmClient(client, config);
}

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
  marketData: MarketDataService;
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

  const dataSource =
    config.dataSource ??
    new AlpacaDataSource(config.alpacaDataClient, {
      asset_class: config.dataSourceAssetClass ?? 'crypto',
      calendar: tradingCalendar,
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

  const logger = config.logger ?? new JsonLogger();
  // Hooked once, shared everywhere below (see `ProductionComponents.executionStore`'s
  // doc): `getOpenPositions`, Verdict's `positionStore` and Execution's
  // `store` all read/write through this same instance, so `onTradeClose`
  // fires no matter which of them eventually calls `writeClosedTrade`.
  const executionStore = withOnTradeClose(
    new SqliteExecutionStore(config.db),
    { setup_store: new SqliteSetupStore(config.db) },
    logger,
  );
  // Token bucket sized under Alpaca's 200 req/min (execution-spec.md story
  // 16): burst covers a bracket submit plus a fill poll, sustained rate stays
  // at ~90/min so the data-side calls sharing the account limit fit too.
  const broker =
    config.broker ??
    new AlpacaBrokerAdapter({
      client: config.alpacaBrokerClient,
      rateLimiter: new TokenBucket({ capacity: 10, refillPerSecond: 1.5 }),
    });
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
  };

  const steps: TickSteps = {
    analysts: buildAnalystsStep(analysts),
    debate: buildDebateStep(config.llmClient ?? buildDefaultLlmClient(logger)),
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
    execution: buildExecutionStep(executionDeps),
  };

  return { steps, marketData, broker, analysts, circuitBreakers, executionStore, executionDeps };
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
}): { stop: () => Promise<void> } {
  let stopped = false;
  /** The current pass, so `stop()` can await it instead of abandoning it mid-pipeline. */
  let inFlight: Promise<void> | undefined;
  let handle: NodeJS.Timeout | undefined;

  const runOnce = async (): Promise<void> => {
    if (inFlight !== undefined) {
      deps.logger.log({
        trace_id: 'tick-loop',
        stage: 'tick-loop',
        level: 'warn',
        message: 'tick skipped: previous tick still running',
      });
      return;
    }
    try {
      const plan = deps.scheduler.nextTick(deps.clock);
      inFlight = runTickPlan(plan, deps.runner, deps.clock, {
        max_concurrent_instruments: deps.maxConcurrentInstruments,
        logger: deps.logger,
        auditLog: deps.persistence.auditLog,
        currentTickStore: deps.persistence.currentTickStore,
      }).then(() => undefined);
      await inFlight;
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
      inFlight = undefined;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    handle = setTimeout(() => {
      void runOnce().then(schedule);
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
      // `runOnce` swallows its own errors, so this only ever waits.
      await inFlight;
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

  let loop: { stop: () => Promise<void> } | undefined;
  let fillSync: { stop: () => Promise<void> } | undefined;
  let heartbeatHandle: NodeJS.Timeout | undefined;
  let feedbackHandle: NodeJS.Timeout | undefined;

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
    trades: new SqliteClosedTradeStore(config.db),
    debate_log: new SqliteDebateLogStore(config.db),
    tuning: new SqliteTuningStore(config.db, clock),
    adjustments: new SqliteAdjustmentLog(config.db),
  };
  const runFeedbackCycle = (feedback: FeedbackCycleConfig): void => {
    try {
      const result = runDailyCycle({
        clock,
        ...feedbackStores,
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

      // Reconcile BEFORE the tick loop and before the first fill poll, and
      // awaited rather than fired off. A crash leaves lots stranded
      // `pending`/`submitted`, and starting to trade against a store that
      // still disagrees with the venue is what reconcile exists to prevent —
      // so a failure here propagates out of `start()` instead of being
      // logged and stepped over.
      await runStartupReconcile({ execution: reconcileExecution, logger });

      heartbeatHandle = setInterval(() => {
        void heartbeat.emit(clock);
      }, config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

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
      });

      const feedback = config.feedback;
      if (feedback !== undefined) {
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
      // Both drains started before either is awaited: they are independent,
      // and awaiting them in series would make shutdown take the sum of a
      // tick and a fill poll rather than the longer of the two.
      const stopping = loop?.stop();
      const stoppingFillSync = fillSync?.stop();
      loop = undefined;
      fillSync = undefined;
      await stopping;
      await stoppingFillSync;
    },
  };
}
