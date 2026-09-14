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
  UnpricedFillAlertChannel,
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
import type { AnalystSkipAlertChannel } from './analysts-adapter.js';
import type { CalendarFallbackAlertChannel } from './calendar-fallback-alert.js';
import type { CapitalCeilingUsd } from './capital-ceiling.js';
import { DEFAULT_STAGE2_MAX_AGE_DAYS } from './daily-equity-metrics-source.js';
import type { DataFailoverAlertChannel } from './data-failover.js';
import type { AccountStateProvider, VolatilityReadingProvider } from './direct-bind.js';
import type { ExitValuationDegradedAlertChannel } from './exit-valuation-alert.js';
import type { LlmFailureRateAlertChannel } from './llm-failure-rate-guard.js';
import type { LseCalendarCoverageAlertChannel } from './lse-calendar-coverage-alert.js';
import type { MiCoverageAlertChannel } from './mi-coverage.js';
import type { ThresholdClampAlertChannel } from './threshold-clamp-alert.js';
import type { TickSkipAlertChannel } from './tick-skip-alert.js';
import type { TraderDiagnosticAlertChannel } from './trader-diagnostic-alert.js';

/**
 * The nine outbound operator-escalation transports — the fields
 * `alert-transport.ts`'s `ALERT_CHANNEL_FIELDS` must cover, and the reason
 * this interface exists as its own type rather than as eight scattered
 * fields on `ProductionConfig` (#551): one authoritative list of "what is an
 * alert channel" that both `ProductionConfig` and `ALERT_CHANNEL_FIELDS` are
 * checked against, so a ninth field added here without a matching entry
 * there fails `yarn typecheck` instead of waiting to be noticed by a human —
 * the same hole found and patched by hand eight times running (#431, #465,
 * #551, …; see `ALERT_CHANNEL_FIELDS`'s own doc comment for the tally).
 *
 * `approvals` (below, on `ProductionConfig` directly) is deliberately NOT a
 * member: it is an inbound round trip (`requestApproval` returns an
 * *answer*), not an outbound alert, and wiring it is #275's remaining half —
 * see `alert-transport.ts`'s file doc.
 */
