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
 * the loosen-approval channel is a transport, so it is selected from
 * `SAMURAI_ALERTS` (alert-transport.ts) and defaults to
 * `LoggingLoosenApprovalChannel` here. Before that, the 14-day soak (#238)
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
  SqliteBrokerStateStore,
  SqliteExecutionStore,
} from '../../pipeline/execution/index.js';
import type {
  BreachAlertChannel,
  DailyMetricsSource,
  FeedbackConfig,
} from '../../pipeline/feedback-loop/index.js';
import {
  computeMetrics,
  runDailyCycle,
  SqliteAdjustmentLog,
  SqliteClosedTradeStore,
  SqliteTuningStore,
  seedAnalystWeights,
} from '../../pipeline/feedback-loop/index.js';
import {
  CircuitBreakers,
  riskThresholdsFrom,
  SqliteBreakerStateStore,
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
  GdeltGkgClient,
  GdeltIngestAgent,
  GrokAgent,
  MarketIntelligenceStore,
  type MiArchiveStore,
  MiIngestAgent,
  NousSentimentClient,
} from '../../providers/market-intelligence/index.js';
import type { AssetClass, Clock, TuningStore } from '../../shared/index.js';
import { resolveVenuePacing, TokenBucket } from '../../shared/index.js';
import { tryNousCredentials } from '../../shared/llm/index.js';
import { SqliteRiskLogStore, SqliteTraderLogStore } from '../../shared/store/index.js';
import { CostModelImpl, SqliteStage2SelectionStore } from '../../tools/backtest/index.js';
import {
  LoggingAnalystSkipAlertChannel,
  LoggingBreachAlertChannel,
  LoggingFlattenOverfillAlertChannel,
  LoggingFlattenReconcileAlertChannel,
  LoggingHeartbeatChannel,
  LoggingLoosenApprovalChannel,
  LoggingOcoDoubleFillAlertChannel,
  LoggingOrphanAlertChannel,
  LoggingResidualExposureAlertChannel,
  LoggingUnpricedFillAlertChannel,
  ParkedCiiScoreProvider,
  UnwiredApprovalChannel,
} from './console-channels.js';
import {
  FILL_SYNC_TRACE_ID,
  RECONCILE_TRACE_ID,
  runStartupReconcile,
  startFillSync,
} from './fill-sync.js';
import { Heartbeat } from './heartbeat.js';
import { JsonLogger } from './logger.js';
import type { OrphanGoVerdict, OrphanVerdictScanner } from './orphan-verdict-scan.js';
import { AlpacaAccountStateProvider } from './production/account-state.js';
import { buildAnalystsStep } from './production/analysts-adapter.js';
import { buildDebateStep } from './production/debate-adapter.js';
import {
  buildExecutionStep,
  buildExecutionSurface,
  buildPersistence,
  buildRiskStep,
  buildTraderStep,
  buildVerdictStep,
  type ExecutionStepDeps,
  type PersistenceInstances,
  type PortfolioSnapshot,
} from './production/direct-bind.js';
import { withOnTradeClose } from './production/on-trade-close-hookup.js';
import { withFlattenTail } from './production/stocks-tick-window.js';
import { MarketDataVolatilityReadingProvider } from './production/volatility-reading-provider.js';
import { UniverseScheduler } from './scheduler.js';
import { SqliteAccountStateStore } from './sqlite-account-state-store.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';
import { SqliteSessionEquityStore } from './sqlite-session-equity-store.js';
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
  buildDefaultAlpacaBrokerClient,
  buildDefaultLlmClient,
  DEFAULT_FEEDBACK_INTERVAL_MS,
  DEFAULT_FILL_POLL_INTERVAL_MS,
  DEFAULT_GDELT_POLL_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_RATE_LIMIT_CONFIG,
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
   * The tuning dials, exposed for `breachAlerts`' reason (#433): the Risk
   * Manager READS `risk_thresholds` here at evaluate time and the Feedback
   * Loop's daily cycle WRITES them, and the two halves of that dial are wired
   * in different functions. Returning the instance beats constructing a second
   * one in `buildProductionOrchestrator`.
   */
  tuning: TuningStore;
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

  const tradingCalendar = equityCalendarFor(config);
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

  const universe = config.universe ?? SMOKE_TEST_UNIVERSE;
  const dataSource =
    config.dataSource ?? buildAlpacaDataSource(config, universe, tradingCalendar, alpacaBucket);
  const marketData: MarketDataService = new MarketDataServiceImpl(
    dataSource,
    clock,
    // `MarketDataServiceImpl`'s mode is live-vs-backtest only; `paper` reads
    // the same live feed `live` does — paper differs at the broker, not at
    // the data source.
    config.mode === 'backtest' ? 'backtest' : 'live',
    new SqliteMarketDataStore(config.db),
  );

  // `MarketIntelligenceStore` starts empty and, as of #464, has a writer: the
  // Grok agent below ingests into THIS instance. Constructed here rather than
  // inline so the agent and the analysts cannot end up holding two different
  // stores — the same reasoning as `setupStore` below, and the same defect
  // (#432) that would otherwise recur.
  const marketIntelligence = new MarketIntelligenceStore(clock);

  const analysts = new AnalystOrchestrator({
    market_intelligence: marketIntelligence,
    market_data: marketData,
  });

  const logger = config.logger ?? new JsonLogger();

  // One instance, both ends of `cosine_setups` (#432): the Trader's `decide`
  // WRITES the setup at decision time and `onTradeClose` LABELS it with the
  // realized R on close. Constructed here rather than inline below so the two
  // halves cannot drift into separate stores.
  const setupStore = new SqliteSetupStore(config.db);

  /**
   * Hoisted above the tick steps (#433). It used to be constructed down in
   * `feedbackStores`, which was fine while the Feedback Loop was its only
   * consumer — but the Risk Manager now READS `risk_thresholds` at evaluate
   * time, and a threshold `autoTighten` writes has to be the same row Risk
   * reads. One instance, both ends of the dial.
   */
  const tuningStore = new SqliteTuningStore(config.db, clock);

  /**
   * Hoisted above `spendCap` (below) rather than left beside the Feedback
   * Loop's stores: the LLM spend cap escalates its breach through this same
   * channel, and a breach that only reaches the log stream is invisible on an
   * unattended run. It depends on nothing but `logger`, so the move is free.
   */
  const breachAlerts = config.breachAlerts ?? new LoggingBreachAlertChannel(logger);

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
    const cap = new SqliteSpendCap(config.db, config.llmBudgetUsd, logger, () =>
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
    new SqliteExecutionStore(config.db),
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
      state: new SqliteBrokerStateStore(config.db),
      // #298: the same store carries the age-out clock for a fill the venue
      // will not price, which is why it must be the durable one here — a
      // restart that reset the clock would age nothing out across a soak.
      unpricedFillAlerts: config.unpricedFillAlerts ?? new LoggingUnpricedFillAlertChannel(logger),
      // #586: the emulated crypto OCO's accepted-risk escalation — required
      // on `AlpacaBrokerAdapterInput` for the same "no silent default"
      // reason `unpricedFillAlerts` is.
      ocoDoubleFillAlerts:
        config.ocoDoubleFillAlerts ?? new LoggingOcoDoubleFillAlertChannel(logger),
      ...(config.unpricedFillAgeOutMs === undefined
        ? {}
        : { unpricedFillAgeOutMs: config.unpricedFillAgeOutMs }),
      clock,
    });
  // The sticky breakers' durable home (#203, review 2026-08-06 B1): loaded
  // here so a trip survives restart, written by every breaker evaluation on
  // the tick path (direct-bind.ts `computeCurrentPortfolioAndBreakers`).
  const breakerStateStore = new SqliteBreakerStateStore(config.db);
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
    // Defaulted, not required (#276): the three sources this needs — Alpaca's
    // account ledger, the durable `account_state` table, and the existing
    // ClosedTrade store — all exist in-repo now, so an injected seam would be
    // asking the caller to build what this module can compose.
    accountState:
      config.accountState ??
      new AlpacaAccountStateProvider({
        client: brokerClient,
        store: new SqliteAccountStateStore(config.db),
        // Per-class session-open equity snapshots (#332) — the local
        // replacement for Alpaca's blended `last_equity` (GAP-8).
        sessionEquity: new SqliteSessionEquityStore(config.db),
        // The append-only daily equity series (#345). Wired unconditionally,
        // and on the same boundary as the snapshot above, because a return
        // series cannot be backfilled: equity not sampled on the day is gone.
        // Capture starts from the first tick of the first run; whether it is
        // ever EVALUATED is a separate, gated decision that lives in
        // `SqliteDailyEquityMetricsSource`.
        dailyEquity: new SqliteDailyEquityStore(config.db),
        // The existing ClosedTrade reader, per spec story 25 — no new
        // realized-PnL ledger is built when one already exists.
        closedTrades: new SqliteClosedTradeStore(config.db),
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
        // duplicated in each consumer" (trading-calendar.ts). The default is
        // weekday-only and reports a session start for holiday Mondays that
        // never traded; when the real holiday/session table lands it is injected
        // HERE, through this same field, and the daily-PnL boundary must follow
        // it. Narrowing the type would pin this consumer to the placeholder
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
    config.llmClient ?? buildDefaultLlmClient(logger, new SqliteLlmSpendStore(config.db, logger));

  const grokAgent =
    sentimentCredentials === undefined
      ? undefined
      : new GrokAgent({
          client: new NousSentimentClient({ ...sentimentCredentials, logger }),
          store: marketIntelligence,
          spendCap,
          spendSink: new SqliteLlmSpendStore(config.db, logger),
          clock,
          logger,
        });

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

  const steps: TickSteps = {
    // `logger` here is what makes an analyst failure visible at all — see the
    // adapter's doc comment (issue #358 item 4).
    analysts: buildAnalystsStep(analysts, logger, {
      skipAlerts: config.analystSkipAlerts ?? new LoggingAnalystSkipAlertChannel(logger),
      // #464: the only writer `MarketIntelligenceStore` has. Absent under
      // SAMURAI_SENTIMENT=off — no agent, no calls, and the analysts keep
      // reporting NO_DATA_MARKER (#463), which is the honest default rather
      // than a silent no-op. The agent's own 4h bucket makes calling it on
      // every pass cheap: it returns immediately unless the bucket rolled.
      // #552: the deterministic path when it is available, the retrieval-era
      // agent only as a fallback. Not a preference — `GrokAgent` ingests `[]`
      // by construction (`retrievalEvidence: false` is hard-coded), which is
      // what pinned both news-fed analysts at confidence 0.05 and produced
      // #625's 0.5478 conviction ceiling.
      ...(miIngestAgent !== undefined
        ? { marketIntelligence: miIngestAgent }
        : grokAgent === undefined
          ? {}
          : { marketIntelligence: grokAgent }),
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
      new SqliteDebateLogStore(config.db),
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
    // downstream record at all.
    trader: buildTraderStep({
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
      traderLog: new SqliteTraderLogStore(config.db),
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
    }),
    risk: buildRiskStep({
      ...breakerStateDeps,
      config: config.riskConfig,
      correlationConfig: config.correlationConfig,
      ciiConsumer,
      riskLog: new SqliteRiskLogStore(config.db),
      // #433: the live dial. Without this Risk freezes its RiskConfig at
      // construction and `autoTighten`'s response to a kill-line breach
      // changes no decision.
      thresholds: tuningStore,
    }),
    verdict: buildVerdictStep({
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
    }),
    execution: buildExecutionStep(executionDeps),
  };

  return {
    steps,
    breachAlerts,
    tuning: tuningStore,
    marketData,
    broker,
    analysts,
    circuitBreakers,
    executionStore,
    executionDeps,
    llmRateLimiter,
    gdeltIngestAgent,
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
 * per-asset-class window BEFORE any call is made, and `SpendCap` (ADR-0008)
 * bounds total dollars. Both are indifferent to which tick a debate belongs to.
 * The global lock was doing rate limiting's job, coarsely, and paying for it in
 * dropped equity ticks.
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
 * The venues genuinely differ per ADR-0015: live equity is the Trading 212 ISA
 * restricted to GBP LSE-listed ETFs/ETCs (#659), while paper runs Alpaca US
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
  let heartbeatHandle: NodeJS.Timeout | undefined;
  let feedbackHandle: NodeJS.Timeout | undefined;
  let gdeltHandle: NodeJS.Timeout | undefined;

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
    tuning: components.tuning,
    adjustments: new SqliteAdjustmentLog(config.db),
  };
  /**
   * #366. Resolved once, outside the timer callback, for `feedbackStores`'
   * reason — and read in the same precedence order the alert channels use: an
   * explicit per-cycle override first, then the transport `SAMURAI_ALERTS`
   * selected, then the log-only stand-in.
   *
   * Whichever wins, none of them can approve: the port returns `void`, so an
   * unanswered request leaves the risk threshold untouched. That is
   * fail-closed, and it is a property of `runDailyCycle` gating the write —
   * not of the channel being trustworthy.
   */
  const loosenApprovals =
    config.feedback?.approvals ??
    config.loosenApprovals ??
    new LoggingLoosenApprovalChannel(logger);

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
  const selectionStore = new SqliteStage2SelectionStore(config.db);

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

  const runFeedbackCycle = (feedback: FeedbackCycleConfig): void => {
    try {
      const result = runDailyCycle({
        clock,
        ...feedbackStores,
        config: feedback.config,
        approvals: loosenApprovals,
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

      // Inside the same try/catch — a throw here must not take the timer down
      // either — and deliberately AFTER the cycle's own log line, so a metrics
      // failure cannot erase the record that the tuning cycle itself
      // succeeded: the 'complete' line is already written by then, and the
      // catch below adds a 'failed' line rather than replacing it.
      if (feedback.metrics !== undefined && metricsSource !== undefined) {
        runMetricsCheck(metricsSource, feedback.metrics, feedback.config);
      }
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
      // Both drains started before either is awaited: they are independent,
      // and awaiting them in series would make shutdown take the sum of a
      // tick and a fill poll rather than the longer of the two.
      const stopping = loop?.stop();
      const stoppingFillSync = fillSync?.stop();
      // Clearing the timer stops the NEXT GDELT poll, not the one already
      // downloading — and that one ends in an archive write, which without this
      // drain can land after the store is closed. The write is guarded, so this
      // makes shutdown ordering deterministic rather than fixing a crash.
      const drainingGdelt = components.gdeltIngestAgent?.whenIdle();
      loop = undefined;
      fillSync = undefined;
      // `allSettled`, not two sequential awaits: `buildShutdownHandler`'s doc
      // comment records that `stop()` CAN reject (a pass that rejects after
      // `stop()` captured `inFlight` rejects in the caller too). Awaiting in
      // series would leave the second drain's promise unawaited on that path
      // — an unhandled rejection, and the fill poll's drain silently
      // discarded during shutdown. This still drains both concurrently.
      await Promise.allSettled([stopping, stoppingFillSync, drainingGdelt]);
    },
  };
}
