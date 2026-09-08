/**
 * Log-only stand-ins for the human-facing transports.
 *
 * These are stand-ins, not implementations. What they give is an operator
 * watching the log stream instead of a phone, which is enough to observe a
 * BTC-USD paper tick end to end and nothing more.
 *
 * **They are no longer reachable by omission for the three outbound alerts
 * (#322).** The shipped entrypoint requires `SAMURAI_ALERTS`, and these three
 * are what `SAMURAI_ALERTS=log-only` explicitly selects — an ATTENDED-run
 * posture (local dev, a supervised smoke test), announced with a `warn` at
 * startup. `SAMURAI_ALERTS=telegram` passes `TradeChannelHeartbeat` /
 * `TradeChannelOrphanAlert` / `TradeChannelUnpricedFillAlert` over a real
 * `TelegramBotApiClient` (#275) instead. See alert-transport.ts.
 *
 * The three outbound ones are uncontroversial as stand-ins: a heartbeat, an
 * orphan alert and a stuck-lot alert are pure notifications, and writing them
 * to the log loses reachability (nobody is paged) but changes no decision. The
 * approval channel is different, and is treated differently below — it is also
 * the one still reached by omission, because wiring an inbound HITL round trip
 * through Telegram is #275's remaining half, not #322's.
 */

import type { AnalystTelemetry, IndicatorUnavailableEvent } from '../../pipeline/analysts/index.js';
import { INDICATOR_UNAVAILABLE_COUNTER } from '../../pipeline/analysts/index.js';
import type {
  PromptTierAlert,
  PromptTierAlertChannel,
} from '../../pipeline/debate-engine/index.js';
import type {
  FlattenOverfillAlertChannel,
  FlattenOverfillWarning,
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
  OcoDoubleFillAlert,
  OcoDoubleFillAlertChannel,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
  UnpricedFillAlert,
  UnpricedFillAlertChannel,
} from '../../pipeline/execution/index.js';
import type {
  ArmDivergenceAlert,
  ArmDivergenceAlertChannel,
  BreachAlert,
  BreachAlertChannel,
  LoosenAppliedNotice,
  LoosenNotificationChannel,
} from '../../pipeline/feedback-loop/index.js';
import type {
  ApprovalChannel,
  ApprovalOutcome,
  ApprovalRequest,
} from '../../pipeline/verdict/index.js';
import type { CiiScoreProvider } from '../../providers/market-intelligence/index.js';
import { currentTraceId } from '../../shared/index.js';
import { breachLogMessage, breachStage } from './breach-alert-channel.js';
import type { HeartbeatChannel } from './heartbeat.js';
import type { OrphanAlertChannel, OrphanGoVerdict } from './orphan-verdict-scan.js';
import type { AnalystSkipAlert, AnalystSkipAlertChannel } from './production/analysts-adapter.js';
import type {
  CalendarFallbackAlert,
  CalendarFallbackAlertChannel,
} from './production/calendar-fallback-alert.js';
import type { DataFailoverAlert, DataFailoverAlertChannel } from './production/data-failover.js';
import {
  MI_NO_DATA_BY_NAME_COUNTER,
  MI_NO_DATA_BY_SUBCLASS_COUNTER,
  type MiCoverageAlert,
  type MiCoverageAlertChannel,
  type MiCoverageEvent,
  type MiCoverageTelemetry,
} from './production/mi-coverage.js';
import type { TickSkipAlert, TickSkipAlertChannel } from './production/tick-skip-alert.js';
import type { Logger } from './types.js';

/**
 * The dead-man's-switch heartbeat, written to the log.
 *
 * Worth being explicit about what is lost: the heartbeat's whole purpose is
 * that its SILENCE is noticed by something outside this process. A log line
 * nobody tails is not a dead-man's switch — it is a diary. Fine for a
 * supervised smoke run, and never for an unattended soak (#238), which is why
 * selecting it now requires saying `SAMURAI_ALERTS=log-only` out loud (#322).
 */
export class LoggingHeartbeatChannel implements HeartbeatChannel {
  constructor(private readonly logger: Logger) {}

  async postHeartbeat(timestamp: Date): Promise<void> {
    this.logger.log({
      trace_id: 'heartbeat',
      stage: 'orchestrator',
      level: 'info',
      message: 'heartbeat',
      payload: { timestamp: timestamp.toISOString() },
    });
  }
}

/** A restart-time orphaned `go` verdict, written to the log at `error`. */
export class LoggingOrphanAlertChannel implements OrphanAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postOrphanAlert(orphan: OrphanGoVerdict): Promise<void> {
    // `error`, not `warn`: an orphaned `go` means a verdict approved a trade
    // and the process died before Execution recorded what happened to it —
    // the one state that can hide a real position from the system.
    this.logger.log({
      trace_id: orphan.trace_id,
      stage: 'orchestrator',
      event: 'orphan_verdict_found',
      level: 'error',
      message: 'orphaned go verdict found at startup — verify against the venue',
      payload: { ...orphan },
    });
  }
}

