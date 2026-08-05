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
 * only when `ProductionConfig.feedback` supplies the two inputs with no
 * in-repo source (its `FeedbackConfig` values and the loosen-approval
 * channel); its four stores are all SQLite-backed and constructed here.
 * **Not starting it is now announced at startup at `warn` (#327)** — it used
 * to be reached by pure omission, which is the same silent-by-omission bug
 * #293/#320/#322 closed elsewhere.
 *
 * `computeMetrics` — the kill-line detector — runs in that same timer, after
 * the tuning cycle, whenever `FeedbackCycleConfig.metrics` supplies a
 * `DailyMetricsSource` (#327). Before that ticket it had no production caller
 * at all, so all four kill-lines were unreachable in a paper run. The suite
 * is *supplied* rather than computed here because no live equity return
 * series is persisted — see `DailyMetricsSource` for why inventing one would
 * be worse than the silence, given that a breach WRITES risk thresholds.
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
import type { AnthropicLlmClientConfig, LlmClient, LlmSpendSink } from '../debate-engine/index.js';
import {
  AnthropicHttpMessagesClient,
  AnthropicLlmClient,
  DEFAULT_ANTHROPIC_MODEL,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
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
  ConsoleApprovalChannel,
  LoggingBreachAlertChannel,
  LoggingHeartbeatChannel,
  LoggingOrphanAlertChannel,
  LoggingUnpricedFillAlertChannel,
  ParkedCiiScoreProvider,
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
import { MarketDataVolatilityReadingProvider } from './production/volatility-reading-provider.js';
import { UniverseScheduler } from './scheduler.js';
import { SqliteAccountStateStore } from './sqlite-account-state-store.js';
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
  /**
   * Where a kill-threshold breach goes (#93, wired #327). Defaults to
   * `LoggingBreachAlertChannel`; `SAMURAI_ALERTS=telegram` replaces it with
   * `TradeChannelBreachAlert` at the entrypoint, like the other three
   * outbound alerts (alert-transport.ts).
   */
  breachAlerts?: BreachAlertChannel;
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
  /**
   * What makes `computeMetrics` — and with it the four kill-lines — actually
   * run each cycle (#327). Optional for one honest reason, spelled out in
   * `DailyMetricsSource`'s doc: no live equity return series is persisted, so
   * the `MetricsSuite` cannot be produced in-repo and must be supplied.
   *
   * Omit it and the kill-line detector does not run. That is announced at
   * startup at `warn` rather than left to be discovered — a paper run can
   * degrade exactly the way these lines exist to catch, and silence is the
   * bug #327 closes.
   */
  metrics?: DailyMetricsConfig;
}

export interface DailyMetricsConfig {
  /** Supplies the day's already-computed suite, or `undefined` for "none this cycle". */
  source: DailyMetricsSource;
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
   */
  backtest_reference_sharpe: number;
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
export function buildDefaultAlpacaDataClient(assetClass: 'crypto' | 'stocks'): AlpacaDataClient {
  return new AlpacaHttpDataClient({ assetClass });
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

  // One broker wire client for the whole root: the order adapter and the
  // account-state provider both talk to Alpaca's Trading API, and two clients
  // would mean two token budgets against one account's shared rate limit.
  const brokerClient =
    config.alpacaBrokerClient ??
    buildDefaultAlpacaBrokerClient(config.mode, config.logger ?? new JsonLogger());

  const assetClass = config.dataSourceAssetClass ?? 'crypto';
  const dataSource =
    config.dataSource ??
    new AlpacaDataSource(config.alpacaDataClient ?? buildDefaultAlpacaDataClient(assetClass), {
      asset_class: assetClass,
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
      client: brokerClient,
      rateLimiter: new TokenBucket({ capacity: 10, refillPerSecond: 1.5 }),
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
        calendars: { crypto: new AlwaysOpenCalendar(), stocks: tradingCalendar },
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
        universe: config.universe ?? SMOKE_TEST_UNIVERSE,
        volatility_indicator: config.volatilityIndicator ?? DEFAULT_VOLATILITY_INDICATOR,
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
      // Log-only stand-in when unwired (#275): it auto-approves, and its
      // constructor refuses to exist in live mode.
      approvals: config.approvals ?? new ConsoleApprovalChannel(logger, config.mode),
      // Backs LoggingVerdict's verdict_log write (#302) — the same handle
      // every other Sqlite* store in this function reads/writes through.
      store: config.db,
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
  const breachAlerts = config.breachAlerts ?? new LoggingBreachAlertChannel(logger);

  /**
   * Latch for the inert-divergence warn (#327 item 3). The condition is a
   * property of the frozen config, not of the day, so it is true on every
   * cycle — an unattended daily timer would otherwise repeat it forever.
   */
  let warnedInertDivergence = false;

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
  const runMetricsCheck = (metrics: DailyMetricsConfig, feedbackConfig: FeedbackConfig): void => {
    const sample = metrics.source.getDailyMetrics();
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

    if (metrics.backtest_reference_sharpe <= 0 && !warnedInertDivergence) {
      warnedInertDivergence = true;
      logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'warn',
        message:
          'backtest_reference_sharpe <= 0 — live_backtest_divergence_over_max is INERT and can ' +
          'never breach. A non-positive reference has no meaningful relative drop, so the check ' +
          'returns 0 by design; set FeedbackCycleConfig.metrics.backtest_reference_sharpe to the ' +
          "frozen selected config's backtest Sharpe to arm it. Warned once per process.",
        payload: { backtest_reference_sharpe: metrics.backtest_reference_sharpe },
      });
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
      alerts: breachAlerts,
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

      // Inside the same try/catch — a throw here must not take the timer down
      // either — and deliberately AFTER the cycle's own log line, so a metrics
      // failure cannot erase the record that the tuning cycle itself
      // succeeded: the 'complete' line is already written by then, and the
      // catch below adds a 'failed' line rather than replacing it.
      if (feedback.metrics !== undefined) {
        runMetricsCheck(feedback.metrics, feedback.config);
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
        if (feedback.metrics === undefined) {
          logger.log({
            trace_id: 'startup',
            stage: 'feedback-loop',
            level: 'warn',
            message:
              'FeedbackCycleConfig.metrics is not set — the daily cycle will tune dials but ' +
              'computeMetrics will NEVER run, so all four kill-lines stay unevaluated. No ' +
              'MetricsSuite can be produced in-repo today (no equity return series is ' +
              'persisted; see DailyMetricsSource), so it must be supplied.',
            payload: { kill_lines: 'not_evaluated' },
          });
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
