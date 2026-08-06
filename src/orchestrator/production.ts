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
 * `AlpacaHttpDataClient` (#273/#286) and `AnthropicHttpMessagesClient` (#274)
 * are built here by default, and `TelegramBotApiClient` (#275) is built one
 * level up, in `startFromEnvironment`, and passed in as the three alert
 * channels below (#322 — see alert-transport.ts for why the *selection*
 * belongs at the entrypoint rather than here). `CiiScoreProvider` is the one
 * genuinely unimplemented transport left, deliberately parked (ADR-0002).
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
import type { CostConfig } from '../cost-model-backtest/index.js';
import { CostModelImpl } from '../cost-model-backtest/index.js';
import type {
  AnthropicLlmClientConfig,
  LlmClient,
  LlmSpendSink,
  RateLimiterConfig,
  SpendCap,
} from '../debate-engine/index.js';
import {
  AnthropicHttpMessagesClient,
  AnthropicLlmClient,
  DEFAULT_ANTHROPIC_MODEL,
  RateLimiter,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
  SqliteSpendCap,
  UNCAPPED_SPEND,
} from '../debate-engine/index.js';
import type {
  AlpacaClient as AlpacaBrokerClient,
  AlpacaTradingEnvironment,
  BrokerAdapter,
  ExecutionConfig,
  SharedStore as ExecutionSharedStore,
  UnpricedFillAlertChannel,
} from '../execution/index.js';
import {
  AlpacaBrokerAdapter,
  AlpacaHttpBrokerClient,
  classifyAlpacaTradingHost,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
} from '../execution/index.js';
import type {
  BreachAlertChannel,
  DailyMetricsSource,
  FeedbackConfig,
  LoosenApprovalChannel,
  TuningProposal,
} from '../feedback-loop/index.js';
import {
  computeMetrics,
  runDailyCycle,
  SqliteAdjustmentLog,
  SqliteClosedTradeStore,
  SqliteTuningStore,
  seedAnalystWeights,
} from '../feedback-loop/index.js';
import type {
  AlpacaClient as AlpacaDataClient,
  DataSource,
  IndicatorSpec,
  MarketDataService,
} from '../market-data-service/index.js';
import {
  AlpacaDataSource,
  AlpacaHttpDataClient,
  AlwaysOpenCalendar,
  AssetClassRoutingDataSource,
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
import type { AssetClass, Clock, ClosedTradeStore, VenuePacingConfig } from '../shared/index.js';
import { resolveVenuePacing, TokenBucket } from '../shared/index.js';
import type { SharedStore as SqliteHandle } from '../shared/store/index.js';
import type { TraderConfig } from '../trader/index.js';
import { SqliteSetupStore } from '../trader/index.js';
import type { ApprovalChannel, VerdictConfig } from '../verdict/index.js';
import {
  LoggingBreachAlertChannel,
  LoggingHeartbeatChannel,
  LoggingLoosenApprovalChannel,
  LoggingOrphanAlertChannel,
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
import { Heartbeat, type HeartbeatChannel } from './heartbeat.js';
import { JsonLogger } from './logger.js';
import type {
  OrphanAlertChannel,
  OrphanGoVerdict,
  OrphanVerdictScanner,
} from './orphan-verdict-scan.js';
import { AlpacaAccountStateProvider } from './production/account-state.js';
import { buildAnalystsStep } from './production/analysts-adapter.js';
import { buildDebateStep, WORST_CASE_LLM_CALLS_PER_DEBATE } from './production/debate-adapter.js';
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
  /**
   * Alpaca trading REST surface, for order submission. Optional since #273/
   * #286 landed `AlpacaHttpBrokerClient`: when omitted this module builds it
   * with the endpoint derived from `mode` (see
   * `buildDefaultAlpacaBrokerClient` — a live host from a non-live mode is
   * refused, #293).
   */
  alpacaBrokerClient?: AlpacaBrokerClient;
  /**
   * Alpaca market-data REST surface, for bars and latest quotes. Optional for
   * the same reason; defaults to `AlpacaHttpDataClient` on
   * `dataSourceAssetClass`.
   */
  alpacaDataClient?: AlpacaDataClient;
  /**
   * Trade channel the dead-man's-switch heartbeat posts over. Optional: when
   * omitted a log-only `LoggingHeartbeatChannel` stands in, which is a diary
   * rather than a dead-man's switch — its whole point is that its SILENCE is
   * noticed by something outside this process.
   *
   * **The shipped entrypoint no longer reaches that default by omission
   * (#322).** `startFromEnvironment` resolves `SAMURAI_ALERTS` — a required
   * variable with no default — and passes `TradeChannelHeartbeat` over a real
   * `TelegramBotApiClient` (#275) under `telegram`, or nothing at all under an
   * explicitly-named `log-only`. This field stays the port rather than a
   * Telegram/Discord client, so a programmatic caller can still inject its
   * own; see alert-transport.ts.
   *
   * Under `telegram` the beat goes to `TELEGRAM_HEARTBEAT_CHAT_ID` — a chat of
   * its own, never the escalation chat the other three alerts share (#342), so
   * that muting a stream which repeats every 15 minutes forever cannot mute an
   * escalation. Injecting this field opts out of that variable entirely: the
   * caller has chosen the destination itself.
   */
  heartbeatChannel?: HeartbeatChannel;
  /**
   * HITL approval round-trip (Verdict gate 6). Same shape as
   * `heartbeatChannel`: pass `SignedApprovalChannel`
   * (verdict/notifications/verified-approval-channel.ts) so #207's HMAC
   * verification is in the path — the composition root cannot construct it
   * for you, because its `ApprovalRequestSender` leaf is another
   * unimplemented transport.
   */
  approvals?: ApprovalChannel;
  /**
   * Where a restart-time orphaned `go` verdict is reported. Defaults to the
   * log; `TradeChannelOrphanAlert` (orphan-alert-channel.ts) is the
   * reachable-from-a-phone implementation, wired by `SAMURAI_ALERTS=telegram`
   * (#322).
   */
  orphanAlerts?: OrphanAlertChannel;
  /**
   * Where a fill the venue reports filled but will not price is escalated once
   * it has been stuck too long (#298). Defaults to
   * `LoggingUnpricedFillAlertChannel`, with the same caveat as
   * `heartbeatChannel`: the default is reachable only by an operator reading
   * the log stream. `TradeChannelUnpricedFillAlert` (unpriced-fill-channel.ts)
   * is what an unattended soak (#238) needs, and `SAMURAI_ALERTS=telegram`
   * (#322) is what supplies it.
   */
  unpricedFillAlerts?: UnpricedFillAlertChannel;
  /**
   * How long a fill may stay unpriced before that escalation fires. Defaults to
   * `DEFAULT_UNPRICED_FILL_AGE_OUT_MS` (15 minutes) — see its doc for why that
   * number, and note it is only meaningful against `fillPollIntervalMs`, since
   * the check runs on the fill poll.
   */
  unpricedFillAgeOutMs?: number;
  /** WorldMonitor CII reads (ADR-0002; live wiring parked during paper trading). */
  ciiScoreProvider?: CiiScoreProvider;
  /**
   * Account accounting scalars. Optional since #276: when omitted this module
   * builds an `AlpacaAccountStateProvider` over `alpacaBrokerClient`'s
   * `GET /v2/account`, the durable `account_state` table, and the existing
   * `ClosedTrade` store — the three sources transport-layer-spec.md's
   * "Module: AccountStateProvider" names. Same override shape as
   * `broker`/`dataSource`/`llmClient`, for tests and for a future non-Alpaca
   * account ledger.
   */
  accountState?: AccountStateProvider;
  /** Realized-vol reading for the volatility breaker tier — no in-repo indicator (#234). */
  volatility?: VolatilityReadingProvider;

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
   * Defaults to `SMOKE_TEST_UNIVERSE` — a default that is now only right for
   * a programmatic caller. The shipped paper entrypoint supplies
   * `DEFAULT_UNIVERSE` through `paperStartingProfile` (#381); this default
   * stays narrow so a test or a bespoke composition root cannot inherit six
   * live instruments by omission.
   *
   * A mixed universe no longer needs anything extra: `buildAlpacaDataSource`
   * derives the asset classes from this list and builds one
   * `AlpacaDataSource` per class behind an `AssetClassRoutingDataSource`.
   */
  universe?: readonly UniverseInstrument[];
  /**
   * Forces the asset class of a **single-class** market-data source, for the
   * case where the universe cannot say (it is empty) or the caller wants to
   * override what it says.
   *
   * No longer the answer to "which endpoint root?" for a mixed universe, and
   * no longer defaulted to `'crypto'` in practice: `buildAlpacaDataSource`
   * reads the classes off `universe` and routes per instrument when it spans
   * both (#381). The follow-up this field's doc used to defer to — "a routing
   * data source that fans across asset classes" — is that function plus
   * `AssetClassRoutingDataSource`.
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
  /**
   * Indicator the volatility breaker tier reads, per asset class instrument
   * (transport-layer-spec.md story 26). Defaults to ATR(14) — the same shape
   * `SimulatedAdapterConfig.volatility_indicator` carries for
   * `MarketState.volatility`. A tuning value like the rest, so it is a knob
   * rather than a constant, but it has a defensible default so the breaker
   * has a reading without one more required seam.
   */
  volatilityIndicator?: IndicatorSpec;
  /**
   * Session calendar for stock gating (scheduler + Verdict gate) — AND, since
   * #332, the boundary the stocks daily-PnL figure resets on via
   * `sessionStart`. One calendar answers both by design (#331): an override is
   * authoritative for when stock sessions begin, not merely for when to tick.
   */
  tradingCalendar?: TradingCalendar;
  /** Sticky breaker rows recovered from a prior process, if any. */
  initialBreakerState?: readonly PersistedBreakerState[];
  /** Wall-clock gap between tick starts. Default 60s. */
  tickIntervalMs?: number;
  /**
   * Heartbeat cadence, independent of the tick cadence. Default 15 minutes
   * (`DEFAULT_HEARTBEAT_INTERVAL_MS`, #342 — see its doc for why that number
   * rather than the 60s this shipped with).
   */
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
  /**
   * Bounds concurrent instrument passes within one tick. Default 1.
   *
   * **No longer the system's only LLM throttle (#388).** It used to be, by
   * accident: a cap of 1 meant at most one debate in flight and therefore at
   * most one LLM call outstanding, which looked like rate limiting but was a
   * property of a concurrency default. Raising this — the obvious thing to try
   * when tick cadence becomes the bottleneck across a six-instrument universe
   * — removed the protection entirely, with nothing behind it.
   * `rateLimiterConfig` is now what holds the line, per asset class and per
   * time window, and it is unaffected by this number.
   */
  maxConcurrentInstruments?: number;
  /**
   * Per-asset-class LLM budget for the Debate Engine's `RateLimiter` (#388) —
   * the debates-per-window and calls-per-window ceiling every debate is
   * admitted against, and metered through, at `buildDebateStep`.
   *
   * Optional with a documented fallback (`DEFAULT_LLM_RATE_LIMIT_CONFIG`)
   * rather than a `REQUIRED_INJECTED_CONFIG` entry, because the thing #388 was
   * actually about — the component having no caller — is prevented
   * structurally instead: `buildDebateStep` takes a `RateLimiter` as a
   * REQUIRED positional argument, so there is no way to compose a debate step
   * without one. What this field chooses is the size of the budget, not
   * whether there is one.
   *
   * `paperStartingProfile` supplies it explicitly, with the arithmetic behind
   * each number written out beside it.
   */
  rateLimiterConfig?: RateLimiterConfig;
  /**
   * Total USD this process may spend on LLM calls before it stops starting new
   * debates (ADR-0008). Cumulative over the whole `llm_spend` table, and it
   * does NOT refill — see `SqliteSpendCap`.
   *
   * Optional so that the many programmatic callers and tests that issue no
   * live calls need not care, but absence is warned about loudly at startup
   * rather than treated as a default: an unattended run with no ceiling is the
   * failure this exists to prevent. `paperStartingProfile` supplies the soak's
   * checked-in figure.
   */
  llmBudgetUsd?: number;
  /**
   * Overrides the `RateLimiter` this module would otherwise build from
   * `rateLimiterConfig` — same rationale as `broker`/`llmClient`.
   *
   * Exists for one caller in particular: `smoke-run.ts` holds the instance so
   * its gate can assert the limiter actually saw the run's LLM calls. That
   * assertion is the only automated check that can catch this component
   * reverting to having no caller, since a unit suite of 1800+ tests passed
   * for months while it had none.
   */
  llmRateLimiter?: RateLimiter;
  /**
   * Per-venue outbound pacing for the broker adapters' token buckets (#299).
   * Defaults to `resolveVenuePacing()`, i.e. `DEFAULT_VENUE_PACING` with any
   * `SAMURAI_PACING_<VENUE>_*` override applied and validated against the
   * venue's documented ceiling. Injected only by tests that need a bucket
   * that does not pace at wall-clock speed.
   */
  venuePacing?: VenuePacingConfig;
  /**
   * Feedback Loop's daily batch (ADR-0004 §3: wired at this composition
   * point, deliberately *not* as a `TickSteps` member — it runs on its own
   * schedule, not per instrument). Its four stores are all SQLite-backed and
   * built here. Omit it and the daily timer simply never starts — which is
   * warned about loudly at startup (#327), because a run that never tunes
   * anything looks exactly like a healthy one.
   *
   * **Both reasons this used to have no supplier are now closed (#366).**
   * `FeedbackConfig`'s values are tuned in paper trading, so they live where
   * the other eight sets of starting values live — `paperStartingProfile`
   * (paper-profile.ts) — and `LoosenApprovalChannel` is resolved from
   * `SAMURAI_ALERTS` like every other outbound escalation, defaulting to
   * `loosenApprovals` below. A paper run started through the shipped
   * entrypoint therefore supplies this.
   */
  feedback?: FeedbackCycleConfig;
  /**
   * Where a kill-threshold breach goes (#93, wired #327). Defaults to
   * `LoggingBreachAlertChannel`; `SAMURAI_ALERTS=telegram` replaces it with
   * `TradeChannelBreachAlert` at the entrypoint, like the other three
   * outbound alerts (alert-transport.ts).
   */
  breachAlerts?: BreachAlertChannel;
  /**
   * Where a gated risk-threshold LOOSENING request goes (#91, wired #366).
   * Defaults to `LoggingLoosenApprovalChannel`; `SAMURAI_ALERTS=telegram`
   * replaces it with `TradeChannelLoosenApproval`, like the other four
   * outbound escalations (alert-transport.ts).
   *
   * Top-level rather than a field of `feedback` for the reason every other
   * transport is: `paperStartingProfile` supplies tuning *values* and names no
   * transport, because where an operator's alerts go is a deployment decision
   * and not something a checked-in file should hard-code. `FeedbackCycleConfig`
   * keeps its own `approvals` override, which wins over this when both are
   * given (see `runFeedbackCycle`).
   *
   * There is no live-mode refusal here, unlike `ConsoleApprovalChannel`: this
   * port returns `void` and cannot approve anything, so neither implementation
   * can fabricate consent. A request nobody reads leaves the threshold exactly
   * where it was.
   */
  loosenApprovals?: LoosenApprovalChannel;
  logger?: Logger;
}

export interface FeedbackCycleConfig {
  config: FeedbackConfig;
  /**
   * Per-cycle override for `ProductionConfig.loosenApprovals`. Optional since
   * #366: the channel is a transport, so it is resolved from `SAMURAI_ALERTS`
   * alongside the other outbound escalations and falls back to
   * `LoggingLoosenApprovalChannel` — the same shape `breachAlerts` has. Supply
   * it here only to override that for this cycle's config specifically.
   */
  approvals?: LoosenApprovalChannel;
  /**
   * Param/threshold moves to consider this cycle. Empty is a valid, meaningful
   * cycle: analyst weights are attributed from closed trades, not proposed.
   */
  proposals?: TuningProposal[];
  /** Default 24h. */
  intervalMs?: number;
  /**
   * What makes `computeMetrics` — and with it the four kill-lines — actually
   * run each cycle (#327).
   *
   * Still optional, but no longer unsatisfiable: since #345 a real
   * implementation exists — `new SqliteDailyEquityMetricsSource({ equity: new
   * SqliteDailyEquityStore(db), trades, logger })` over the `daily_equity`
   * series this composition root already samples every tick (ADR-0006).
   *
   * Deliberately NOT defaulted here. Wiring it is a decision about whether this
   * deployment wants the kill-line detector armed, and defaulting it would arm
   * it by omission — the mirror image of the bug #327 closed. Capture is
   * unconditional (the sampler always runs, because equity not recorded on the
   * day is unrecoverable); evaluation is opt-in.
   *
   * **The paper profile opts in (#379).** `paperStartingProfile` supplies the
   * `SqliteDailyEquityMetricsSource` factory, so the shipped entrypoint arms the
   * detector — a decision taken in the open, in a reviewable checked-in file,
   * and safe because the source's own 60-observation gate keeps every kill-line
   * inert for ~a quarter of trading. That is still not a default: a caller
   * building its own `ProductionConfig` gets nothing here unless it asks.
   *
   * Omit it and the detector does not run. That is announced at startup at
   * `warn` rather than left to be discovered — a paper run can degrade exactly
   * the way these lines exist to catch, and silence is the bug #327 closes.
   */
  metrics?: DailyMetricsConfig;
}

/**
 * The stores a real `DailyMetricsSource` needs but a checked-in profile cannot
 * hold (#379).
 *
 * `paperStartingProfile` supplies tuning VALUES and opens no database — which is
 * what lets it be imported, diffed and reviewed without side effects, and why
 * #345 recorded "wiring it belongs to the composition root". The only real
 * `DailyMetricsSource` in the repo (`SqliteDailyEquityMetricsSource`) needs the
 * shared handle, so the profile names the decision as a factory and this root,
 * which owns the handle, calls it.
 *
 * `trades` is handed over rather than re-opened so the metrics source and the
 * tuning cycle read closed trades through one instance (code-review 2026-08-01,
 * H7) — and typed as the `ClosedTradeStore` port rather than restated
 * structurally, so the two cannot drift.
 */
export interface DailyMetricsSourceDeps {
  /**
   * The shared handle, not a pre-built equity store: the root's own
   * `SqliteDailyEquityStore` lives inside the DEFAULT `accountState` branch and
   * does not exist when a caller injects its own provider, so handing one over
   * would be handing over a sometimes-absent object. It is a read-only reader
   * over an append-only table, so a second instance cannot disagree with the
   * sampler.
   */
  db: SqliteHandle;
  /** The root's own instance — the same reader `runDailyCycle` attributes over. */
  trades: ClosedTradeStore;
  logger: Logger;
}

/** Deferred construction of a `DailyMetricsSource` — see `DailyMetricsSourceDeps`. */
export type DailyMetricsSourceFactory = (deps: DailyMetricsSourceDeps) => DailyMetricsSource;

export interface DailyMetricsConfig {
  /**
   * Supplies the day's already-computed suite, or `undefined` for "none this
   * cycle".
   *
   * Either a built source or a factory this root resolves ONCE at construction
   * (#379) — never per cycle, for `feedbackStores`' reason. The factory form
   * exists so a config file that holds no stores can still make the decision;
   * the two are otherwise identical, and supplying either arms the detector
   * just as explicitly.
   */
  source: DailyMetricsSource | DailyMetricsSourceFactory;
  /**
   * The frozen selected config's backtest Sharpe — the divergence check's
   * baseline. Supplied for the same reason the suite is: no selected-config
   * record with a backtest Sharpe is persisted in-repo (`SqliteConfigTrialLog`
   * has the documented `config_json` gap, and Stage 2's runner uses an
   * in-memory trial log).
   *
   * A value `<= 0` cannot breach by design — `liveBacktestDivergence` refuses
   * to manufacture a breach off a broken reference — which makes
   * `live_backtest_divergence_over_max` inert. That is warned about once, not
   * silently tolerated.
   *
   * ## Still unsourced after #345 — deliberately. Follow-up: #375
   *
   * #345 sourced the live half of this comparison: `daily_equity` (migration
   * 0011) persists the equity series and `SqliteDailyEquityMetricsSource`
   * derives a real `ReturnSeries` from it, so `daily.sharpe` is now a measured
   * figure. The BASELINE it is measured against is still not, and #345 left it
   * that way on purpose rather than inventing one.
   *
   * There is no selected-config record to freeze a Sharpe from, because there
   * has been no backtest of anything this system trades:
   * `docs/specs/stage2-validation-execution-spec.md` owns the standing fact that
   * "the machinery has never been run against a real strategy". Supplying a
   * plausible number here would not make the line work — it would arm a
   * detector that calls `autoTighten`, which WRITES every risk threshold toward
   * its extreme, against a reference nobody measured.
   *
   * So `live_backtest_divergence_over_max` remains inert by default, loudly
   * (see the `warn` in `runMetricsCheck` and `MetricsReport.not_evaluated`), and
   * arming it is #375's job: run Stage 2 against a real strategy, close
   * `SqliteConfigTrialLog`'s `config_json` gap, persist the selection, and read
   * this value from that record instead of taking it as config.
   */
  backtest_reference_sharpe: number;
}

/**
 * Resolves the two forms `DailyMetricsConfig.source` accepts (#379).
 *
 * The discriminator is `typeof === 'function'`. A function object could in
 * principle also carry a `getDailyMetrics` property and satisfy both arms, but
 * nothing in the repo constructs one and the factory reading wins — which is
 * the safe way round: a factory misread as a source would be invoked never,
 * silently, and the detector would look armed while doing nothing.
 */
function resolveDailyMetricsSource(
  source: DailyMetricsSource | DailyMetricsSourceFactory,
  deps: DailyMetricsSourceDeps,
): DailyMetricsSource {
  return typeof source === 'function' ? source(deps) : source;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;
/**
 * 15 minutes (#342), not the 60s this shipped with.
 *
 * The number is the **external watchdog's staleness threshold**, not a volume
 * target: the heartbeat's whole purpose is that something outside this process
 * notices its silence, so the cadence only has to be tight enough that "no beat
 * for 2 intervals" is still a timely alarm. Half an hour of undetected death on
 * an unattended paper soak (#238) is well inside a useful detection window, and
 * a tighter beat buys detection latency nobody is awake to use.
 *
 * What 60s cost, by contrast, was the alerting channel itself: ~20,000
 * heartbeats over the 14-day soak into the chat that also carries the orphaned
 * go verdict, the stuck unpriced lot and the kill-threshold breach — until the
 * operator mutes it. 15 minutes plus the separate destination
 * `TELEGRAM_HEARTBEAT_CHAT_ID` gives (alert-transport.ts) is the pair that fixes
 * that; neither alone is sufficient.
 *
 * Still a default, not a constant: `ProductionConfig.heartbeatIntervalMs`
 * overrides it, and the smoke gate (smoke-run.ts) sets its own 100ms so the
 * timer actually fires inside a one-second run.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_FILL_POLL_INTERVAL_MS = 15_000;
/**
 * ATR(14): the conventional realized-volatility read, and the same shape
 * `SimulatedAdapterConfig.volatility_indicator` carries for
 * `MarketState.volatility`. `'atr'` is one of the four indicators
 * `computeIndicator` dispatches on (indicators.ts) — an unrecognized name
 * would throw per instrument and leave the volatility breaker tier wired but
 * permanently reading its failure fallback, which is worse than leaving it a
 * required seam because it looks live.
 *
 * `lookback: 15`, not 14: `atr()` consumes the first bar only to seed
 * `previousClose`, so N bars yield N-1 true ranges. A 14-period ATR needs 15.
 */
const DEFAULT_VOLATILITY_INDICATOR: IndicatorSpec = {
  indicator: 'atr',
  params: { period: 14 },
  lookback: 15,
};
/**
 * The Feedback Loop's cadence — "daily batch" (feedback-loop-spec.md § Cadence
 * & Scope).
 *
 * Exported since #366 so `paperStartingProfile` can express
 * `FeedbackConfig.attribution_window_ms` as a multiple of it rather than as an
 * unrelated literal. The two are coupled: a window shorter than the gap between
 * cycles drops the trades that closed in between, and nothing else in the
 * config records that relationship.
 */
export const DEFAULT_FEEDBACK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

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
export function buildDefaultLlmClient(logger: Logger, spendSink?: LlmSpendSink): LlmClient {
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
  // `spendSink` is only ever supplied on this default path, and deliberately
  // so: a `ProductionConfig.llmClient` override is a test double or a
  // non-Anthropic provider, and metering one against an Anthropic price table
  // would produce a confidently wrong dollar figure. An overridden client
  // meters nothing, and the dashboard's spend tile reads $0 — visibly empty
  // rather than quietly fictional.
  return new AnthropicLlmClient(client, config, spendSink);
}

/**
 * The LLM budget used when `ProductionConfig.rateLimiterConfig` is omitted
 * (#388) — a backstop for a programmatic caller, NOT the soak's numbers.
 * `paperStartingProfile` supplies its own, sized against the real universe,
 * and that is what `yarn orchestrator` and `yarn smoke` run on.
 *
 * Deliberately generous rather than tight. This limiter is a CEILING that
 * catches a misconfiguration or a runaway loop, not a scheduler: a budget that
 * bites during normal operation would shed debates the operator wanted, and
 * the tick cadence is what paces ordinary spend. So the default is set well
 * above what a single-instrument process can reach in a minute (a 60s tick
 * chain cannot start more than a handful of debates per window) while still
 * being finite, which is the whole difference from today's `undefined`.
 *
 * `maxLlmCalls` is `maxDebates * WORST_CASE_LLM_CALLS_PER_DEBATE` exactly: any
 * less and the call budget, not the debate budget, becomes the binding
 * constraint, which would refuse debates while reporting the wrong reason.
 */
export const DEFAULT_LLM_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  default: {
    windowMs: 60_000,
    maxDebates: 30,
    maxLlmCalls: 30 * WORST_CASE_LLM_CALLS_PER_DEBATE,
  },
};

/**
 * The default broker wire client, with the Alpaca environment DERIVED FROM
 * `mode` rather than left to `AlpacaHttpBrokerClient`'s own default (#293).
 *
 * The class defaults to paper, which is the safe direction, but a default is
 * still the wrong mechanism here: it means the single most consequential fact
 * about a running process — whether its orders spend real money — is decided
 * by a constant nobody passed rather than by the `mode` the operator
 * explicitly set. Deriving it makes `mode` the one control, and makes a
 * mismatch impossible rather than unlikely.
 *
 * `backtest` is paper too: that mode is meant to run against
 * `SimulatedBrokerAdapter`, so if it ever reaches a real client at all, the
 * harmless account is the one to reach.
 *
 * `ALPACA_BASE_URL` can still override the host, because a staging/mock
 * endpoint is a legitimate need — but naming Alpaca's live host from a
 * non-live mode throws rather than being honoured, and the reverse (a live
 * mode silently filling paper orders) is refused by the client. An override
 * that silently upgrades a paper process to real money is the exact accident
 * #293 exists to prevent.
 *
 * Host classification is `classifyAlpacaTradingHost` from the execution
 * barrel, not a local string comparison: the original `startsWith` check here
 * was case- and whitespace-sensitive, so `https://API.ALPACA.MARKETS` walked
 * straight past it. One classifier means one set of rules to be right about.
 */
export function buildDefaultAlpacaBrokerClient(
  mode: ProductionConfig['mode'],
  logger: Logger,
): AlpacaBrokerClient {
  const environment: AlpacaTradingEnvironment = mode === 'live' ? 'live' : 'paper';
  const override = process.env.ALPACA_BASE_URL;

  if (override !== undefined && classifyAlpacaTradingHost(override) === 'live' && mode !== 'live') {
    throw new Error(
      `ALPACA_BASE_URL points at Alpaca's LIVE trading host ('${override}') but SAMURAI_MODE ` +
        `is '${mode}'. Refusing to start: this combination spends real money from a process ` +
        'the operator asked to be non-live. Set SAMURAI_MODE=live if that is genuinely intended.',
    );
  }

  // Constructed before the log line, not after: the client re-checks the
  // environment/host agreement and can still throw, and a startup log naming a
  // host the process never reached is worse than no log at all.
  const client = new AlpacaHttpBrokerClient(
    override === undefined ? { environment } : { environment, baseUrl: override },
  );

  logger.log({
    trace_id: 'startup',
    stage: 'orchestrator',
    level: environment === 'live' ? 'warn' : 'info',
    message:
      environment === 'live'
        ? 'building LIVE Alpaca broker client — orders will spend real money'
        : 'building paper Alpaca broker client',
    payload: { mode, environment, baseUrl: client.baseUrl },
  });

  return client;
}

/**
 * The default market-data wire client. No mode branch: Alpaca serves market
 * data from one host for paper and live accounts alike, so there is no
 * money-safety decision to make here — only the asset-class path root, which
 * `AlpacaDataSource` needs fixed at construction.
 */
export function buildDefaultAlpacaDataClient(
  assetClass: 'crypto' | 'stocks',
  /**
   * The account's shared outbound bucket (#391). Optional so existing callers
   * and tests keep working unpaced; the composition root always passes the
   * same instance it gave the broker adapter, because Alpaca's 200 req/min is
   * per ACCOUNT — two buckets would be two budgets against one limit.
   */
  rateLimiter?: TokenBucket,
): AlpacaDataClient {
  return new AlpacaHttpDataClient({ assetClass, rateLimiter });
}

/**
 * The asset classes a universe actually spans, in a stable order.
 *
 * Derived rather than configured: `dataSourceAssetClass` used to be the
 * operator's answer to "which endpoint root?", defaulted to `'crypto'` to match
 * `SMOKE_TEST_UNIVERSE`, and had no way to say "both". Reading it off the
 * universe means the market-data wiring cannot disagree with the tick plan
 * about what is being traded — which is the disagreement #358 was.
 */
export function universeAssetClasses(universe: readonly UniverseInstrument[]): AssetClass[] {
  return (['crypto', 'stocks'] as const).filter((assetClass) =>
    universe.some((instrument) => instrument.asset_class === assetClass),
  );
}

/**
 * The market-data source for `universe`, which is one `AlpacaDataSource` per
 * asset class the universe holds — routed per instrument when it holds both
 * (#381).
 *
 * A single source cannot serve a mixed universe: `AlpacaDataSource` fixes its
 * asset class and calendar at construction, and `AlpacaHttpDataClient` fixes
 * the API path root there too (`/v2/stocks/...` vs `/v1beta3/crypto/us/...`).
 * See `AssetClassRoutingDataSource` for the full rationale and for why an
 * unroutable instrument throws instead of defaulting.
 *
 * `config.alpacaDataClient` is refused for a mixed universe rather than
 * silently applied to both halves. It is a single-asset-class wire client by
 * construction, so honouring it would mean sending four equities to whichever
 * root that one client was built with — the exact silent-404 shape this
 * function exists to prevent. A caller wanting full control over a mixed
 * universe injects `config.dataSource` instead, which is checked first and
 * never reaches here.
 */
export function buildAlpacaDataSource(
  config: Pick<ProductionConfig, 'alpacaDataClient' | 'dataSourceAssetClass'>,
  universe: readonly UniverseInstrument[],
  tradingCalendar: TradingCalendar,
  /** The account's shared outbound bucket (#391) — see `buildDefaultAlpacaDataClient`. */
  rateLimiter?: TokenBucket,
): DataSource {
  const present = universeAssetClasses(universe);
  // An empty universe has no class to derive — `'crypto'` remains the
  // historical default there rather than throwing on a degenerate-but-harmless
  // config.
  const classes: AssetClass[] =
    present.length > 0 ? present : [config.dataSourceAssetClass ?? 'crypto'];

  const sourceFor = (assetClass: AssetClass): AlpacaDataSource =>
    new AlpacaDataSource(
      config.alpacaDataClient ?? buildDefaultAlpacaDataClient(assetClass, rateLimiter),
      {
        asset_class: assetClass,
        // Authoritative for equities only: `AlpacaDataSource` substitutes
        // `AlwaysOpenCalendar` for a crypto source regardless of what is passed
        // (alpaca-source.ts), because a 24/7 venue has no session to gate on.
        calendar: tradingCalendar,
      },
    );

  const single = classes.length === 1 ? classes[0] : undefined;
  if (single !== undefined) {
    const override = config.dataSourceAssetClass;
    // A `dataSourceAssetClass` that CONTRADICTS the universe is refused, not
    // obeyed. Obeying it is the same misroute the mixed-universe branch below
    // throws on — an all-equity universe forced to `'crypto'` sends every bars
    // request to `/v1beta3/crypto/us/...` and 404s silently (#358) — and this
    // function's whole premise is that the market-data wiring cannot disagree
    // with the tick plan. The override stays useful for the case it was added
    // for: an EMPTY universe, which asserts nothing to contradict.
    if (override !== undefined && present.length > 0 && override !== single) {
      throw new Error(
        `Orchestrator cannot start: ProductionConfig.dataSourceAssetClass is '${override}', but ` +
          `the configured universe holds only '${single}' instruments. Market-data endpoints are ` +
          'per asset class (/v2/stocks vs /v1beta3/crypto/us), so honouring the override would ' +
          'send every request to the wrong API root and 404 silently, which is issue #358. Drop ' +
          'the override — it is derived from the universe — or change the universe to match it.',
      );
    }
    return sourceFor(single);
  }

  if (config.alpacaDataClient !== undefined) {
    throw new Error(
      'Orchestrator cannot start: ProductionConfig.alpacaDataClient was supplied for a universe ' +
        'spanning both crypto and stocks. That client is built against ONE Alpaca market-data ' +
        'path root (/v2/stocks vs /v1beta3/crypto/us), so one instance cannot serve both — ' +
        'applying it to both halves would send one asset class to the wrong endpoint and 404 ' +
        'silently, which is issue #358. Inject ProductionConfig.dataSource (an ' +
        'AssetClassRoutingDataSource, or your own) to control a mixed universe, or narrow the ' +
        'universe to a single asset class.',
    );
  }

  return new AssetClassRoutingDataSource({
    sources: { crypto: sourceFor('crypto'), stocks: sourceFor('stocks') },
    assetClassOf: new Map(universe.map((i) => [i.asset, i.asset_class])),
  });
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
  /**
   * The operator escalation channel, exposed because TWO consumers need the
   * same instance: the Feedback Loop's kill-threshold breach, and the LLM
   * spend cap's breach (ADR-0008), which is constructed inside this function.
   * Returning it beats building a second one in `buildProductionOrchestrator`
   * — two channels would be two places for an injected override to be applied
   * to only one of them.
   */
  breachAlerts: BreachAlertChannel;
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
    { setup_store: new SqliteSetupStore(config.db) },
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
  const circuitBreakers = new CircuitBreakers(config.breakerConfig, config.initialBreakerState);
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
  };

  const steps: TickSteps = {
    // `logger` here is what makes an analyst failure visible at all — see the
    // adapter's doc comment (issue #358 item 4).
    analysts: buildAnalystsStep(analysts, logger),
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
    ),
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
    tuning: new SqliteTuningStore(config.db, clock),
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
  const metricsSource =
    config.feedback?.metrics === undefined
      ? undefined
      : resolveDailyMetricsSource(config.feedback.metrics.source, {
          db: config.db,
          trades: feedbackStores.trades,
          logger,
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
      backtest_reference_sharpe: metrics.backtest_reference_sharpe,
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