/**
 * A fill the venue reports filled and will not price, aged past its threshold
 * (#298), written to the log at `error`.
 *
 * `error`, for `LoggingOrphanAlertChannel`'s reason: the lot behind it is stuck
 * — under-filled in the store, its stop sized to the wrong quantity, and unable
 * to emit a `ClosedTrade` — while the venue believes it filled. That is a
 * position the system cannot account for, and it will not resolve itself.
 *
 * Same caveat as the heartbeat's log-only stand-in: a log line nobody tails is
 * not an alert. `TradeChannelUnpricedFillAlert` (unpriced-fill-channel.ts) is
 * the reachable-from-a-phone implementation, and `SAMURAI_ALERTS=telegram`
 * (#322) is what an unattended soak (#238) sets to get it.
 */
export class LoggingUnpricedFillAlertChannel implements UnpricedFillAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postUnpricedFillAlert(alert: UnpricedFillAlert): Promise<void> {
    this.logger.log({
      // Not a tick trace: this is a broker anomaly observed by the fill poll,
      // the same synthetic-trace convention `Heartbeat`/`OrphanVerdictScanner`
      // use for work that belongs to no pipeline pass.
      trace_id: 'unpriced-fill',
      stage: 'execution',
      event: 'unpriced_fill_stuck',
      level: 'error',
      message:
        'broker reports a filled quantity it will not price — the lot is stuck; ' +
        'check the order on the venue and reconcile it by hand',
      payload: {
        ...alert,
        first_seen_at: alert.first_seen_at.toISOString(),
      },
    });
  }
}

/**
 * A residual position `ingestFills()` could not re-arm after a partial
 * flatten (#525), written to the log at `error`. Posted only on a FAILED
 * re-arm — a successful one is silent by design (see
 * `ResidualExposureAlert`'s doc), so every line this channel writes is one
 * an operator needs to act on: an unprotected position sitting at the venue
 * with no stop and no target.
 *
 * Same caveat as `LoggingUnpricedFillAlertChannel`'s: a log line nobody
 * tails during an unattended soak (#238) is not an alert.
 * `TradeChannelResidualExposureAlert` (residual-exposure-alert-channel.ts)
 * is the reachable-from-a-phone implementation, wired through
 * `SAMURAI_ALERTS=telegram` (#322, #551).
 */
export class LoggingResidualExposureAlertChannel implements ResidualExposureAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
    this.logger.log({
      // Not a tick trace, for the same reason `LoggingUnpricedFillAlertChannel`
      // isn't: this is observed by the fill poll, which spans every open lot
      // at once rather than belonging to one pipeline pass.
      trace_id: 'residual-exposure',
      stage: 'execution',
      event: 'residual_exposure_unprotected',
      level: 'error',
      message:
        'a partially-filled flatten left a residual position and re-arming its protective ' +
        'legs failed — the position is unprotected; check the order on the venue by hand',
      payload: {
        ...alert,
        observed_at: alert.observed_at.toISOString(),
      },
    });
  }
}

/**
 * A `flatten_submissions` row `reconcile()`'s sweep could not settle (#519),
 * written to the log at `error`. See `FlattenReconcileAlertChannel`'s doc
 * (execution/flatten-reconcile-alert.ts) for why this is treated as an
 * operator escalation rather than a background diagnostic like
 * `LoggingFlattenOverfillAlertChannel` below: an unresolved flatten is a lot
 * stuck in genuine ambiguity about whether it is still held.
 *
 * Same caveat as `LoggingResidualExposureAlertChannel`'s: a log line nobody
 * tails during an unattended soak (#238) is not an alert.
 * `TradeChannelFlattenReconcileAlert` (flatten-reconcile-alert-channel.ts) is
 * the reachable-from-a-phone implementation, wired through
 * `SAMURAI_ALERTS=telegram` (#322, #519) — the same move #551 made for
 * `residualExposureAlerts`.
 */
