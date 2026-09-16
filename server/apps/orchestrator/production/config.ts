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

/**
 * Outbound operator-escalation transports. Any field added here must also
 * be added to `alert-transport.ts`'s `ALERT_CHANNEL_FIELDS`, or the two lists
 * silently diverge (#431, #465, #551).
 */
export interface AlertChannelSlots {
  /** Dead-man's-switch heartbeat transport; `SAMURAI_ALERTS` selects it at boot */
  heartbeatChannel?: HeartbeatChannel;
  /** Restart-time orphaned `go` verdict report */
  orphanAlerts?: OrphanAlertChannel;
  /** Fill the venue reports filled but will not price, stuck too long (#298) */
  unpricedFillAlerts?: UnpricedFillAlertChannel;
  /** Residual position `ingestFills()` failed to re-arm after a partial flatten (#525) */
  residualExposureAlerts?: ResidualExposureAlertChannel;
  /** Emulated crypto OCO double fill: both protective legs filled in one poll window (#586) */
  ocoDoubleFillAlerts?: OcoDoubleFillAlertChannel;
  /**
   * Partial entry fill on a venue whose protective-leg resizing is UNVERIFIED
   * (#1215) — required (no default) for `SaxoBrokerAdapter`
   */
  legResizeAlerts?: LegResizeUnverifiedAlertChannel;
  /** Dormant Saxo related-order pair the adapter cannot resolve (#1215/#1216) */
  dormantLegsAlerts?: DormantLegsUnresolvedAlertChannel;
  /** Priced Saxo fill whose `Uic` resolves to no pool line; fill is refused, not booked (#1302) */
  priceUnitAlerts?: UnresolvedPriceUnitAlertChannel;
  /**
   * `flatten_submissions` row `reconcile()` could not settle (#519). Since
   * #1349 pages the live arm only; `residualExposureAlerts` pages both arms.
   */
  flattenReconcileAlerts?: FlattenReconcileAlertChannel;
  /** Consecutive analyst quorum skip run (#431) */
  analystSkipAlerts?: AnalystSkipAlertChannel;
  /** Kill-threshold breach (#93) */
  breachAlerts?: BreachAlertChannel;
  /**
   * Notice of an applied risk-threshold loosening (#91). Top-level rather
   * than a field of `feedback` since where alerts go is a deployment
   * decision, not a checked-in value; `FeedbackCycleConfig`'s own override
   * wins when both are given.
   */
  loosenNotices?: LoosenNotificationChannel;
  /**
   * Degraded-but-continuing Trader condition (#698). `buildTraderStep` also
   * logs at `error`, so absence here means "no second, audible copy".
   */
  traderDiagnosticAlerts?: TraderDiagnosticAlertChannel;
  /** Notable verdicts (#465) — filtered by `isNotableVerdict`, not every no-go */
  verdictAlerts?: TradeChannelNotifier;
  /** Degraded market-intelligence coverage gap (#752) */
  miCoverageAlerts?: MiCoverageAlertChannel;
  /**
   * Out-of-bound `risk_thresholds` row tripping #638's runtime clamp (#766).
   * Both catch sites already log at `error`, so absence means no second copy.
   */
  thresholdClampAlerts?: ThresholdClampAlertChannel;
  /** Live OHLCV failover to the fallback vendor for one (instrument, timeframe) (#562) */
  dataFailoverAlerts?: DataFailoverAlertChannel;
  /**
   * Exit priced against a partly-valued book — a held instrument's mark was
   * unreadable or stale (#841). Both catch sites already log at `error`.
   */
  exitValuationAlerts?: ExitValuationDegradedAlertChannel;
  /** Failed Alpaca `GET /v2/calendar` fetch at boot; paper leg fell back to the hand-entered table (#684) */
  calendarFallbackAlerts?: CalendarFallbackAlertChannel;
  /**
   * Matched control (falsifier arm 2) out-performing the live arm (#971).
   * Separate from `breachAlerts` because that formatter would trigger
   * `autoTighten`, which this measurement must not do.
   */
  armDivergenceAlerts?: ArmDivergenceAlertChannel;
  /** Materially degraded tick pass (#1084); threshold in `tick-skip-alert.ts` */
  tickSkipAlerts?: TickSkipAlertChannel;
  /** Prompt-tier crossing — unit cost jumped silently inside the meter (#1155) */
  promptTierAlerts?: PromptTierAlertChannel;
  /**
   * Live equity leg's own LSE table-coverage horizon nearing
   * `LSE_TABLE_COVERAGE_END` (#1378). Distinct from `calendarFallbackAlerts`,
   * which is the paper leg's fetch-failure fallback.
   */
  lseCalendarCoverageAlerts?: LseCalendarCoverageAlertChannel;
  /** Sustained `debate_log.termination_cause = 'llm_failure'` rate (#1396) */
  llmFailureRateAlerts?: LlmFailureRateAlertChannel;
  /**
   * Near-total in-flight-gate refusal ratio (#1533). Separate from
   * `llmFailureRateAlerts`: routine refusals are the gate working as
   * designed, not an LLM outage.
   */
  gateRefusalRateAlerts?: GateRefusalRateAlertChannel;
  /**
   * Fill fee reported outside book currency (#1465/#1220) — means an
   * instrument was traded that the sterling-only gate should have excluded
   */
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
  /**
   * Flatten fill booked against a lot that had already closed (#1506) — the
   * venue transacted quantity the lot's `closed_trade` does not contain
   */
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel;
  /**
   * Venue-held position no open lot in the store explains (#1550). Live arm
   * only (#1349) — the control arm's simulated book is not actionable.
   */
  unrecordedVenuePositionAlerts?: UnrecordedVenuePositionAlertChannel;
  /** Saxo session can no longer be renewed (#1524); names the `npm run saxo:login` fix */
  saxoSessionLostAlerts?: SaxoSessionLostAlertChannel;
  /** Weekly reminder of when the Saxo session was last refreshed (#1524) */
  saxoWeeklyReminderAlerts?: SaxoWeeklyReminderAlertChannel;
}

