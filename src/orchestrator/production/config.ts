import type { CostConfig, SqliteStage2SelectionStore } from '../../cost-model-backtest/index.js';
import type { LlmClient, RateLimiter, RateLimiterConfig } from '../../debate-engine/index.js';
import type {
  AlpacaClient as AlpacaBrokerClient,
  BrokerAdapter,
  ExecutionConfig,
  UnpricedFillAlertChannel,
} from '../../execution/index.js';
import type {
  BreachAlertChannel,
  DailyMetricsSource,
  FeedbackConfig,
  LoosenApprovalChannel,
  TuningProposal,
} from '../../feedback-loop/index.js';
import type {
  AlpacaClient as AlpacaDataClient,
  DataSource,
  IndicatorSpec,
  TradingCalendar,
} from '../../market-data-service/index.js';
import type { CiiConsumerConfig, CiiScoreProvider } from '../../market-intelligence/index.js';
import type {
  BreakerConfig,
  CorrelationConfig,
  PersistedBreakerState,
  RiskConfig,
} from '../../risk-manager/index.js';
import type { Clock, ClosedTradeStore, VenuePacingConfig } from '../../shared/index.js';
import type { SharedStore as SqliteHandle } from '../../shared/store/index.js';
import type { TraderConfig } from '../../trader/index.js';
import type { ApprovalChannel, TradeChannelNotifier, VerdictConfig } from '../../verdict/index.js';
import type { HeartbeatChannel } from '../heartbeat.js';
import type { OrphanAlertChannel } from '../orphan-verdict-scan.js';
import type { Logger, UniverseInstrument } from '../types.js';
import type { AnalystSkipAlertChannel } from './analysts-adapter.js';
import { DEFAULT_STAGE2_MAX_AGE_DAYS } from './daily-equity-metrics-source.js';
import type { AccountStateProvider, VolatilityReadingProvider } from './direct-bind.js';

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
   * Where a run of consecutive analyst quorum skips is escalated (#431,
   * analysts-spec.md story 25). Defaults to `LoggingAnalystSkipAlertChannel`,
   * with the same caveat as the others: an analyst stage that has skipped every
   * tick for six hours is the failure an unattended soak cannot see any other
   * way — the heartbeat keeps beating and a skipped tick at a 15-minute cadence
   * looks like a quiet market. `TradeChannelAnalystSkipAlert` is what
   * `SAMURAI_ALERTS=telegram` supplies.
   */
  analystSkipAlerts?: AnalystSkipAlertChannel;
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
   * around `NousMessagesClient` (#274, retargeted by ADR-0009) — same
   * rationale as `broker`/`dataSource`, for tests (`MockLlmClient`) or a
   * future second provider. When omitted, the default resolves
   * `NOUS_BASE_URL`, a key (`NOUS_DEBATE_API_KEY` or `NOUS_API_KEY`) and a
   * model (`NOUS_DEBATE_MODEL`, `NOUS_MODEL`, else the role default) through
   * `nousCredentials('debate')` — and logs a `warn` via
   * `ProductionConfig.logger` at build time, since this silently turns on
   * real, billed API calls whenever the key happens to be set.
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
   * Whether the market-intelligence sentiment agent runs (D2, review
   * 2026-08-06). Defaults from `SAMURAI_SENTIMENT` (`off` disables, anything
   * else runs it) — the same option-with-env-default idiom every other
   * env-derived value in this codebase uses; this field exists so tests and
   * programmatic callers can decide without touching the process environment.
   */
  sentimentEnabled?: boolean;
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
  /**
   * #465: where NOTABLE verdicts go. Absent = no verdict alerting, which is
   * what `log-only` mode and every test get.
   *
   * Filtered, not firehosed — `isNotableVerdict` keeps `go` verdicts and the
   * no-gos the system chose about itself, and drops the routine ones. Story 14
   * asks for every no-go, and at ADR-0008's cadence that is ~300 messages a
   * day; see `notable-verdict.ts` for why the line falls where it does.
   */
  verdictAlerts?: TradeChannelNotifier;
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
  /**
   * The frozen Stage 2 selections (#384) — where `DailyMetricsSample
   * .revalidation` comes from, since PBO/OOS-Sharpe/DSR are walk-forward
   * statistics a live run cannot compute about itself. The root's own instance,
   * so the three revalidation kill-lines and the divergence baseline read the
   * same row.
   */
  stage2Selections: SqliteStage2SelectionStore;
  /** Ages a selection out; the root's clock, so a replay ages deterministically. */
  clock: Clock;
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
   * **Superseded as the primary source by #375.** A frozen Stage 2 selection
   * (`stage2_selected_config`, migration 0014) now carries the selected
   * config's backtest Sharpe, and the composition root prefers it over this
   * field whenever a fresh one exists. This stays as the fallback for a
   * deployment that has never run Stage 2 — where it still defaults to inert,
   * loudly, for the reason above.
   */
  backtest_reference_sharpe: number;
}

/**
 * The divergence baseline (#375): the frozen Stage 2 selection when there is a
 * fresh one, the operator-supplied config otherwise.
 *
 * With a selection for both asset classes it takes the HIGHER backtest Sharpe.
 * A portfolio's "promise" is a blend of the two that nothing here can compute,
 * and of the two available readings the higher one is the one MORE likely to
 * register divergence — the same conservative direction `revalidation` takes
 * when it reports the worse PBO. A kill-line firing is a report to a human,
 * not an automatic kill, so erring toward reporting is the right error.
 *
 * A stale selection is ignored rather than used: a verdict about an old sample
 * says nothing about today's regime, and this number drives `autoTighten`,
 * which writes real risk configuration.
 */
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

/**
 * Resolves the two forms `DailyMetricsConfig.source` accepts (#379).
 *
 * The discriminator is `typeof === 'function'`. A function object could in
 * principle also carry a `getDailyMetrics` property and satisfy both arms, but
 * nothing in the repo constructs one and the factory reading wins — which is
 * the safe way round: a factory misread as a source would be invoked never,
 * silently, and the detector would look armed while doing nothing.
 */
export function resolveDailyMetricsSource(
  source: DailyMetricsSource | DailyMetricsSourceFactory,
  deps: DailyMetricsSourceDeps,
): DailyMetricsSource {
  return typeof source === 'function' ? source(deps) : source;
}