export class LoggingFlattenReconcileAlertChannel implements FlattenReconcileAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void> {
    this.logger.log({
      // Not a tick trace, for `LoggingResidualExposureAlertChannel`'s reason:
      // this is observed by reconcile(), which spans every unresolved flatten
      // at once rather than belonging to one pipeline pass. Threaded from the
      // alert rather than fixed here (#1331) — the explicit form
      // `LoggingMiCoverageAlertChannel` above takes: the live and control arms
      // post through this SAME instance, so the id of the surface the pass ran
      // on is the only thing in the line that tells a real venue's ambiguity
      // from a simulated broker's. It is the `control-arm-` prefix that names
      // the arm, not one id per arm: the startup pass logs
      // `reconcile`/`control-arm-reconcile` and the poll logs
      // `fill-sync`/`control-arm-fill-sync` (it calls `reconcile()` on the
      // fill-sync surface), so on the poll this error line and the loop's own
      // `warn` divergence line for the same flatten carry different ids. See
      // `FlattenReconcileAlert.trace_id`.
      trace_id: alert.trace_id,
      stage: 'execution',
      event: 'flatten_reconcile_unresolved',
      level: 'error',
      message:
        "reconcile() could not settle a flatten_submissions row — the flatten's outcome is " +
        'genuinely unknown; check the order on the venue by hand',
      // Field by field, so `trace_id` is not repeated inside the payload it
      // already labels the entry with — `LoggingMiCoverageAlertChannel`'s own
      // handling of the same threaded field.
      payload: {
        idempotency_key: alert.idempotency_key,
        instrument: alert.instrument,
        reason: alert.reason,
        observed_at: alert.observed_at.toISOString(),
      },
    });
  }
}

/**
 * A flatten fill that filled more than its named lots' journalled share
 * (#527), written to the log at `warn`. See `FlattenOverfillAlertChannel`'s
 * doc (execution/flatten-overfill-alert.ts) for why this is a diagnostic
 * trail rather than an operator escalation: the redistribution that reports
 * it still completes, and the excess is dropped either way — this only makes
 * the drop visible instead of silent.
 *
 * Unlike the other channels in this file, there is no `TradeChannel...`
 * phone-reaching counterpart (yet) — the same posture
 * `ResidualExposureAlertChannel` had before #551 wired it through
 * `SAMURAI_ALERTS`. This condition is "should never happen" rather than an
 * unattended-soak emergency, so a log line an operator can grep after the
 * fact is the right first step; paging on it is a later ticket if it ever
 * actually fires.
 */
export class LoggingFlattenOverfillAlertChannel implements FlattenOverfillAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postFlattenOverfillWarning(warning: FlattenOverfillWarning): Promise<void> {
    this.logger.log({
      // Same synthetic-trace convention as `residual-exposure`/`unpriced-fill`
      // above: this is observed by the fill poll, not any one tick.
      trace_id: 'flatten-overfill',
      stage: 'execution',
      event: 'flatten_overfill_dropped',
      level: 'warn',
      message:
        "a flatten filled more than its named lots' journalled share — the excess was " +
        'dropped rather than guessed onto a lot; this should not happen under normal operation, ' +
        "so check the venue and the flatten's journal row by hand",
      payload: {
        idempotency_key: warning.idempotency_key,
        unattributed_qty: warning.unattributed_qty,
        observed_at: warning.observed_at.toISOString(),
      },
    });
  }
}

/**
 * An emulated crypto OCO's DOUBLE FILL (#586), written to the log at `error`:
 * both protective legs filled inside one poll window, so the second leg
 * over-closed the lot and opened a reverse position the system never decided
 * to hold. Both fills are booked truthfully; nothing is unwound
 * automatically — this is the accepted-risk escalation, and it needs a human
 * (see oco-double-fill-alert.ts).
 *
 * Same caveat as every stand-in here: a log line nobody tails during an
 * unattended soak (#238) is not an alert. `TradeChannelOcoDoubleFillAlert`
 * (oco-double-fill-channel.ts) is the reachable-from-a-phone implementation,
 * wired through `SAMURAI_ALERTS=telegram`.
 */
export class LoggingOcoDoubleFillAlertChannel implements OcoDoubleFillAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postOcoDoubleFillAlert(alert: OcoDoubleFillAlert): Promise<void> {
    this.logger.log({
      // Same synthetic-trace convention as `residual-exposure` above: this is
      // observed by the fill poll, not any one tick.
      trace_id: 'oco-double-fill',
      stage: 'execution',
      event: 'oco_double_fill',
      level: 'error',
      message:
        'both protective legs of an emulated crypto OCO filled — the lot is over-closed and a ' +
        'reverse position may be open at the venue; check and unwind it by hand',
      payload: {
        client_order_id: alert.client_order_id,
        instrument: alert.instrument,
        stop_order_id: alert.stop_order_id,
        target_order_id: alert.target_order_id,
        observed_at: alert.observed_at.toISOString(),
      },
    });
  }
}

/**
 * A run of consecutive analyst quorum skips (#431), written to the log at
 * `error`.
 *
 * `error` for `LoggingOrphanAlertChannel`'s reason: two skipped ticks in a row
 * means the pipeline has produced no decision at all for this instrument, and
 * after ADR-0007 removed the human approval gate there is nobody receiving a
 * per-trade message who would notice the trades stopping. At ADR-0008's
 * 15-minute cadence a silently-skipping analyst stage is nearly
 * indistinguishable from a quiet market: the heartbeat keeps beating either way.
 *
 * Same caveat as the other log-only stand-ins: a log line nobody tails is not
 * an alert. `TradeChannelAnalystSkipAlert` (analyst-skip-alert-channel.ts) is
 * the reachable-from-a-phone implementation, selected by
 * `SAMURAI_ALERTS=telegram`.
 */