export interface AlertChannelSlots {
  /**
   * Trade channel the dead-man's-switch heartbeat posts over. Optional: when
   * omitted the catalogue's log-only form stands in, which is a diary
   * rather than a dead-man's switch — its whole point is that its SILENCE is
   * noticed by something outside this process.
   *
   * **The shipped entrypoint no longer reaches that default by omission
   * (#322).** `startFromEnvironment` resolves `SAMURAI_ALERTS` — a required
   * variable with no default — and passes the catalogue's Telegram form over a real
   * `TelegramBotApiClient` (#275) under `telegram`, or nothing at all under an
   * explicitly-named `log-only`. This field stays the port rather than a
   * Telegram client, so a programmatic caller can still inject its
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
   * Where a restart-time orphaned `go` verdict is reported. Defaults to the
   * log; the Telegram form (`orphanAlerts` in alert-catalogue.ts) is the
   * reachable-from-a-phone implementation, wired by `SAMURAI_ALERTS=telegram`
   * (#322).
   */
  orphanAlerts?: OrphanAlertChannel;
  /**
   * Where a fill the venue reports filled but will not price is escalated once
   * it has been stuck too long (#298). Defaults to
   * `loggingAlertChannel('unpricedFillAlerts', …)`, with the same caveat as
   * `heartbeatChannel`: the default is reachable only by an operator reading
   * the log stream. `tradeChannelAlert('unpricedFillAlerts', …)`
   * is what an unattended soak (#238) needs, and `SAMURAI_ALERTS=telegram`
   * (#322) is what supplies it.
   */
  unpricedFillAlerts?: UnpricedFillAlertChannel;
  /**
   * Where a residual position `ingestFills()` failed to re-arm after a
   * partial flatten is escalated (#525) — posted only on a FAILED re-arm,
   * never on a successful one (see `ResidualExposureAlert`'s doc for why).
   * Defaults to `loggingAlertChannel('residualExposureAlerts', …)`, with the same caveat
   * as `unpricedFillAlerts`: reachable only by an operator reading the log
   * stream. `tradeChannelAlert('residualExposureAlerts', …)`
   * is what an unattended soak (#238)
   * needs, and `SAMURAI_ALERTS=telegram` (#322, wired for this channel by
   * #551) is what supplies it — the same move every other channel on this
   * interface makes.
   */
  residualExposureAlerts?: ResidualExposureAlertChannel;
  /**
   * Where an emulated crypto OCO's DOUBLE FILL is escalated (#586): both
   * protective legs filled inside one poll window, so the lot over-closed
   * and a reverse position may be open at the venue — the risk the owner
   * accepted when choosing local emulation over Alpaca's crypto-rejected
   * native order classes, surfaced rather than hidden. Defaults to
   * `loggingAlertChannel('ocoDoubleFillAlerts', …)`, with the same caveat as
   * `unpricedFillAlerts`: reachable only by an operator reading the log
   * stream. `tradeChannelAlert('ocoDoubleFillAlerts', …)` is
   * what an unattended soak (#238) needs, and `SAMURAI_ALERTS=telegram` is
   * what supplies it — the ninth `ALERT_CHANNEL_FIELDS` member.
   */
  ocoDoubleFillAlerts?: OcoDoubleFillAlertChannel;
  /**
   * Where a partial entry fill on a venue whose protective-leg resizing is
   * UNVERIFIED is escalated (#1215) — the lot may be sitting under a stop
   * sized to the ORIGINAL amount, which over-closes into a reversed position
   * if it fires. Saxo's, and REQUIRED by `SaxoBrokerAdapter`'s constructor
   * with no default of its own; the composition root supplies
   * `loggingAlertChannel('legResizeAlerts', …)` when nothing else does, with the
   * same caveat as `unpricedFillAlerts` — reachable only by an operator
   * reading the log stream. `tradeChannelAlert('legResizeAlerts', …)`
   * is what `SAMURAI_ALERTS=telegram` supplies.
   */
  legResizeAlerts?: LegResizeUnverifiedAlertChannel;
  /**
   * Where a dormant Saxo related-order pair the adapter cannot resolve is
   * escalated (#1215/#1216): no master on the open-orders list, every leg
   * `NotWorking`, and an audit trail that never goes terminal. The adapter
   * deliberately does NOT cancel on that evidence, so the legs stand until an
   * operator acts — which is the whole reason this has to reach a phone.
   * Defaults and transport as `legResizeAlerts`.
   */
  dormantLegsAlerts?: DormantLegsUnresolvedAlertChannel;
  /**
   * Where a priced Saxo fill whose `Uic` resolves to no pool line is
   * escalated (#1302). The fill is REFUSED rather than booked — on a GBX line
   * an unscaled venue price is 100x wrong — and the refusal is not
   * self-limiting: a persistent cause re-drives the same row every poll, no
   * lot goes terminal, and nothing else changes. Defaults and transport as
   * `legResizeAlerts`.
   */
  priceUnitAlerts?: UnresolvedPriceUnitAlertChannel;
  /**
   * Where a `flatten_submissions` row `reconcile()`'s sweep could not settle
   * is escalated (#519) — genuine ignorance, or a venue contradiction on an
   * already-acked row (`reconcileFlatten`, execution/reconcile.ts).
   * Defaults to `loggingAlertChannel('flattenReconcileAlerts', …)`, with the same caveat
   * as `residualExposureAlerts`: reachable only by an operator reading the
   * log stream. `tradeChannelAlert('flattenReconcileAlerts', …)`
   * is what an unattended soak (#238)
   * needs, and `SAMURAI_ALERTS=telegram` supplies it, the same move #551
   * made for `residualExposureAlerts` — the tenth `ALERT_CHANNEL_FIELDS`
   * member. The two channels deliberately diverge since #1349: this one
   * pages the live arm only, with the surface `trace_id` in the text;
   * `residualExposureAlerts` pages both arms unlabelled (#1348).
   */
  flattenReconcileAlerts?: FlattenReconcileAlertChannel;
  /**
   * Where a run of consecutive analyst quorum skips is escalated (#431,
   * analysts-spec.md story 25). Defaults to `loggingAlertChannel('analystSkipAlerts', …)`,
   * with the same caveat as the others: an analyst stage that has skipped every
   * tick for six hours is the failure an unattended soak cannot see any other
   * way — the heartbeat keeps beating and a skipped tick at a 15-minute cadence
   * looks like a quiet market. `tradeChannelAlert('analystSkipAlerts', …)` is what
   * `SAMURAI_ALERTS=telegram` supplies.
   */
  analystSkipAlerts?: AnalystSkipAlertChannel;
  /**
   * Where a kill-threshold breach goes (#93, wired #327). Defaults to
   * `loggingAlertChannel('breachAlerts', …)`; `SAMURAI_ALERTS=telegram` replaces it with
   * `tradeChannelAlert('breachAlerts', …)` at the entrypoint, like the other outbound
   * alerts (alert-transport.ts).
   */
  breachAlerts?: BreachAlertChannel;
  /**
   * Where the notice of an APPLIED risk-threshold LOOSENING goes (#91, wired
   * #366, retargeted #736). Defaults to `loggingAlertChannel('loosenNotices', …)`;
   * `SAMURAI_ALERTS=telegram` replaces it with `tradeChannelAlert('loosenNotices', …)`,
   * like the other outbound escalations (alert-transport.ts).
   *
   * Top-level rather than a field of `feedback` for the reason every other
   * transport is: `paperStartingProfile` supplies tuning *values* and names no
   * transport, because where an operator's alerts go is a deployment decision
   * and not something a checked-in file should hard-code.
   * `FeedbackCycleConfig` keeps its own `loosenNotices` override, which wins
   * over this when both are given (see `runFeedbackCycle`).
   *
   * There is no live-mode refusal here, and none is needed: this port
   * returns `void` and is asked nothing, so no implementation can fabricate
   * consent by answering wrongly — unlike `ApprovalChannel`, whose whole
   * contract is an answer this dial could still act on if it were ever
   * turned back. A notice nobody reads costs visibility of a move that has
   * already been applied and logged — it does not gate the move, because
   * since ADR-0013 Decision 2 nothing does.
   */
  loosenNotices?: LoosenNotificationChannel;
  /**
   * Where a degraded-but-continuing Trader condition is escalated (#698) — a
   * calendar reporting a close already in the past, a non-crypto calendar that
   * cannot resolve a session at all, or a non-finite ATR on a full window.
   * Absent = log-only, and there is deliberately NO log-only form standing
   * in behind it (`UNLOGGED_ALERT_IDS`), unlike `analystSkipAlerts`. `buildTraderStep` writes every
   * diagnostic to its own logger at `error` BEFORE it reaches this channel, so a
   * logging implementation would emit each condition twice; absent here means
   * "no second, audible copy", not "silent". `tradeChannelAlert('traderDiagnosticAlerts', …)`
   * is what an unattended soak (#238)
   * needs, and `SAMURAI_ALERTS=telegram` supplies it — the eleventh
   * `ALERT_CHANNEL_FIELDS` member.
   *
   * The failure it reports is the one that is hardest to see from outside: the
   * Trader keeps returning defensible answers, the heartbeat keeps beating, and
   * the book is quietly parked flat. #625 produced exactly that shape (96
   * debates, 0 trades) and it took a human reading the tables to find it.
   */
  traderDiagnosticAlerts?: TraderDiagnosticAlertChannel;
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
  /**
   * Where a degraded market-intelligence coverage gap is escalated (#752) — a
   * name in the active list with no scored item inside the staleness window.
   * Defaults to `loggingAlertChannel('miCoverageAlerts', …)`, with the same caveat as
   * `heartbeatChannel`: log-only is reachable only by an operator reading the
   * log stream, and criterion 6 of #752 is explicit that log-only does NOT
   * satisfy this alert. `tradeChannelAlert('miCoverageAlerts', …)`
   * is what an unattended soak (#238) needs,
   * and `SAMURAI_ALERTS=telegram` (#322) is what supplies it — the twelfth
   * `ALERT_CHANNEL_FIELDS` member.
   *
   * Deliberately an alert, not a refusal to start — see mi-coverage.ts's file
   * doc comment for why: a system that will not start on a data gap trades
   * nothing on exactly the days coverage is patchy.
   */
  miCoverageAlerts?: MiCoverageAlertChannel;
  /**
   * Where an out-of-bound `risk_thresholds` row tripping #638's in-code clamp
   * at RUNTIME is escalated (#766) — the live-read seam
   * (`RiskManagerImpl.evaluate()`, every tick) and the daily kill-line check
   * (`computeMetrics`). Absent = log-only, and there is deliberately NO
   * log-only form standing in behind it (`UNLOGGED_ALERT_IDS`), the same reason
   * `traderDiagnosticAlerts` has none: both catch sites already write an
   * `error`-level log line before reaching this port, so a logging
   * implementation would emit each trip twice.
   * `tradeChannelAlert('thresholdClampAlerts', …)` is
   * what an unattended soak (#238) needs, and `SAMURAI_ALERTS=telegram`
   * supplies it — the thirteenth `ALERT_CHANNEL_FIELDS` member.
   *
   * Both trips are already fail-closed on trading without this channel — an
   * out-of-bound threshold cannot place an order, and `RiskManagerImpl`
   * skips the live resolve entirely for an exit intent (index.ts), so the
   * flat-by-close flatten is unaffected either way. What an absent channel
   * costs is discoverability: a run in which the live-read clamp trips on
   * every tick looks, from outside, like a quiet market with no setups
   * (#625/#691's signature).
   */
  thresholdClampAlerts?: ThresholdClampAlertChannel;
  /**
   * Where a LIVE OHLCV failover is escalated (#562): the primary market-data
   * vendor threw for one (instrument, timeframe) and the fallback vendor is
   * serving those bars instead. Defaults to
   * `loggingAlertChannel('dataFailoverAlerts', …)`, with the same caveat as
   * `miCoverageAlerts` — the log-only stand-in cannot wake anyone, and #562's
   * third criterion is explicit that the failover must reach the LIVE
   * transport rather than the script output #560 settled for.
   * `tradeChannelAlert('dataFailoverAlerts', …)` is what
   * an unattended soak (#238) needs, and `SAMURAI_ALERTS=telegram` (#322)
   * supplies it — the fourteenth `ALERT_CHANNEL_FIELDS` member.
   *
   * An alert, never a refusal: the failover has already worked by the time
   * this fires, and the bars it produced carry the serving vendor in
   * `bars.source`. What the alert buys is that a fourteen-day unattended run
   * degrading to a second vendor is a fact somebody knows about while it is
   * happening.
   */
  dataFailoverAlerts?: DataFailoverAlertChannel;
  /**
   * Where an EXIT priced against a partly-valued book is escalated (#841):
   * a held instrument's mark could not be read or was stale, so the
   * flat-by-close flatten was valued WITHOUT it rather than suppressed
   * outright. Absent = log-only, with deliberately NO log-only form
   * standing in (`UNLOGGED_ALERT_IDS`) — both seams (`buildRiskStep`, `buildVerdictStep` in
   * direct-bind.ts) write an `error`-level line before reaching this port,
   * the same call `thresholdClampAlerts` and `traderDiagnosticAlerts` make.
   * `tradeChannelAlert('exitValuationAlerts', …)`
   * is what an unattended soak (#238)
   * needs, and `SAMURAI_ALERTS=telegram` supplies it — the fifteenth
   * `ALERT_CHANNEL_FIELDS` member.
   *
   * The condition it reports used to have NO alert at all and was strictly
   * worse: the refusal aborted the tick, `tick-loop.ts` logged `instrument
   * failed` at `error`, and the position stayed on — a leveraged ETP
   * (ADR-0016) carried overnight because a DIFFERENT instrument's feed went
   * quiet. See `exit-valuation-alert.ts` for why the degradation is safe to
   * proceed on and why this is not latched.
   */
  exitValuationAlerts?: ExitValuationDegradedAlertChannel;
  /**
   * Where a failed Alpaca `GET /v2/calendar` fetch at boot is escalated
   * (#684) — the paper equity leg fell back to the hand-entered
   * `UsEquityRegularHoursCalendar` session table instead of the venue's own.
   * Defaults to `loggingAlertChannel('calendarFallbackAlerts', …)`, with the same caveat
   * as `miCoverageAlerts`/`dataFailoverAlerts`: log-only cannot page anyone,
   * and an unattended 14-day soak needs to know its flatten boundary is
   * running on a table with a coverage cliff rather than the live one.
   * `tradeChannelAlert('calendarFallbackAlerts', …)`
   * is what `SAMURAI_ALERTS=telegram` (#322) supplies — the sixteenth
   * `ALERT_CHANNEL_FIELDS` member.
   *
   * Never a refusal to boot: see `calendar-fallback-alert.ts`'s file doc for
   * why #684 chose "alert and continue on the hand table" over refusing to
   * start on a transient network blip, and why that fallback still cannot
   * silently take the dangerous direction — the hand table's own coverage
   * cliff throws rather than guessing a normal close past it.
   */
  calendarFallbackAlerts?: CalendarFallbackAlertChannel;
  /**
   * Where the matched control (falsifier arm 2) OUT-PERFORMING the debate-driven
   * live arm is escalated (#971, under #636 and #913) — the seventeenth
   * `ALERT_CHANNEL_FIELDS` member, channel type and transport landing in the
   * SAME change like `traderDiagnosticAlerts`/`calendarFallbackAlerts` before it.
   * Defaults to `loggingAlertChannel('armDivergenceAlerts', …)`, with the same caveat as
   * `calendarFallbackAlerts`: log-only cannot page anyone, and #913 is explicit
   * that the divergence reaches the trade channel.
   * `tradeChannelAlert('armDivergenceAlerts', …)` is what
   * `SAMURAI_ALERTS=telegram` (#322) supplies.
   *
   * Deliberately its own slot rather than a reuse of `breachAlerts`: the breach
   * formatter says "KILL-THRESHOLD BREACH … thresholds auto-tightened", and
   * pushing divergence through `MetricsReport.breaches` would actually run
   * `autoTighten` — tightening the LIVE arm's sizing and not the control's,
   * which degrades the matching the comparison depends on. This is a
   * measurement, and it changes no dial.
   *
   * The condition it reports is invisible from outside by construction: both
   * arms keep trading, the heartbeat keeps beating, and the only symptom is that
   * the £58/yr debate layer is no longer earning its bill.
   */
  armDivergenceAlerts?: ArmDivergenceAlertChannel;
  /**
   * Where a materially degraded tick pass is escalated (#1084) — the
   * eighteenth `ALERT_CHANNEL_FIELDS` member, channel type and transport
   * landing in the SAME change like `armDivergenceAlerts`/
   * `calendarFallbackAlerts` before it. Defaults to
   * `loggingAlertChannel('tickSkipAlerts', …)`, with the same caveat as
   * `calendarFallbackAlerts`: log-only cannot page anyone. The real-world
   * measurement that motivated this slot lives in `tick-skip-alert.ts`'s file
   * doc, not repeated here.
   * `tradeChannelAlert('tickSkipAlerts', …)` is what
   * `SAMURAI_ALERTS=telegram` (#322) supplies.
   *
   * Never a change to the skip mechanism itself: `startTickLoop`'s existing
   * `info`-level "still running from a previous pass" log and its
   * `busy`/`ready`/`duplicated` classification (#669, #692) are untouched —
   * see `tick-skip-alert.ts`'s file doc. `isMateriallyDegraded` there states,
   * as a named constant with its reasoning, the fraction-of-plan-plus-floor
   * threshold this slot is escalated against.
   *
   * The condition it reports is invisible from outside by construction: a
   * degraded pass produces no thrown error and no missed heartbeat — the
   * loop just quietly does less work on more of the universe than the
   * operator sized it for.
   */
  tickSkipAlerts?: TickSkipAlertChannel;
  /**
   * Where a prompt-tier crossing is escalated (#1155) — the nineteenth
   * `ALERT_CHANNEL_FIELDS` member, channel type and transport landing in the
   * SAME change like `tickSkipAlerts`/`armDivergenceAlerts` before it.
   * Defaults to `loggingAlertChannel('promptTierAlerts', …)`, with the same caveat as
   * `calendarFallbackAlerts`: log-only cannot page anyone, and a run whose
   * cost rate silently jumped 2.5x mid-run needs more than a log line an
   * unattended soak (#238) never reads. `tradeChannelAlert('promptTierAlerts', …)`
   * is what `SAMURAI_ALERTS=telegram` (#322)
   * supplies.
   *
   * The condition it reports is invisible from outside by construction: the
   * meter keeps writing rows, the cap keeps enforcing, and the only symptom
   * is that `llm_spend` starts burning faster than the same call volume did
   * a moment before — precisely `crossesPromptTier`'s own doc comment's "a
   * 2.5x unit-cost change happening silently inside the meter", the defect
   * this channel exists to end.
   */
  promptTierAlerts?: PromptTierAlertChannel;
  /**
   * Where the LIVE equity leg's own table-coverage horizon is escalated
   * (#1378). `LseRegularHoursCalendar`'s hand-entered
   * tables (`LSE_HOLIDAYS`/`LSE_HALF_DAYS`, trading-calendar.ts) are checked
   * only through `LSE_TABLE_COVERAGE_END`; `assertLseCalendarCoverage`
   * (`lse-calendar-coverage-guard.ts`) posts this once that date is within
   * `LSE_COVERAGE_ALERT_HORIZON_DAYS`. Defaults to
   * `loggingAlertChannel('lseCalendarCoverageAlerts', …)`, with the same caveat as
   * `calendarFallbackAlerts`: log-only cannot page anyone, and the live leg
   * running past this date is the exact overnight-carry risk ADR-0014
   * forbids (an unmodelled half-day reads as an ordinary 16:30 close — see
   * `LSE_HALF_DAYS`'s doc). `tradeChannelAlert('lseCalendarCoverageAlerts', …)`
   * is what
   * `SAMURAI_ALERTS=telegram` (#322) supplies.
   *
   * Distinct from `calendarFallbackAlerts` (#684): that one is the PAPER
   * leg's fetch-failure fallback, this one is the LIVE leg's own static
   * table running out. Also distinct from the hard boot refusal itself —
   * this alert fires ONLY ahead of the cliff, while there is still time to
   * extend the tables; once the date is past, boot refuses outright instead
   * of reaching this channel (`assertLseCalendarCoverage`'s doc).
   */
  lseCalendarCoverageAlerts?: LseCalendarCoverageAlertChannel;
  /**
   * Where a sustained `debate_log.termination_cause = 'llm_failure'` rate is
   * escalated (#1396) — `checkLlmFailureRate`'s edge-triggered alert
   * (`llm-failure-rate-guard.ts`) posts here once the 24h rate crosses
   * `LLM_FAILURE_RATE_THRESHOLD` on enough samples. Defaults to
   * `loggingAlertChannel('llmFailureRateAlerts', …)`, with the same caveat as
   * `miCoverageAlerts`: log-only cannot page anyone, and an LLM outage
   * masquerading as ordinary latency-budget truncation is exactly the
   * failure mode this alert exists to surface. `tradeChannelAlert('llmFailureRateAlerts', …)`
   * is what `SAMURAI_ALERTS=telegram`
   * (#322) supplies.
   */
  llmFailureRateAlerts?: LlmFailureRateAlertChannel;
  /**
   * Where a fill fee reported outside book currency is escalated (#1465) —
   * the other half of #1220, which raised `FEE_CURRENCY_NOT_BOOK_CURRENCY` at
   * `error` with no channel behind it. `warnOnNonSterlingFee`
   * (pipeline/execution/ingest-fills.ts) posts here. Absent = log-only, and
   * there is deliberately NO log-only form standing in behind it
   * (`UNLOGGED_ALERT_IDS`), the
   * same reason `traderDiagnosticAlerts`/`thresholdClampAlerts` have none:
   * `warnOnNonSterlingFee` already writes an `error`-level log line before
   * reaching this port, so a logging implementation would emit each trip
   * twice. `tradeChannelAlert('nonSterlingFeeAlerts', …)`
   * is what an unattended soak (#238)
   * needs, and `SAMURAI_ALERTS=telegram` supplies it — the twenty-fifth
   * `ALERT_CHANNEL_FIELDS` member.
   *
   * A foreign fee means an instrument was traded that `tradeableUniverse()`
   * should already have excluded (#1220's sterling-only gate) — a
   * selection-layer defect that already reached the venue with real money,
   * not a transient data glitch.
   */
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel;
}