/** Everything the composition root cannot build from in-repo code */
export interface ProductionConfig extends AlertChannelSlots {
  /** The shared SQLite handle (`openSharedStore(...)`) every store here is built over */
  db: StoreHandle;
  clock: Clock;
  /** `paper` for the first run; `live` only after graduation (CLAUDE.md) */
  mode: 'live' | 'paper' | 'backtest';

  // Transports with no in-repo implementation
  /**
   * Alpaca trading REST surface. Optional: when omitted this module builds
   * one with the endpoint derived from `mode` (a live host from a non-live
   * mode is refused, #293).
   */
  alpacaBrokerClient?: AlpacaBrokerClient;
  /**
   * Saxo OpenAPI surface, read only when `SAMURAI_BROKER=saxo` (#1400).
   * `SaxoHttpBrokerClient` requires a `tokenSource` or
   * `SAXO_SIM_ACCESS_TOKEN` (#1523); no Saxo credentials exist on the dev
   * host, so this seam is how every in-repo Saxo boot runs today.
   */
  saxoBrokerClient?: SaxoOpenApiClient;
  /** Alpaca market-data REST surface; defaults to `AlpacaHttpDataClient` on `dataSourceAssetClass` */
  alpacaDataClient?: AlpacaMarketDataClient;
  /**
   * Approval round-trip behind Verdict's HITL gate. No adapter exists
   * (ADR-0007/ADR-0013: no human gate anywhere), so the composition root
   * falls back to `UnwiredApprovalChannel`, which throws if reached.
   */
  approvals?: ApprovalChannel;
  /** How long a fill may stay unpriced before escalation; only meaningful against `fillPollIntervalMs` */
  unpricedFillAgeOutMs?: number;
  /** WorldMonitor CII reads (ADR-0002; live wiring parked during paper trading) */
  ciiScoreProvider?: CiiScoreProvider;
  /**
   * Account accounting scalars. Omitted: builds a `BrokerAccountStateProvider`
   * over the funding read, `account_state` table, and `ClosedTrade` store.
   * To change only where cash/equity are read from, supply `accountFunding`
   * instead — this field replaces the session-boundary/peak-equity/loss-streak
   * machinery too.
   */
  accountState?: AccountStateProvider;
  /**
   * The venue ledger `cash`/`equity` are read from, when not Alpaca's
   * `GET /v2/account` (#1509). Narrower than `accountState` on purpose: the
   * Saxo venue needs only a GBP-native funding read, sharing the venue-neutral
   * session/high-water-mark/loss-streak machinery. Ignored when `accountState`
   * is supplied.
   */
  accountFunding?: AccountFundingSource;
  /** Realized-vol reading for the volatility breaker tier — no in-repo indicator (#234) */
  volatility?: VolatilityReadingProvider;

  // Stage configuration (shapes, not values — tuned in paper trading)
  traderConfig: TraderConfig;
  riskConfig: RiskConfig;
  verdictConfig: VerdictConfig;
  executionConfig: ExecutionConfig;
  correlationConfig: CorrelationConfig;
  breakerConfig: BreakerConfig;
  costConfig: CostConfig;
  ciiConsumerConfig: CiiConsumerConfig;