export class LoggingAnalystSkipAlertChannel implements AnalystSkipAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postAnalystSkipAlert(alert: AnalystSkipAlert): Promise<void> {
    this.logger.log({
      // Not a tick trace: the alert is about a RUN of ticks, so it belongs to
      // none of them individually — the same synthetic-trace convention the
      // heartbeat and orphan scan use.
      trace_id: 'analyst-skip',
      stage: 'analysts',
      event: 'analyst_consecutive_skips',
      level: 'error',
      message:
        `analysts have skipped ${alert.consecutive_skips} consecutive ticks for ` +
        `${alert.instrument} — no decision is being produced for it at all`,
      payload: {
        instrument: alert.instrument,
        consecutive_skips: alert.consecutive_skips,
        failures: alert.failures,
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}

/**
 * `technical_indicator_unavailable{kind}` (#745), written to the log stream.
 *
 * This is a COUNTER, not an alert, and the level says so: an enrichment axis
 * short of bars is the designed degradation — the technical analyst is
 * `mandatory`, and the whole point of the core/enrichment split is that a cold
 * or thin instrument still produces a usable view instead of forfeiting the
 * tick as a `quorum_skip`. So `warn`, not `error`: worth counting, never worth
 * paging. A `debug` would be worse — the operational question this exists to
 * answer is "how much of the axis panel has this instrument actually been
 * voting on", and a level nobody ships cannot answer it.
 *
 * There is no metrics registry in this system; the log stream IS the metric
 * store (`rotating-file-sink.ts`), so the counter name is emitted as a field
 * rather than incremented in a gauge, and a scrape aggregates by
 * `payload.counter` + `payload.kind`. Named from
 * `INDICATOR_UNAVAILABLE_COUNTER` so the sink and any future scrape cannot
 * drift apart on spelling.
 */
export class LoggingAnalystTelemetry implements AnalystTelemetry {
  constructor(private readonly logger: Logger) {}

  indicatorUnavailable(event: IndicatorUnavailableEvent): void {
    this.logger.log({
      trace_id: event.trace_id,
      stage: 'analysts',
      event: 'indicator_unavailable',
      level: 'warn',
      message:
        `${INDICATOR_UNAVAILABLE_COUNTER}{kind="${event.kind}"}: ${event.instrument} ` +
        `${event.axis} axis left the vote denominator — ${event.kind} needed ${event.required} ` +
        `bars, had ${event.received}`,
      payload: {
        counter: INDICATOR_UNAVAILABLE_COUNTER,
        analyst_type: event.analyst_type,
        instrument: event.instrument,
        axis: event.axis,
        kind: event.kind,
        required: event.required,
        received: event.received,
      },
    });
  }
}

/**
 * `mi_no_data_by_name{instrument}` / `mi_no_data_by_subclass{subclass}` (#752),
 * written to the log stream — same convention as `LoggingAnalystTelemetry`:
 * the log IS the metric store, and a scrape aggregates by `payload.counter`.
 * Fires only on a miss; a rate is the scrape's job, dividing by the tick
 * count recorded elsewhere.
 */
export class LoggingMiCoverageTelemetry implements MiCoverageTelemetry {
  constructor(private readonly logger: Logger) {}

  noDataObserved(event: MiCoverageEvent): void {
    this.logger.log({
      trace_id: event.trace_id,
      stage: 'analysts',
      event: 'mi_no_data_observed',
      level: 'warn',
      message:
        `${MI_NO_DATA_BY_NAME_COUNTER}{instrument="${event.instrument}"} ` +
        `${MI_NO_DATA_BY_SUBCLASS_COUNTER}{subclass="${event.subclass}"}: ${event.instrument} ` +
        `has no scored market-intelligence item inside the staleness window`,
      payload: {
        counter_by_name: MI_NO_DATA_BY_NAME_COUNTER,
        counter_by_subclass: MI_NO_DATA_BY_SUBCLASS_COUNTER,
        instrument: event.instrument,
        asset_class: event.asset_class,
        subclass: event.subclass,
      },
    });
  }
}

/**
 * The degraded-coverage alert (#752), written to the log at `warn` — a
 * counter's severity, not an escalation's: this is the log-only stand-in
 * `SAMURAI_ALERTS=log-only` selects, and it CANNOT wake anyone (criterion 6).
 * `TradeChannelMiCoverageAlert` (mi-coverage-alert-channel.ts) is the
 * reachable-from-a-phone implementation `SAMURAI_ALERTS=telegram` selects
 * (alert-transport.ts) — the twelfth `ALERT_CHANNEL_FIELDS` member.
 */
export class LoggingMiCoverageAlertChannel implements MiCoverageAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postCoverageAlert(alert: MiCoverageAlert): Promise<void> {
    this.logger.log({
      trace_id: alert.trace_id,
      stage: 'analysts',
      event: 'mi_coverage_degraded',
      level: 'warn',
      message:
        `market-intelligence coverage degraded for ${alert.instrument} (subclass=` +
        `${alert.subclass}) — no scored item inside the staleness window. ` +
        'SAMURAI_ALERTS=log-only cannot page anyone about this; use SAMURAI_ALERTS=telegram ' +
        'for an unattended run.',
      payload: {
        instrument: alert.instrument,
        asset_class: alert.asset_class,
        subclass: alert.subclass,
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}

/**
 * A materially degraded tick pass (#1084), written to the log at `warn`.
 *
 * Named instruments, not just a count — the same reasoning `runOnce`'s own
 * "still running from a previous pass" line gives (production.ts): WHICH
 * instruments are stuck decides whether this is one venue lagging or the
 * whole universe.
 */
export class LoggingTickSkipAlertChannel implements TickSkipAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postTickSkipAlert(alert: TickSkipAlert): Promise<void> {
    this.logger.log({
      trace_id: 'tick-skip',
      stage: 'tick-loop',
      event: 'tick_pass_degraded',
      level: 'warn',
      message:
        `tick pass materially degraded: ${alert.skipped} of ${alert.planned} planned ` +
        `instrument(s) skipped (still running from a previous pass), ` +
        `${alert.consecutive_ticks} consecutive tick(s). ` +
        'SAMURAI_ALERTS=log-only cannot page anyone about this; use SAMURAI_ALERTS=telegram ' +
        'for an unattended run.',
      payload: {
        skipped: alert.skipped,
        planned: alert.planned,
        skipped_instruments: alert.skipped_instruments,
        consecutive_ticks: alert.consecutive_ticks,
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}

/**
 * A live OHLCV failover (#562), written to the log at `warn`.
 *
 * `warn`, not `error`: by the time this is called the fallback vendor has
 * already been asked, and the bars either arrived (degraded, and stamped with
 * the serving vendor in `bars.source`) or the combined
 * primary-and-fallback-both-failed error is on its way up the stack to be
 * logged there. What this line records is that the run has left its primary
 * data vendor — a fact an operator needs, not a stage failure.
 *
 * Same caveat as every other log-only stand-in, and #562's third criterion is
 * explicit about it: this cannot page anyone.
 * `TradeChannelDataFailoverAlert` (data-failover-alert-channel.ts) is the
 * reachable-from-a-phone implementation `SAMURAI_ALERTS=telegram` (#322)
 * selects.
 */
export class LoggingDataFailoverAlertChannel implements DataFailoverAlertChannel {
  constructor(private readonly logger: Logger) {}

  async postDataFailoverAlert(alert: DataFailoverAlert): Promise<void> {
    this.logger.log({
      // Unlike `unpriced-fill`/`residual-exposure` above (fill-poll events)
      // or `feedback-cycle` below (a daily batch), a single failover on a
      // single fetch belongs to the tick that caused it — so this joins the
      // enclosing tick when there is one, matching
      // `production/data-failover.ts`'s catch-line (#1118/#1181), and keeps
      // the constant only outside a tick (#1183).
      trace_id: currentTraceId() ?? 'data-failover',
      stage: 'orchestrator',
      event: 'ohlcv_failover_engaged',
      level: 'warn',
      message:
        `OHLCV failover on the ${alert.leg} leg: ${alert.primaryName} failed for ` +
        `${alert.symbol} ${alert.timeframe} (${alert.primaryError}), so ${alert.fallbackName} ` +
        'is serving those bars. SAMURAI_ALERTS=log-only cannot page anyone about this; use ' +
        'SAMURAI_ALERTS=telegram for an unattended run.',
      payload: {
        leg: alert.leg,
        instrument: alert.symbol,
        timeframe: alert.timeframe,
        primary: alert.primaryName,
        fallback: alert.fallbackName,
        reported_at: alert.reported_at.toISOString(),
        suppressed_since_last: alert.suppressed_since_last,
      },
    });
  }
}

/**
 * Arm divergence, written to the log (#971).
 *
 * `warn`, not `error`: the matched control out-performing the debate arm is a
 * MEASUREMENT the operator has to act on with judgement — nothing has failed,
 * nothing was auto-tightened, and no position is unprotected. It is also not
 * routine, which is why it is not `info`.
 *
 * Same caveat as every other log-only stand-in: `SAMURAI_ALERTS=log-only`
 * cannot page anyone. `TradeChannelArmDivergenceAlert`
 * (arm-divergence-alert-channel.ts) is the reachable-from-a-phone
 * implementation `SAMURAI_ALERTS=telegram` (#322) selects, and #913 is explicit
 * that the divergence must reach the trade channel.
 */
export class LoggingArmDivergenceAlertChannel implements ArmDivergenceAlertChannel {
  constructor(private readonly logger: Logger) {}

  postArmDivergenceAlert(alert: ArmDivergenceAlert): void {
    const { live, control } = alert.comparison;
    this.logger.log({
      trace_id: 'arm-divergence',
      stage: 'feedback-loop',
      event: 'arm_divergence_detected',
      level: 'warn',
      message:
        'ARM DIVERGENCE — the matched control (falsifier arm 2) is out-performing the live ' +
        'arm. SAMURAI_ALERTS=log-only cannot page anyone about this; use ' +
        'SAMURAI_ALERTS=telegram for an unattended run.',
      payload: {
        reason: alert.reason,
        // Both columns for both arms, never a return on its own (doc 12 D4).
        live_return_pct: live.return_pct,
        live_max_drawdown_pct: live.max_drawdown_pct,
        live_trade_count: live.trade_count,
        control_return_pct: control.return_pct,
        control_max_drawdown_pct: control.max_drawdown_pct,
        control_trade_count: control.trade_count,
        window_from: alert.comparison.from.toISOString(),
        window_to: alert.comparison.to.toISOString(),
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}

/**
 * The paper equity leg's Alpaca `GET /v2/calendar` fetch failed at boot, and
 * `us-equity-session-source.ts` fell back to the hand-entered session table
 * (#684). Written to the log at `error`, not `warn`: unlike an OHLCV
 * failover — where a second vendor is already serving the exact same
 * data — the fallback here is a DIFFERENT calendar, hand-entered, checked
 * only through `alert.fallback_coverage_end`, and the whole reason #684
 * exists is that table's coverage gaps are the dangerous direction for a
 * flatten boundary. `error` is what an unattended soak's operator needs to
 * notice this before the fallback's own cliff starts throwing.
 *
 * Same caveat as every other log-only stand-in: `SAMURAI_ALERTS=log-only`
 * cannot page anyone. `TradeChannelCalendarFallbackAlert`
 * (calendar-fallback-alert-channel.ts) is the reachable-from-a-phone
 * implementation `SAMURAI_ALERTS=telegram` (#322) selects.
 */
export class LoggingCalendarFallbackAlertChannel implements CalendarFallbackAlertChannel {
  constructor(private readonly logger: Logger) {}

  postCalendarFallbackAlert(alert: CalendarFallbackAlert): void {
    this.logger.log({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'calendar_fallback_engaged',
      level: 'error',
      message:
        "paper equity leg's Alpaca calendar fetch failed at boot — fell back to the " +
        'hand-entered US equity session table. SAMURAI_ALERTS=log-only cannot page anyone ' +
        'about this; use SAMURAI_ALERTS=telegram for an unattended run.',
      payload: {
        reason: alert.reason,
        fallback_coverage_end: alert.fallback_coverage_end,
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}

/**
 * The kill-line batch's breach (#93) AND the LLM spend cap's refusal both
 * post through this port, written to the log at `error`.
 *
 * `error` for both, for `LoggingOrphanAlertChannel`'s reason and more so: a
 * kill-line breach means the strategy's own validation says its edge may be
 * gone — PBO over its line, out-of-sample Sharpe under it, a statistically
 * insignificant Deflated Sharpe, or live performance diverging from the
 * backtest that justified the config — and the kill/rework call is the
 * human's. A spend-cap breach means the run has stopped admitting new LLM
 * calls until whatever triggered the refusal is resolved. Neither should
 * wait for someone to notice a quiet heartbeat.
 *
 * `message` discriminates on which happened (`breachLogMessage`,
 * breach-alert-channel.ts — see its doc for what each case actually claims).
 * `event` stays `kill_threshold_breach` for both callers: no production code
 * reads it (only a test filters on it), so renaming it is a separate,
 * out-of-scope change.
 *
 * Same caveat as the other log-only stand-ins: a log line nobody tails is not
 * an alert. `TradeChannelBreachAlert` (breach-alert-channel.ts) is the
 * reachable-from-a-phone implementation, selected by `SAMURAI_ALERTS=telegram`
 * (#322) — which an unattended soak (#238) sets.
 */
export class LoggingBreachAlertChannel implements BreachAlertChannel {
  constructor(private readonly logger: Logger) {}

  postBreachAlert(alert: BreachAlert): void {
    this.logger.log({
      // Mixed, so it is answered at runtime (#1280): the daily kill-line
      // batch keeps the synthetic `feedback-cycle` trace it already logs
      // under; an `llm_spend_cap` breach is raised inside a tick by
      // `SqliteSpendCap#refuse` (spend-cap.ts) and joins that trace via
      // `breachStage`. A third provenance — boot's `startingTotal()`, which
      // has no ambient trace id — lands on the `feedback-cycle` fallback
      // below and is indistinguishable from the daily batch at this site;
      // `BreachAlert` carries no field to resolve it, and adding one is out
      // of this ticket's scope (see `classifyBreach`'s doc,
      // breach-alert-channel.ts, for what #1343 fixes instead: the wording).
      trace_id: currentTraceId() ?? 'feedback-cycle',
      // Derived for the same reason the trace is (#1280) — see `breachStage`.
      stage: breachStage(alert),
      event: 'kill_threshold_breach',
      level: 'error',
      message: breachLogMessage(alert.breaches),
      payload: {
        breaches: alert.breaches,
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}

/**
 * An APPLIED risk-threshold loosening, written to the log at `warn` (#366,
 * retargeted by #736).
 *
 * ## Why this one is a stand-in and not a fabricated consent
 *
 * Read `ConsoleApprovalChannel` below before assuming this is the same shape.
 * It is not, and the difference is the whole safety argument:
 *
 * - `ApprovalChannel.requestApproval` returns `Promise<ApprovalOutcome>`. A
 *   log-only implementation has to *answer*, and the only answers available to
 *   a machine with no human on the line are a fabricated `'approved'` or a
 *   `'rejected'` that impersonates a working gate.
 * - `LoosenNotificationChannel.notifyLoosenApplied` returns `void` and is not
 *   asked anything. Under ADR-0013 Decision 2 the Feedback Loop applies its
 *   own bounded dial moves; this channel reports one that already happened.
 *   There is no consent to fabricate because none is sought.
 *
 * **What bounds the move is not this channel.** Until #736 a loosening was
 * queued for an approval no transport could deliver, so it was never applied
 * at all — fail-closed, and also a dial permanently stuck one way. Now the
 * bounds do the work: one `max_step`, the dial's `[floor, ceiling]`, and the
 * in-code clamp on the guarded thresholds (`server/shared/threshold-bounds.ts`,
 * #638), which throws at the tuning store's write door and so runs BEFORE any
 * notice is emitted. A move this channel reports is a move already written and
 * already in `dial_adjustments`.
 *
 * Same caveat as the other log-only stand-ins: a log line nobody tails is not
 * a notification. `TradeChannelLoosenNotice` (loosen-notification-channel.ts)
 * is the reachable-from-a-phone implementation, selected by
 * `SAMURAI_ALERTS=telegram` (#322/#366) — which an unattended soak (#238) sets.
 *
 * `warn`, not `error`: nothing is broken and no position is at risk — a dial
 * moved inside limits a human set. Not `info` either: a safety limit widening
 * with nobody asked is the thing an operator scanning a soak log must not
 * scroll past.
 */
export class LoggingLoosenNotificationChannel implements LoosenNotificationChannel {
  constructor(private readonly logger: Logger) {}

  notifyLoosenApplied(notice: LoosenAppliedNotice): void {
    this.logger.log({
      // The daily batch belongs to no single tick, so it shares the synthetic
      // trace the feedback cycle already logs under.
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'risk_threshold_loosened',
      level: 'warn',
      message:
        'risk-threshold LOOSENING applied — the Feedback Loop widened its own limit, capped at ' +
        'one step and clamped to the hard bounds (ADR-0013, #736). Nobody was asked and no ' +
        'reply is read; reverse it from the dial_adjustments row if it is wrong.',
      payload: {
        name: notice.name,
        from: notice.from,
        to: notice.to,
        applied_at: notice.applied_at.toISOString(),
        applied: true,
      },
    });
  }
}

/**
 * A console approval channel — and the one place a stand-in is a real
 * decision rather than a convenience.
 *
 * There is no human on this channel, so it cannot obtain consent; it can only
 * fabricate it. Auto-approving is therefore a deliberate bypass of Verdict's
 * HITL gate (6), acceptable exactly where the gate is protecting nothing
 * real: `paper` and `backtest` spend no money. In `live` it is never acceptable, so
 * the constructor refuses to build one at all rather than resolving
 * `'rejected'` — a channel that rejects everything looks like a working
 * safety gate while actually being a broken transport, and the difference
 * matters when someone is debugging why no live trade ever fires.
 *
 * Every granted approval is logged at `warn` with its trace, so the audit
 * trail records that a machine consented, not a person.
 */
export class ConsoleApprovalChannel implements ApprovalChannel {
  constructor(
    private readonly logger: Logger,
    private readonly mode: 'live' | 'paper' | 'backtest',
  ) {
    if (mode === 'live') {
      throw new Error(
        'ConsoleApprovalChannel refuses to run in live mode: it auto-approves, and there is no ' +
          'human on it. Wire a real ApprovalChannel (#275) before trading real money.',
      );
    }
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.logger.log({
      trace_id: request.trace_id,
      stage: 'verdict',
      event: 'hitl_gate_auto_approved',
      level: 'warn',
      message: 'HITL gate auto-approved by ConsoleApprovalChannel — no human reviewed this trade',
      payload: {
        mode: this.mode,
        instrument: request.order_intent.instrument,
        side: request.order_intent.side,
        size: request.order_intent.size,
        intent_type: request.order_intent.intent_type,
      },
    });

    return 'approved';
  }
}

/**
 * The composition root's default `ApprovalChannel` since ADR-0007 made
 * `automation_level` fully `auto` — and it exists to be **unreachable**.
 *
 * Under `auto`, `shouldEngageHitl` short-circuits to `false` before the
 * HITL gate (6), so `requestApproval` is never called and no approval
 * transport is needed in any mode. That is why this class, unlike
 * `ConsoleApprovalChannel`, does not refuse to be constructed in `live`:
 * refusing there would block a live start over a gate that never fires.
 *
 * What it will not do is silently stand in for a human if the dial is ever
 * turned back. `ConsoleApprovalChannel` auto-approves, which is safe only
 * while nothing real depends on the answer; the moment `manual` or
 * `semi_auto` is set with no transport wired, an auto-approving default means
 * the gate reads as enforced and enforces nothing — this repo's dominant
 * defect class. So this one throws instead, naming both causes and both fixes.
 * The throw propagates out of `VerdictImpl.decide` and fails that instrument's
 * pass loudly rather than fabricating consent.
 */
export class UnwiredApprovalChannel implements ApprovalChannel {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    throw new Error(
      "Verdict's HITL gate (6) was reached, but no ApprovalChannel is wired. Since ADR-0007 the " +
        'automation dial is `auto` for both asset classes, under which this gate is ' +
        'unreachable — so reaching it means `verdictConfig.automation_level` was set to ' +
        '`manual` or `semi_auto` without also supplying `ProductionConfig.approvals`. Either ' +
        'set the dial back to `auto`, or wire a real channel (TelegramApprovalGateway, which ' +
        'is built and tested but has no production caller). Refusing rather than ' +
        `auto-approving: trace ${request.trace_id}, ` +
        `${request.order_intent.side} ${request.order_intent.size} ` +
        `${request.order_intent.instrument}.`,
    );
  }
}

/**
 * The parked WorldMonitor CII feed (ADR-0002): always "no score".
 *
 * Not a stub standing in for something that should be here — the live
 * WorldMonitor wiring is deliberately parked for the duration of paper
 * trading, because it costs money per call and the geopolitical tier is not
 * what the first paper run is testing. `CiiScoreProvider.getCii` already has
 * `null` in its contract for "WorldMonitor has no score for this country", and
 * `CiiConsumer` already handles that path, so this provider exercises a route
 * the system supports rather than one it has to be taught.
 *
 * Silent by design: unlike the approval channel, returning `null` here is a
 * documented, expected answer rather than a fabricated consent, so logging it
 * once per country per poll would be noise on a path that is behaving
 * correctly.
 */
export class ParkedCiiScoreProvider implements CiiScoreProvider {
  async getCii(): Promise<number | null> {
    return null;
  }
}

/**
 * A prompt-tier crossing (#1155), written to the log at `warn`.
 *
 * Same caveat as the other log-only stand-ins: a line nobody tails cannot
 * page anyone about a 2.5x unit-cost step against ADR-0008's $50/14d cap.
 * `TradeChannelPromptTierAlert` (prompt-tier-alert-channel.ts) is the
 * reachable-from-a-phone implementation, selected by `SAMURAI_ALERTS=telegram`
 * (#322).
 */
export class LoggingPromptTierAlertChannel implements PromptTierAlertChannel {
  constructor(private readonly logger: Logger) {}

  postPromptTierAlert(alert: PromptTierAlert): void {
    this.logger.log({
      trace_id: alert.trace_id,
      stage: alert.stage,
      event: 'prompt_tier_crossed',
      level: 'warn',
      message:
        `prompt-tier crossing: ${alert.model} priced ${alert.prompt_tokens} prompt tokens, ` +
        `above its ${alert.above_prompt_tokens}-token large-prompt tier (#${alert.consecutive_crossings} ` +
        'consecutive call). This call priced at the tier rate, a 2.5x unit-cost step against the ' +
        'base rate — see pricing.ts.',
      payload: {
        model: alert.model,
        debate_id: alert.debate_id,
        prompt_tokens: alert.prompt_tokens,
        above_prompt_tokens: alert.above_prompt_tokens,
        consecutive_crossings: alert.consecutive_crossings,
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}