/**
 * Everything the composition root cannot build from in-repo code. See the
 * file doc comment for why the transports are injected rather than
 * constructed.
 */
export interface ProductionConfig extends AlertChannelSlots {
  /** The shared SQLite handle (`openSharedStore(...)`) every store here is built over. */
  db: StoreHandle;
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
   * Saxo OpenAPI surface, read ONLY when `SAMURAI_BROKER=saxo` selects the
   * Saxo venue (#1400, production/saxo-venue.ts). Optional for
   * `alpacaBrokerClient`'s reason: `SaxoHttpBrokerClient` refuses to be
   * constructed without `SAXO_OPENAPI_TOKEN`, so a test — or any offline
   * composition root — needs a way to exercise the venue without a
   * credential. There are no Saxo credentials on the development host and the
   * SIM token is a 24-hour bearer, so this seam is what every in-repo Saxo
   * boot goes through today.
   */
  saxoBrokerClient?: SaxoOpenApiClient;
  /**
   * Alpaca market-data REST surface, for bars and latest quotes. Optional for
   * the same reason; defaults to `AlpacaHttpDataClient` on
   * `dataSourceAssetClass`.
   */
  alpacaDataClient?: AlpacaMarketDataClient;
  /**
   * Approval round-trip behind Verdict's HITL gate (6). No adapter for it
   * exists in the repo (ADR-0007, ADR-0013: no human gate anywhere), so the
   * composition root falls back to `UnwiredApprovalChannel`, which throws if
   * the gate is ever reached.
   */
  approvals?: ApprovalChannel;
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
   * The vendor seam for LSE leveraged-ETP marks (#734) — the ONLY thing that
   * can price the live equity leg.
   *
   * Consulted only when `universe` actually holds an `lse_ticker` from
   * `lse-etp-pool.ts`; every shipped profile today holds none, so omitting it
   * changes nothing. When the universe DOES hold one and this is omitted, the
   * orchestrator refuses to start rather than routing an LSE symbol to Alpaca,
   * which does not list it — see `buildLseMarkSourceIfNeeded` in defaults.ts.
   *
   * There is deliberately no default. Which vendor may lawfully serve a live
   * LSE quote is an OPEN OWNER DECISION (docs/research/34-lse-mark-source-options.md),
   * and is tracked by #895; a default here would be this repo's
   * dominant defect class — a mechanism that looks wired and serves nothing.
   */
  lseMarkClient?: LseMarkClient;
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
   * Overrides the OUTSIDE BENCHMARKS' series reader (#981, under #636).
   *
   * A separate seam from `dataSource` on purpose, and the separation is the
   * fix: `dataSource` replaces the LIVE TRADING path's source, which is
   * universe-derived and becomes `LseMarkDataSource` — a source that refuses
   * `'SPY'` by design (#734) — the moment #751 puts LSE tickers into the
   * universe. The benchmarks are reference series, never order targets, so
   * they must not be routed through that seam at all; by default they read
   * `buildBenchmarkDataSource`, which takes no universe.
   *
   * Injectable for the same reason `equitiesFallbackBarFetcher` is: the
   * default path builds an Alpaca client on first read, and a test — or any
   * offline composition root — needs to drive the benchmark cycle without a
   * credential and without a network call.
   */
  benchmarkSeriesSource?: BenchmarkSeriesSource;
  /**
   * Overrides the EQUITIES OHLCV FALLBACK fetcher (#562) — what serves bars
   * while the primary vendor is throwing. Defaults to a lazily constructed
   * `PolygonBarsClient` (data-failover.ts); supplying `dataSource` bypasses
   * this field entirely, since that seam replaces the whole wrapped source.
   *
   * Injectable for the same reason `alpacaDataClient` is: `PolygonBarsClient`
   * refuses to be constructed without `POLYGON_API_KEY`, so a test — or any
   * offline composition root — needs a way to exercise the failover path
   * without a credential.
   */
  equitiesFallbackBarFetcher?: BarFetcher;
  /**
   * The Polygon equities fallback's outbound pacing (#822), config-first
   * rather than read from `process.env` mid-wiring — the composition root
   * passes this straight through to `buildFailoverDataSource` UNRESOLVED
   * (no `?? resolveFallbackPacing(...)` at this module's call site); the env
   * read/warn only happens inside `buildFailoverDataSource`'s own default
   * branch, and only when `equitiesFallbackBarFetcher` is also omitted
   * (#825 — resolving it unconditionally warned about a variable a run with
   * an injected fetcher would never consult). Ignored entirely when
   * `equitiesFallbackBarFetcher` is supplied, for the same reason: there is
   * no Polygon client left for it to pace. Defaults to
   * `resolveFallbackPacing()`'s result — `DEFAULT_POLYGON_PACING` with any
   * `SAMURAI_PACING_POLYGON_*` override applied — same convention as
   * `venuePacing` below, minus the eager resolution at THIS call site.
   */
  fallbackPacing?: TokenBucketConfig;
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
  /**
   * OPTIONAL narrowing of when equities may be ENTERED, inside a session
   * `tradingCalendar` has already opened (#706).
   *
   * **This field is an ENTRY window; `SchedulerConfig.stocksTradingWindow` —
   * same name, one layer down — is a TICK gate. Do not read the two as one
   * field.** What you pass here is a policy about entries;
   * `buildProductionOrchestrator` wraps it in `withFlattenTail` (production.ts,
   * see `production/stocks-tick-window.ts`) and hands the UNION to the
   * Scheduler, which applies it to `TickPlan.instruments` and therefore gates
   * the whole pipeline pass, Trader included.
   *
   * That composition is load-bearing and not a convenience. The Trader is the
   * only thing that flattens, so a bare entry predicate reaching the Scheduler
   * un-composed deletes every tick that could land in the flatten tail and
   * switches flat-by-close off — shipped once on this branch and fixed by the
   * union. If you construct a Scheduler directly rather than through
   * `buildProductionOrchestrator`, that wrapping is yours to do.
   *
   * Deliberately a separate field rather than a narrower calendar. The
   * calendar above is authoritative for when stock sessions *begin and end* —
   * the Verdict gate reads it, the daily-PnL boundary resets on its
   * `sessionStart` (#331/#332), and the flatten offsets from its `sessionEnd`
   * (#657). A trading preference expressed by narrowing it would move all
   * three, and the flatten is a money-path rule.
   *
   * Undefined means no narrowing, which is what the harness and every existing
   * programmatic caller want. `londonEntryWindow()` supplies the overlap-only
   * default.
   */
  stocksTradingWindow?: (instant: Date) => boolean;
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
   * Gap between GDELT GKG polls. Default 5 minutes
   * (`DEFAULT_GDELT_POLL_INTERVAL_MS`, #556).
   *
   * Its own cadence rather than the tick's on purpose: one batch is the whole
   * world's macro news, not per-instrument, and a ~3.4MB download does not
   * belong on the path the analysts wait behind.
   */
  gdeltPollIntervalMs?: number;
  /**
   * The GDELT fetcher, injectable — and this seam is load-bearing for the test
   * suite, not a convenience.
   *
   * Every other vendor client here is gated by credentials: `AlpacaNewsClient`
   * throws in its constructor without keys, so a test that forgot to stub it
   * fails loudly and never reaches the network. **GDELT is open data and has no
   * such gate.** When this poller first landed, `startup.test.ts` silently
   * downloaded a live 3.4MB batch and archived 200 real rows — a unit suite
   * that fails on a plane, takes vendor latency on every run, and writes real
   * vendor data into a test fixture. Tests inject a stub here; production
   * leaves it undefined and gets the real client.
   */
  gdeltClient?: GdeltGkgClient;
  /**
   * Gap between Polymarket macro polls. Default 1 hour
   * (`DEFAULT_POLYMARKET_POLL_INTERVAL_MS`, #504).
   *
   * Its own cadence rather than the tick's, for GDELT's reason: the curated
   * table is macro, not per-instrument, so hanging it off a per-instrument
   * refresh would poll it once per universe member for one shared result.
   */
  polymarketPollIntervalMs?: number;
  /**
   * The Polymarket fetcher, injectable — load-bearing for the same reason
   * `gdeltClient` is. Polymarket's public APIs need **no key**, so nothing
   * gates a test that forgot to stub it: it would silently hit the live
   * vendor on every unit run. Tests and the offline smoke gate inject a stub
   * here; production leaves it undefined and gets the real client.
   */
  polymarketClient?: PolymarketWireClient;
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
   * Nous calls this process may have in flight at once, ACROSS EVERY CLIENT —
   * debate personas, the disagreement pass, the risk critic, MI scoring and
   * the Grok sentiment refresh (#1080). Defaults to
   * `DEFAULT_MAX_IN_FLIGHT_LLM_CALLS`.
   *
   * Orthogonal to both neighbours above. `maxConcurrentInstruments` bounds
   * instrument PASSES, each of which issues several calls; `rateLimiterConfig`
   * bounds calls per time WINDOW. Neither bounds simultaneity, which is what
   * the 2026-09-14 measurement found the provider's own latency is a function
   * of — see `DEFAULT_MAX_IN_FLIGHT_LLM_CALLS` for the numbers.
   */
  maxInFlightLlmCalls?: number;
  /**
   * What the in-flight gate should ASSUME a Nous call takes, in milliseconds,
   * when it estimates a queue wait and charges a caller's own call against its
   * budget (#1080). Defaults to `DEFAULT_EXPECTED_NOUS_CALL_MS`.
   *
   * A knob because the default is a small-sample soak figure (n = 4) and this
   * number decides how many callers are admitted per budget, not how long any
   * call is allowed to take — nothing here is a timeout. Raising it refuses
   * more callers earlier; lowering it admits callers that may then burn a full
   * deadline, which is the failure #1080 exists to remove.
   */
  expectedLlmCallMs?: number;
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
   * The environment `readProductionEnvironment` (production/environment.ts)
   * reads — every variable the composition root honours is listed there.
   * Defaults to `process.env`; a test or programmatic caller passes a record
   * instead of mutating the process environment (docs/coding-standards.md,
   * "an option with an env default, never a mid-wiring read").
   */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * The declared capital ceiling a live run is bounded by, in account currency
   * (#511, `SAMURAI_LIVE_MAX_CAPITAL_USD`).
   *
   * **Where it binds.** The Trader sizes as `equity * riskFraction /
   * stopDistance` (trader/decide.ts), and `equity` is the account's real
   * mark-to-market equity — so on a well-funded account every position scales
   * with the balance rather than with what the operator declared. Present, this
   * caps the equity the Trader sizes against at `min(ceiling, equity)`
   * (`buildTraderStep`, production/direct-bind.ts). It is a ceiling on the
   * DERIVATION, never a floor: an account below the ceiling sizes off its own
   * smaller equity.
   *
   * **Optional, and absent everywhere except a live boot.** Paper and backtest
   * runs and every test leave it undefined, which restores the pre-#511
   * behaviour exactly — `undefined` is "no ceiling declared", not "a ceiling of
   * zero". `liveStartingProfile` is the only in-repo caller that sets it, and
   * it refuses to be built without one, so a live run cannot reach here with
   * the field missing. Positive and finite is the TYPE's guarantee
   * (`toCapitalCeilingUsd`, capital-ceiling.ts), not a check repeated here.
   *
   * It does NOT re-anchor the six `riskConfig` notional caps at runtime: those
   * are derived from the same ceiling at profile-build time. See
   * live-profile.ts's header for what that costs when equity is below the
   * ceiling.
   */
  capitalCeilingUsd?: CapitalCeilingUsd;
  /**
   * The USD-per-GBP rate `capitalCeilingUsd` above was CONVERTED at, when it
   * was converted at all (#1180).
   *
   * Present means the ceiling is a derived figure: a GBP book
   * (`LIVE_BOOK_GBP`) multiplied by this rate, which is what
   * `paperStartingProfile('paper')` sets. Absent means the ceiling was
   * declared in the account's own currency and no rate was applied —
   * `liveStartingProfile`'s `SAMURAI_LIVE_MAX_CAPITAL_USD`, and every
   * backtest/test that declares a ceiling directly. The distinction is the
   * point: a boot log that stamped a rate onto a ceiling nobody converted
   * would misattribute the figure.
   *
   * Carried as config rather than read from the constant at each use site so
   * a composition root — a future live FX feed's, or a test's — can supply
   * the rate the ceiling it also supplies was actually built from.
   */
  capitalCeilingUsdPerGbp?: number;
  /**
   * Whether the market-intelligence sentiment agent runs (D2, review
   * 2026-08-06). Defaults from `SAMURAI_SENTIMENT` (`off` disables, anything
   * else runs it) — the same option-with-env-default idiom every other
   * env-derived value in this codebase uses; this field exists so tests and
   * programmatic callers can decide without touching the process environment.
   */
  sentimentEnabled?: boolean;
  /**
   * Whether the sentiment agent RETRIEVES live X posts rather than asking a
   * model what it remembers (#969). Defaults from
   * `SAMURAI_SENTIMENT_RETRIEVAL` (`on` enables; anything else, including
   * absent, does not) — note the polarity is the OPPOSITE of
   * `sentimentEnabled`'s `!== 'off'`, and deliberately so: this one changes
   * both what the soak costs and what experiment it is running, so it must be
   * switched on by an explicit act rather than left on by an operator who
   * never set the variable.
   *
   * Independent of `sentimentEnabled`: with sentiment off entirely there is no
   * agent for this to apply to, and the composition root warns rather than
   * silently doing nothing.
   */
  sentimentRetrieval?: boolean;
  /**
   * How many X posts each sentiment call retrieves (#969). Defaults from
   * `SAMURAI_X_MAX_RESULTS` via the shared `positiveIntegerFromEnv` — same
   * option-with-env-default idiom as `sentimentEnabled`/`sentimentRetrieval`
   * above; this field exists so tests and programmatic callers can set the
   * dial without touching the process environment (#1161).
   *
   * Held to the same integer `>= 1` bound the env path enforces
   * (`requireIntegerAtLeast`, `shared/env-integer.ts`): an injected value that
   * skipped that check would reach `XSearchClient`'s ceiling clamp instead, which
   * clamps excessive input rather than refusing it — the right call for an
   * operator's `SAMURAI_X_MAX_RESULTS=100`, the wrong one for a caller that
   * passed `0` or `-1` by mistake.
   */
  xMaxSearchResults?: number;
  /**
   * The Market Intelligence archive (#554, map #552) — its own database, NOT
   * `db`.
   *
   * Separate because SQLite has a single writer and a news pull must not hold
   * the lock while Execution journals a flatten; see the migration header for
   * the full argument. Supplied by the entrypoint rather than opened here so
   * one process holds one handle, and so a test can pass an in-memory archive.
   *
   * **Absent means the deterministic news path does not run**, and the run
   * falls back to the retrieval-era `GrokAgent` — which ingests `[]` by
   * construction, so `sentiment` and `fundamental` keep reporting NO DATA and
   * the #625 conviction ceiling stays in force. Set it for any run whose
   * results are meant to mean something.
   */
  miArchive?: MiArchiveStore;
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
   * (paper-profile.ts) — and `LoosenNotificationChannel` is resolved from
   * `SAMURAI_ALERTS` like every other outbound escalation, defaulting to
   * `loosenNotices` (`AlertChannelSlots`, above). A paper run started through the shipped
   * entrypoint therefore supplies this.
   */
  feedback?: FeedbackCycleConfig;
  logger?: Logger;
}

export interface FeedbackCycleConfig {
  config: FeedbackConfig;
  /**
   * Per-cycle override for `ProductionConfig.loosenNotices`. Optional since
   * #366: the channel is a transport, so it is resolved from `SAMURAI_ALERTS`
   * alongside the other outbound escalations and falls back to
   * `loggingAlertChannel('loosenNotices', …)` — the same shape `breachAlerts` has.
   * Supply it here only to override that for this cycle's config specifically.
   */
  loosenNotices?: LoosenNotificationChannel;
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
  db: StoreHandle;
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
   * record with a backtest Sharpe is persisted in-repo (the SQLite-backed
   * config-trial log was deleted as unwired dead code, #1156 — Stage 2's
   * runner uses `InMemoryConfigTrialLog`, which does not survive the process).
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