  // Optional composition knobs
  /**
   * Defaults to `SMOKE_TEST_UNIVERSE`, deliberately narrow so a test cannot
   * inherit live instruments by omission. The shipped paper entrypoint
   * supplies `DEFAULT_UNIVERSE` via `paperStartingProfile`.
   */
  universe?: readonly UniverseInstrument[];
  /**
   * Forces the asset class of a single-class market-data source, for when
   * `universe` is empty or the caller wants to override it. For a mixed
   * universe, `buildAlpacaDataSource` routes per instrument instead (#381).
   */
  dataSourceAssetClass?: 'crypto' | 'stocks';
  /**
   * The vendor seam for LSE leveraged-ETP marks (#734) — the only thing that
   * can price the live equity leg. Consulted only when `universe` holds an
   * `lse_ticker`; if it does and this is omitted, the orchestrator refuses to
   * start rather than routing an LSE symbol to Alpaca. Deliberately no
   * default — which vendor may lawfully serve a live LSE quote is tracked by
   * #895.
   */
  lseMarkClient?: LseMarkClient;
  /**
   * Overrides the `AlpacaBrokerAdapter` this module would otherwise build —
   * the dual-target seam (ADR-0001) for `SimulatedBrokerAdapter` or a future
   * ccxt/IBKR adapter
   */
  broker?: BrokerAdapter;
  /** Overrides the `AlpacaDataSource` this module would otherwise build — same rationale as `broker` */
  dataSource?: DataSource;
  /**
   * Overrides the outside benchmarks' series reader (#981, under #636).
   * Separate seam from `dataSource`: `dataSource` becomes `LseMarkDataSource`
   * once LSE tickers enter the universe, and that source refuses `'SPY'`
   * (#734) — benchmarks are reference series and must not route through it.
   */
  benchmarkSeriesSource?: BenchmarkSeriesSource;
  /**
   * Overrides the equities OHLCV fallback fetcher (#562) — serves bars while
   * the primary vendor is throwing. Ignored when `dataSource` is supplied.
   */
  equitiesFallbackBarFetcher?: BarFetcher;
  /**
   * Polygon equities fallback's outbound pacing (#822). Ignored when
   * `equitiesFallbackBarFetcher` is supplied. Defaults to
   * `resolveFallbackPacing()` (`DEFAULT_POLYGON_PACING` plus any
   * `SAMURAI_PACING_POLYGON_*` override).
   */
  fallbackPacing?: TokenBucketConfig;
  /**
   * Overrides the `AnthropicLlmClient` built around `NousMessagesClient`
   * (#274, ADR-0009). Default resolves `NOUS_BASE_URL`, a key and a model via
   * `nousCredentials('debate')`, and warns at build time since this turns on
   * real, billed calls whenever the key is set.
   */
  llmClient?: LlmClient;
  /** Indicator the volatility breaker tier reads, per instrument. Defaults to ATR(14). */
  volatilityIndicator?: IndicatorSpec;
  /**
   * Session calendar for stock gating — also the boundary the stocks
   * daily-PnL figure resets on via `sessionStart` (#331/#332)
   */
  tradingCalendar?: TradingCalendar;
  /**
   * Optional narrowing of when equities may be ENTERED, inside a session
   * `tradingCalendar` has already opened (#706).
   *
   * This is an ENTRY window; `SchedulerConfig.stocksTradingWindow` — same
   * name, one layer down — is a TICK gate. `buildProductionOrchestrator`
   * wraps this in `withFlattenTail` and hands the union to the Scheduler —
   * a bare entry predicate reaching the Scheduler un-composed would delete
   * every tick that could land in the flatten tail and switch flat-by-close
   * off (shipped once, fixed by the union).
   *
   * Deliberately separate from `tradingCalendar`: that one is authoritative
   * for session begin/end and the flatten offset (#657); narrowing it would
   * move all three. `londonEntryWindow()` supplies the default.
   */
  stocksTradingWindow?: (instant: Date) => boolean;
  /** Sticky breaker rows recovered from a prior process, if any */
  initialBreakerState?: readonly PersistedBreakerState[];
  /** Wall-clock gap between tick starts. Default 60s. */
  tickIntervalMs?: number;
  /** Heartbeat cadence, independent of the tick cadence. Default 15 minutes (`DEFAULT_HEARTBEAT_INTERVAL_MS`, #342). */
  heartbeatIntervalMs?: number;
  /**
   * Gap between fill polls, end of one poll to start of the next. Default
   * 15s, deliberately tighter than the tick cadence since protective legs
   * are resized from cumulative filled quantity between polls.
   */
  fillPollIntervalMs?: number;
  /** Gap between GDELT GKG polls. Default 5 minutes (`DEFAULT_GDELT_POLL_INTERVAL_MS`, #556). */
  gdeltPollIntervalMs?: number;
  /**
   * The GDELT fetcher, injectable. GDELT is open data with no credential
   * gate, so tests must stub this explicitly or they silently hit the live
   * vendor (a ~3.4MB download) on every run.
   */
  gdeltClient?: GdeltGkgClient;
  /** Gap between Polymarket macro polls. Default 1 hour (`DEFAULT_POLYMARKET_POLL_INTERVAL_MS`, #504). */
  polymarketPollIntervalMs?: number;
  /** The Polymarket fetcher, injectable — same no-credential-gate reason as `gdeltClient` */
  polymarketClient?: PolymarketWireClient;
  /**
   * Bounds concurrent instrument passes within one tick. Default 1. No
   * longer the system's LLM throttle (#388) — `rateLimiterConfig` holds that
   * line now, unaffected by this number.
   */
  maxConcurrentInstruments?: number;
  /**
   * Nous calls this process may have in flight at once, across every client
   * (#1080). Orthogonal to `maxConcurrentInstruments` (bounds passes) and
   * `rateLimiterConfig` (bounds calls per time window) — this bounds
   * simultaneity. Defaults to `DEFAULT_MAX_IN_FLIGHT_LLM_CALLS`.
   */
  maxInFlightLlmCalls?: number;
  /**
   * What the in-flight gate assumes a Nous call takes, in ms, when charging
   * a caller against its queue-wait budget (#1080). Not a timeout. Defaults
   * to `DEFAULT_EXPECTED_NOUS_CALL_MS`.
   */
  expectedLlmCallMs?: number;
  /**
   * Per-asset-class LLM budget for the Debate Engine's `RateLimiter` (#388).
   * Optional with fallback `DEFAULT_LLM_RATE_LIMIT_CONFIG`; `buildDebateStep`
   * requires a `RateLimiter` positionally, so there is always one in effect.
   */
  rateLimiterConfig?: RateLimiterConfig;
  /**
   * Total USD this process may spend on LLM calls before it stops starting
   * new debates (ADR-0008). Cumulative, does not refill (`SqliteSpendCap`).
   * Absence is warned about loudly at startup rather than defaulted.
   */
  llmBudgetUsd?: number;
  /**
   * The environment `readProductionEnvironment` reads. Defaults to
   * `process.env`; tests pass a record instead of mutating the process env.
   */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Declared capital ceiling a live run is bounded by, in account currency
   * (#511). Caps the equity the Trader sizes against at
   * `min(ceiling, equity)` — a ceiling on the derivation, never a floor.
   * Absent everywhere except a live boot; `undefined` means "no ceiling",
   * not "ceiling of zero". Does NOT re-anchor `riskConfig`'s notional caps
   * at runtime — those are derived from this at profile-build time.
   */
  capitalCeilingUsd?: CapitalCeilingUsd;
  /**
   * The USD-per-GBP rate `capitalCeilingUsd` was converted at, if it was
   * converted at all (#1180). Present means the ceiling is derived from
   * `LIVE_BOOK_GBP` times this rate; absent means it was declared directly
   * in account currency.
   */
  capitalCeilingUsdPerGbp?: number;
  /** Whether the market-intelligence sentiment agent runs. Defaults from `SAMURAI_SENTIMENT` (`off` disables). */
  sentimentEnabled?: boolean;
  /**
   * Whether the sentiment agent retrieves live X posts rather than asking a
   * model what it remembers (#969). Defaults from `SAMURAI_SENTIMENT_RETRIEVAL`
   * (`on` enables; polarity is deliberately opposite `sentimentEnabled`'s,
   * so live retrieval must be switched on explicitly).
   */
  sentimentRetrieval?: boolean;
  /**
   * How many X posts each sentiment call retrieves (#969). Defaults from
   * `SAMURAI_X_MAX_RESULTS`. Held to the same integer `>= 1` bound the env
   * path enforces (`requireIntegerAtLeast`) — an injected value that skips
   * this check reaches `XSearchClient`'s clamp instead of a refusal.
   */
  xMaxSearchResults?: number;
  /**
   * The Market Intelligence archive (#554) — its own database, not `db`,
   * since SQLite has a single writer and a news pull must not hold the lock
   * while Execution journals a flatten. Absent means the deterministic news
   * path does not run and `sentiment`/`fundamental` report no data.
   */
  miArchive?: MiArchiveStore;
  /**
   * Overrides the `RateLimiter` built from `rateLimiterConfig`. Exists for
   * `smoke-run.ts`, which holds the instance to assert the limiter actually
   * saw the run's LLM calls.
   */
  llmRateLimiter?: RateLimiter;
  /**
   * Per-venue outbound pacing for the broker adapters' token buckets (#299).
   * Defaults to `resolveVenuePacing()`. Injected only by tests that need a
   * bucket that does not pace at wall-clock speed.
   */
  venuePacing?: VenuePacingConfig;
  /**
   * Feedback Loop's daily batch (ADR-0004 §3) — wired here rather than as a
   * `TickSteps` member since it runs on its own schedule, not per instrument.
   * Omit it and the daily timer never starts, warned loudly at startup (#327).
   */
  feedback?: FeedbackCycleConfig;
  logger?: Logger;
}

export interface FeedbackCycleConfig {
  config: FeedbackConfig;
  /** Per-cycle override for `ProductionConfig.loosenNotices` */
  loosenNotices?: LoosenNotificationChannel;
  /**
   * Param/threshold moves to consider this cycle. Empty is a valid,
   * meaningful cycle: analyst weights are attributed from closed trades, not
   * proposed.
   */
  proposals?: TuningProposal[];
  /** Default 24h */
  intervalMs?: number;
  /**
   * What makes `computeMetrics` — and the four kill-lines — actually run
   * each cycle (#327). Deliberately not defaulted: wiring it is a decision
   * about whether this deployment wants the kill-line detector armed, and
   * defaulting it would arm it by omission. `paperStartingProfile` opts in
   * (#379); omitting it is announced at `warn` startup rather than silent.
   */
  metrics?: DailyMetricsConfig;
}

/**
 * The stores a real `DailyMetricsSource` needs but a checked-in profile
 * cannot hold (#379) — `paperStartingProfile` supplies tuning values and
 * opens no database, so wiring belongs to the composition root instead
 */
export interface DailyMetricsSourceDeps {
  /**
   * The shared handle, not a pre-built equity store: the root's own
   * `SqliteDailyEquityStore` does not exist when a caller injects its own
   * provider
   */
  db: StoreHandle;
  /** The root's own instance — the same reader `runDailyCycle` attributes over */
  trades: ClosedTradeStore;
  logger: Logger;
  /**
   * The frozen Stage 2 selections (#384) — where `DailyMetricsSample
   * .revalidation` comes from, since PBO/OOS-Sharpe/DSR are walk-forward
   * statistics a live run cannot compute about itself
   */
  stage2Selections: SqliteStage2SelectionStore;
  /** Ages a selection out; the root's clock, so a replay ages deterministically */
  clock: Clock;
}

/** Deferred construction of a `DailyMetricsSource` — see `DailyMetricsSourceDeps` */
export type DailyMetricsSourceFactory = (deps: DailyMetricsSourceDeps) => DailyMetricsSource;

export interface DailyMetricsConfig {
  /**
   * Supplies the day's already-computed suite, or `undefined` for "none this
   * cycle". Either a built source or a factory this root resolves once at
   * construction (#379), never per cycle.
   */
  source: DailyMetricsSource | DailyMetricsSourceFactory;
  /**
   * The frozen selected config's backtest Sharpe — the divergence check's
   * baseline. A value `<= 0` cannot breach by design (`liveBacktestDivergence`
   * refuses to manufacture a breach off a broken reference).
   *
   * Superseded as the primary source by #375: a frozen Stage 2 selection
   * (`stage2_selected_config`, migration 0014) carries the selected config's
   * backtest Sharpe and is preferred whenever a fresh one exists. This field
   * is the fallback for a deployment that has never run Stage 2.
   */
  backtest_reference_sharpe: number;
}

/**
 * The divergence baseline (#375): the frozen Stage 2 selection when there is
 * a fresh one, the operator-supplied config otherwise. With a selection for
 * both asset classes, takes the higher backtest Sharpe — the reading more
 * likely to register divergence, the conservative direction. A stale
 * selection is ignored: a verdict about an old sample says nothing about
 * today's regime, and this drives `autoTighten`.
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
 * Resolves the two forms `DailyMetricsConfig.source` accepts (#379), by
 * `typeof === 'function'`. On ambiguity the factory reading wins — the safe
 * direction, since a factory misread as a source would silently never run.
 */
export function resolveDailyMetricsSource(
  source: DailyMetricsSource | DailyMetricsSourceFactory,
  deps: DailyMetricsSourceDeps,
): DailyMetricsSource {
  return typeof source === 'function' ? source(deps) : source;
}
