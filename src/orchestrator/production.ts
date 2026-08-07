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
import { CostModelImpl, SqliteStage2SelectionStore } from '../cost-model-backtest/index.js';
import type { SpendCap } from '../debate-engine/index.js';
import {
  RateLimiter,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
  SqliteSpendCap,
  UNCAPPED_SPEND,
} from '../debate-engine/index.js';
import type { BrokerAdapter, SharedStore as ExecutionSharedStore } from '../execution/index.js';
import {
  AlpacaBrokerAdapter,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
} from '../execution/index.js';
import type {
  BreachAlertChannel,
  DailyMetricsSource,
  FeedbackConfig,
} from '../feedback-loop/index.js';
import {
  computeMetrics,
  runDailyCycle,
  SqliteAdjustmentLog,
  SqliteClosedTradeStore,
  SqliteTuningStore,
  seedAnalystWeights,
} from '../feedback-loop/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import {
  AlwaysOpenCalendar,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../market-data-service/index.js';
import {
  CiiConsumer,
  GrokAgent,
  MarketIntelligenceStore,
  NousSentimentClient,
} from '../market-intelligence/index.js';
import {
  CircuitBreakers,
  riskThresholdsFrom,
  SqliteBreakerStateStore,
} from '../risk-manager/index.js';
import type { AssetClass, Clock, TuningStore } from '../shared/index.js';
import { resolveVenuePacing, TokenBucket } from '../shared/index.js';
import { tryNousCredentials } from '../shared/llm/index.js';
import { SqliteRiskLogStore, SqliteTraderLogStore } from '../shared/store/index.js';
import { SqliteSetupStore } from '../trader/index.js';
import { assertAutomationLevelSupported } from '../verdict/index.js';
import {
  LoggingAnalystSkipAlertChannel,
  LoggingBreachAlertChannel,
  LoggingHeartbeatChannel,
  LoggingLoosenApprovalChannel,
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
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_RATE_LIMIT_CONFIG,
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_VOLATILITY_INDICATOR,
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

  const tradingCalendar = config.tradingCalendar ?? new UsEquityRegularHoursCalendar();
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
      ...(grokAgent === undefined ? {} : { marketIntelligence: grokAgent }),
    }),
    // Two independent stores hang off this one step, both over `config.db`:
    // #367's `SqliteLlmSpendStore` meters what the debate COSTS (the
    // dashboard's spend tile), and #364's `SqliteDebateLogStore` records what
    // the debate DECIDED. The latter was constructed for the Feedback Loop's
    // `feedbackStores.debate_log` to read and had no writer anywhere in the
    // tick path, so `attribution.ts` had nothing to attribute over the whole
    // soak.
    debate: buildDebateStep(
      config.llmClient ?? buildDefaultLlmClient(logger, new SqliteLlmSpendStore(config.db, logger)),
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
  const heartbeat = new Heartbeat(
    config.heartbeatChannel ?? new LoggingHeartbeatChannel(logger),
    logger,
  );

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
           * computed only from `DailyMetricsSample.revalidation` — a
           * walk-forward/PBO snapshot produced by re-running Stage 2 validation,
           * on its own cadence. `DailyMetricsSource` makes that field optional
           * and the only in-repo implementation
           * (`SqliteDailyEquityMetricsSource`) never sets it: it derives a
           * DAILY suite from the equity series, which is a different thing.
           *
           * So a paper run evaluates none of the three, and that is the
           * statement the old "metrics is not set" warn used to carry. It is
           * unconditional here rather than conditioned on the sample, because
           * the first sample is ~60 sessions out and a warn that arrives then
           * is a warn nobody reads at the time it matters.
           */
          logger.log({
            trace_id: 'startup',
            stage: 'feedback-loop',
            level: 'warn',
            message:
              'pbo_over_max, oos_sharpe_under_min and dsr_insignificant are evaluated ONLY from a ' +
              'revalidation snapshot (DailyMetricsSample.revalidation), which no component in ' +
              'this repo produces — SqliteDailyEquityMetricsSource derives a daily suite from ' +
              'the equity series and never sets it. Expect these three in `not_evaluated` on ' +
              'every cycle: they are un-run, NOT passed.',
            payload: {
              kill_lines_gated_on_revalidation: [
                'pbo_over_max',
                'oos_sharpe_under_min',
                'dsr_insignificant',
              ],
            },
          });

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
      // Both drains started before either is awaited: they are independent,
      // and awaiting them in series would make shutdown take the sum of a
      // tick and a fill poll rather than the longer of the two.
      const stopping = loop?.stop();
      const stoppingFillSync = fillSync?.stop();
      loop = undefined;
      fillSync = undefined;
      // `allSettled`, not two sequential awaits: `buildShutdownHandler`'s doc
      // comment records that `stop()` CAN reject (a pass that rejects after
      // `stop()` captured `inFlight` rejects in the caller too). Awaiting in
      // series would leave the second drain's promise unawaited on that path
      // — an unhandled rejection, and the fill poll's drain silently
      // discarded during shutdown. This still drains both concurrently.
      await Promise.allSettled([stopping, stoppingFillSync]);
    },
  };
}
