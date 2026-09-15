/**
 * Every outbound operator alert, one record each: the port method it answers,
 * how the send is delivered, the log line `SAMURAI_ALERTS=log-only` writes for
 * it, and the text `SAMURAI_ALERTS=telegram` pushes for it. `loggingAlertChannel`
 * and `tradeChannelAlert` below are the two adapters that read this table;
 * `alert-transport.ts` wires one per entry and `production.ts` defaults every
 * un-injected slot to the logging form.
 *
 * `delivery` follows the port's own return type, and that is a contract with
 * the caller, not a style: an `'awaited'` port (`Promise<void>`) rejects on a
 * failed send because its caller already catches and logs (the orphan scan,
 * the fill poll, `checkMiCoverage`, ...); a `'detached'` port (`void`) is
 * called from a synchronous path that must not be able to block or fail on a
 * page (`computeMetrics`' auto-tighten, `LlmSpendSink.record`, a boot guard),
 * so the send is started and its rejection lands in `sendFailed`'s log line
 * instead of surfacing as an unhandled rejection mid-soak.
 *
 * Every text is composed only from the alert's own curated fields — never a
 * venue error or response body; see each alert type's CREDENTIALS note.
 * Every entry posts to the ESCALATION chat except the heartbeat, which
 * `alert-transport.ts` gives its own chat (#342).
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import { currentTraceId, describeThrownSafely } from '../../shared/index.js';
import { breachLabel, breachLogMessage, breachStage, formatBreachAlert } from './breach-text.js';
import type { AlertChannelSlots } from './production/config.js';
import type { ExitValuationDegradedAlert } from './production/exit-valuation-alert.js';
import type { ThresholdClampAlert } from './production/threshold-clamp-alert.js';
import type { TraderDiagnosticAlert } from './production/trader-diagnostic-alert.js';
import type { LogEntry, Logger } from './types.js';

/**
 * The `AlertChannelSlots` fields this catalogue answers for — every outbound
 * escalation except `verdictAlerts`, whose port (`TradeChannelNotifier`) is
 * shaped for a `VerdictDecision` and implemented by Verdict's own
 * `TelegramChannel`. `satisfies` catches an id that is not a slot; the other
 * direction — a slot with no entry here — is `ALL_ALERT_CHANNEL_FIELDS_COVERED`
 * (alert-transport.ts).
 */
export const ALERT_IDS = [
  'heartbeatChannel',
  'orphanAlerts',
  'unpricedFillAlerts',
  'residualExposureAlerts',
  'ocoDoubleFillAlerts',
  'legResizeAlerts',
  'dormantLegsAlerts',
  'priceUnitAlerts',
  'flattenReconcileAlerts',
  'analystSkipAlerts',
  'breachAlerts',
  'loosenNotices',
  'traderDiagnosticAlerts',
  'miCoverageAlerts',
  'thresholdClampAlerts',
  'dataFailoverAlerts',
  'exitValuationAlerts',
  'calendarFallbackAlerts',
  'armDivergenceAlerts',
  'tickSkipAlerts',
  'promptTierAlerts',
  'lseCalendarCoverageAlerts',
  'llmFailureRateAlerts',
  'gateRefusalRateAlerts',
  'nonSterlingFeeAlerts',
  'unattributedFlattenFillAlerts',
  'saxoSessionLostAlerts',
  'saxoWeeklyReminderAlerts',
] as const satisfies readonly (keyof AlertChannelSlots)[];

export type AlertId = (typeof ALERT_IDS)[number];

/**
 * Alerts with NO log-only form, and which must not grow one: their callers
 * already write the condition to the log at `error` before consulting the
 * port (`postTraderDiagnosticAlert` and `reportExitValuationDegraded` in
 * direct-bind.ts, the #638 clamp's own refusal line, `warnOnNonSterlingFee`
 * in ingest-fills.ts), so a log-only adapter would emit each condition twice.
 * `production.ts` leaves these slots `undefined` under `log-only`.
 */
export const UNLOGGED_ALERT_IDS = [
  'traderDiagnosticAlerts',
  'thresholdClampAlerts',
  'exitValuationAlerts',
  'nonSterlingFeeAlerts',
  'unattributedFlattenFillAlerts',
  'saxoSessionLostAlerts',
] as const satisfies readonly AlertId[];

export type UnloggedAlertId = (typeof UNLOGGED_ALERT_IDS)[number];
export type LoggedAlertId = Exclude<AlertId, UnloggedAlertId>;

/** The port interface a pipeline stage consumes for `K` — e.g. `BreachAlertChannel`. */
export type AlertPort<K extends AlertId> = NonNullable<AlertChannelSlots[K]>;

/** What the port's single method is called with — the alert, or the heartbeat's `Date`. */
export type AlertOf<K extends AlertId> = AlertPort<K>[keyof AlertPort<K>] extends (
  alert: infer A,
) => unknown
  ? A
  : never;

type Delivery<K extends AlertId> =
  | { readonly delivery: 'awaited' }
  | {
      readonly delivery: 'detached';
      /** The log line for a send that failed — the only trace a detached page leaves. */
      sendFailed(alert: AlertOf<K>, error: unknown): LogEntry;
    };

type Logging<K extends AlertId> = K extends UnloggedAlertId
  ? { readonly log?: never }
  : { log(alert: AlertOf<K>): LogEntry };

export type AlertSpec<K extends AlertId> = {
  readonly method: keyof AlertPort<K> & string;
  text(alert: AlertOf<K>): string;
  /** Returns `false` to drop the page before the transport is touched. Absent means always page. */
  page?(alert: AlertOf<K>): boolean;
} & Delivery<K> &
  Logging<K>;

/**
 * The catalogue as the two adapters read it, one entry at a time: method
 * syntax so each entry's alert-typed methods are assignable here, and the
 * table's own mapped type is what keeps every entry honest.
 */
interface AnyAlertSpec {
  readonly method: string;
  readonly delivery: 'awaited' | 'detached';
  text(alert: unknown): string;
  page?(alert: unknown): boolean;
  log?(alert: unknown): LogEntry;
  sendFailed?(alert: unknown, error: unknown): LogEntry;
}

const LOG_ONLY_CANNOT_PAGE =
  'SAMURAI_ALERTS=log-only cannot page anyone about this; use SAMURAI_ALERTS=telegram ' +
  'for an unattended run.';

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

const EXIT_VALUATION_SEAM_LABEL: Record<ExitValuationDegradedAlert['seam'], string> = {
  risk: 'the Risk stage (sizing and recording the exit)',
  verdict: "the Verdict stage (the `breaker` gate (5)'s fire-time re-check)",
  // #826 — the exit's OWN mark, one stage earlier than the other two.
  trader: 'the Trader stage (the exited instrument had no mark at all)',
};

const PARTLY_VALUED_BOOK_COPY = {
  headline: 'EXIT PRICED ON A PARTLY-VALUED BOOK',
  namesLabel: 'Held instruments that could NOT be valued',
  consequence:
    'The exit was NOT suppressed (#841, ADR-0014 flat-by-close) — it proceeded, and the ' +
    'portfolio figures in risk_log for this trace exclude the names above, so they understate ' +
    'exposure and drawdown. NEW ENTRIES are still refused while the book cannot be fully ' +
    'valued. Check the market-data feed for the named instruments.',
};

/**
 * Varied per seam because the two conditions cost different things: #841's
 * seams leave `risk_log`'s portfolio figures understated, while #826's leaves
 * the INTENT's own price fields meaningless.
 */
const EXIT_VALUATION_SEAM_COPY: Record<
  ExitValuationDegradedAlert['seam'],
  { headline: string; namesLabel: string; consequence: string }
> = {
  risk: PARTLY_VALUED_BOOK_COPY,
  verdict: PARTLY_VALUED_BOOK_COPY,
  trader: {
    headline: 'MANDATORY FLATTEN SENT WITHOUT A MARK',
    namesLabel: 'Instrument whose mark could NOT be read',
    consequence:
      'The flat-by-close exit was NOT suppressed (#826, ADR-0014) — it proceeded as a market ' +
      'flatten sized to the held quantity, which needs no price. Its entry/stop/target are ' +
      'RECORDED AS ZERO and mean nothing; Verdict skipped its drift and stale-feed gates for ' +
      'this intent alone. Only the mandatory flatten degrades this way — every entry and every ' +
      'discretionary exit still fails loudly while the feed is down. Check the market-data feed ' +
      'for the named instrument.',
  },
};

const THRESHOLD_CLAMP_WHERE_LABEL: Record<ThresholdClampAlert['where'], string> = {
  'live-read':
    'the live risk_thresholds read (RiskManagerImpl.evaluate, every tick) — new entries are ' +
    'refused; exits and the flat-by-close flatten do not consult this table and are unaffected',
  'daily-kill-line-check':
    "the daily feedback cycle's kill-line check (computeMetrics) — the cycle stopped " +
    'completing; the four kill-lines are unevaluated until the offending row is fixed',
};

/**
 * The stage each seam's own lines already carry, so the failed-send line files
 * beside them (#1280): the daily seam runs in `runFeedbackCycle`, whose
 * `feedback_cycle_failed` catch — the very catch that raises this alert — logs
 * `stage: 'feedback-loop'`.
 */
const THRESHOLD_CLAMP_WHERE_STAGE: Record<ThresholdClampAlert['where'], string> = {
  'live-read': 'risk',
  'daily-kill-line-check': 'feedback-loop',
};

/**
 * What each Trader diagnostic kind means and what it costs while it persists —
 * the operator's first question is "do I have to do something tonight", and
 * the answer differs sharply between a parked book and one bad instrument.
 */
const TRADER_DIAGNOSTIC_CONSEQUENCE: Record<TraderDiagnosticAlert['diagnostic']['kind'], string> = {
  session_end_absent_on_non_crypto:
    'A non-crypto calendar returned no session end at all, so flat-by-close (ADR-0014) cannot ' +
    'be enforced for this leg — a position opened on it may be carried overnight.',
  atr_not_finite:
    'ATR was not finite on a FULL bar window, which means corrupt market data rather than a ' +
    'warm-up gap. This instrument cannot price a stop and is skipping every tick.',
  control_arm_valuation_refused:
    'The control arm (#753 falsifier arm 2) could not value its shadow book and skipped this ' +
    'pass instead of crashing it. The live arm is unaffected, but a control that keeps skipping ' +
    'cannot answer the debate-beats-indicators question at the end of the soak (#1089).',
  lot_carried_past_session_close:
    'A lot is STILL OPEN after the flatten grace expired, so flat-by-close (ADR-0014) has been ' +
    'MISSED for this session and the position is carried overnight — on a leveraged ETP that is ' +
    'the worst outcome the intraday horizon has. Nothing will target it again until the next ' +
    "session's flatten window; closing it before then is a manual decision at the venue.",
};

/**
 * `FlattenReconcileAlert.trace_id`'s documented contract: the control arm's
 * surfaces are the live arm's own id with this prefix. DECISION (David,
 * 2026-09-08, #1349): the control arm's broker is `SimulatedBrokerAdapter`,
 * which never throws and holds no venue — this page's one instruction, "check
 * the order on the venue by hand", cannot be carried out for it, so every
 * control-arm page is a false, unactionable one that trains an operator to
 * discount the live arm's real escalations. The reconcile pass still logs
 * unconditionally (fill-sync.ts's `reconcile_divergence` line) — only the
 * phone page is gated.
 */
function isControlArmTraceId(traceId: string): boolean {
  return traceId.startsWith('control-arm-');
}

export const ALERT_CATALOGUE: { readonly [K in AlertId]: AlertSpec<K> } = {
  heartbeatChannel: {
    method: 'postHeartbeat',
    delivery: 'awaited',
    // A log line nobody tails is not a dead-man's switch — it is a diary. Fine
    // for a supervised smoke run, never for an unattended soak (#238).
    log: (timestamp) => ({
      trace_id: 'heartbeat',
      stage: 'orchestrator',
      level: 'info',
      message: 'heartbeat',
      payload: { timestamp: timestamp.toISOString() },
    }),
    text: (timestamp) => `Samurai heartbeat: alive at ${timestamp.toISOString()}`,
  },

  orphanAlerts: {
    method: 'postOrphanAlert',
    delivery: 'awaited',
    // `error`, not `warn`: an orphaned `go` means a verdict approved a trade
    // and the process died before Execution recorded what happened to it —
    // the one state that can hide a real position from the system.
    log: (orphan) => ({
      trace_id: orphan.trace_id,
      stage: 'orchestrator',
      event: 'orphan_verdict_found',
      level: 'error',
      message: 'orphaned go verdict found at startup — verify against the venue',
      payload: { ...orphan },
    }),
    text: (orphan) =>
      `Samurai ORPHANED GO VERDICT: a 'go' for ${orphan.instrument} was recorded at ` +
      `${orphan.verdict_timestamp.toISOString()} with no matching execution record — this ` +
      'process died between Verdict and Execution.\n' +
      `Client order id ${orphan.idempotency_key}, trace ${orphan.trace_id}.\n` +
      'An order may or may not have reached the venue, and nothing resubmits or cancels it ' +
      'automatically. Check the venue for that client order id and reconcile it by hand.',
  },

  unpricedFillAlerts: {
    method: 'postUnpricedFillAlert',
    delivery: 'awaited',
    log: (alert) => ({
      // Not a tick trace: a broker anomaly observed by the fill poll, the same
      // synthetic-trace convention `Heartbeat`/`OrphanVerdictScanner` use for
      // work that belongs to no pipeline pass.
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
    }),
    text: (alert) => {
      const minutes = Math.round(alert.unpriced_for_ms / 60_000);
      return (
        `Samurai STUCK LOT: ${alert.venue} reports ${alert.qty} ${alert.instrument} ` +
        `filled on the ${alert.leg} leg but will not price it (${minutes}m unpriced, ` +
        `threshold ${Math.round(alert.age_out_ms / 60_000)}m).\n` +
        `Order ${alert.broker_fill_id}, lot ${alert.client_order_id}, ` +
        `first seen ${alert.first_seen_at.toISOString()}.\n` +
        'The fill cannot be booked, so the lot stays under-filled, its stop is sized ' +
        'to the wrong quantity and no closed trade will be emitted. Check the order ' +
        'on the venue and reconcile it by hand.'
      );
    },
  },

  residualExposureAlerts: {
    method: 'postResidualExposureAlert',
    delivery: 'awaited',
    log: (alert) => ({
      // Threaded from the alert (#1348): the live and control arms post
      // through this SAME instance, so the id of the surface the sweep ran on
      // is the only thing in the line that tells a real venue's unprotected
      // residual from a simulated broker's. See `ResidualExposureAlert.trace_id`.
      trace_id: alert.trace_id,
      stage: 'execution',
      event: 'residual_exposure_unprotected',
      level: 'error',
      message: alert.rearm_unsupported
        ? 'a residual position is unprotected and this venue cannot arm protective legs at ' +
          'all, so no retry will ever protect it — close or protect the order by hand'
        : 'a partially-filled flatten left a residual position and re-arming its protective ' +
          'legs failed — the position is unprotected; check the order on the venue by hand',
      // Field by field, so `trace_id` is not repeated inside the payload it
      // already labels the entry with.
      payload: {
        idempotency_key: alert.idempotency_key,
        instrument: alert.instrument,
        side: alert.side,
        residual_qty: alert.residual_qty,
        residual_qty_is_upper_bound: alert.residual_qty_is_upper_bound,
        rearm_unsupported: alert.rearm_unsupported,
        stop: alert.stop,
        target: alert.target,
        observed_at: alert.observed_at.toISOString(),
      },
    }),
    text: (alert) => {
      const qtyClause = alert.residual_qty_is_upper_bound
        ? `at most ${alert.residual_qty} (upper bound — the exact residual could not be read)`
        : `${alert.residual_qty}`;

      // #1214: the two cases need different operator behaviour, so they must
      // not read alike. A failed re-arm is retried by the #549 sweep on cadence
      // and may clear itself; a venue that cannot express an entry-less
      // protective pair at all never will, and the operator IS the remedy.
      const remedyClause = alert.rearm_unsupported
        ? `Lot ${alert.idempotency_key}. This venue cannot arm protective legs at all (no ` +
          `entry-less stop+target), so NOTHING will retry stop ${alert.stop} / target ` +
          `${alert.target}.\nClose or protect this position by hand.`
        : `Lot ${alert.idempotency_key}. Re-arming at stop ${alert.stop} / target ${alert.target} ` +
          'failed.\nCheck the position on the venue and re-arm or close it by hand.';

      return (
        `Samurai UNPROTECTED RESIDUAL: ${alert.instrument} has ${qtyClause} units left open on the ` +
        `${alert.side} side with NO protective legs armed, as of ${alert.observed_at.toISOString()}.\n` +
        remedyClause
      );
    },
  },

  ocoDoubleFillAlerts: {
    method: 'postOcoDoubleFillAlert',
    delivery: 'awaited',
    log: (alert) => ({
      // Observed by the fill poll, not any one tick — `unpriced-fill`'s convention.
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
    }),
    text: (alert) =>
      `Samurai OCO DOUBLE FILL: ${alert.instrument} — BOTH emulated protective legs filled ` +
      `(stop ${alert.stop_order_id}, target ${alert.target_order_id}) as of ` +
      `${alert.observed_at.toISOString()}.\n` +
      `Lot ${alert.client_order_id}. The lot is over-closed and a REVERSE position may now be ` +
      'open at the venue. Nothing was unwound automatically — check the position and close it ' +
      'by hand.',
  },

  legResizeAlerts: {
    method: 'postLegResizeUnverifiedAlert',
    delivery: 'awaited',
    log: (alert) => ({
      trace_id: 'leg-resize-unverified',
      stage: 'execution',
      event: 'leg_resize_unverified',
      level: 'error',
      message:
        'a partial entry filled on a venue that cannot confirm its protective legs were ' +
        'resized — the stop may still be sized to the original amount and would over-close ' +
        'into a reversed position; check the legs on the venue by hand',
      payload: {
        client_order_id: alert.client_order_id,
        instrument: alert.instrument,
        requested_qty: alert.requested_qty,
        filled_qty: alert.filled_qty,
        observed_at: alert.observed_at.toISOString(),
      },
    }),
    text: (alert) =>
      `Samurai UNVERIFIED STOP SIZE: ${alert.instrument} filled ${alert.filled_qty} of ` +
      `${alert.requested_qty ?? 'an unjournalled'} on the entry leg, and this venue cannot ` +
      'confirm the protective legs were resized.\n' +
      `Lot ${alert.client_order_id}, observed ${alert.observed_at.toISOString()}.\n` +
      'If the stop is still sized to the original amount it will over-close into a reversed ' +
      'position when it fires. Check the legs on the venue and resize them by hand.',
  },

  dormantLegsAlerts: {
    method: 'postDormantLegsUnresolvedAlert',
    delivery: 'awaited',
    log: (alert) => ({
      trace_id: 'dormant-legs-unresolved',
      stage: 'execution',
      event: 'dormant_legs_unresolved',
      level: 'error',
      message:
        'a dormant protective-leg pair has no terminal verdict in the venue audit trail — the ' +
        'legs are left standing rather than cancelled on no evidence; resolve the order by hand',
      payload: {
        client_order_id: alert.client_order_id,
        instrument: alert.instrument,
        stuck_ms: alert.stuck_ms,
        observed_at: alert.observed_at.toISOString(),
      },
    }),
    text: (alert) =>
      `Samurai WEDGED LEGS: ${alert.instrument} has a dormant protective-leg pair the venue ` +
      `audit trail will not give a verdict on (${Math.round(alert.stuck_ms / 60_000)}m).\n` +
      `Lot ${alert.client_order_id}, observed ${alert.observed_at.toISOString()}.\n` +
      'The legs are deliberately NOT cancelled without evidence they are done, so this will ' +
      'not clear itself. Resolve the order on the venue by hand.',
  },

  priceUnitAlerts: {
    method: 'postUnresolvedPriceUnitAlert',
    delivery: 'awaited',
    log: (alert) => ({
      trace_id: 'unresolved-price-unit',
      stage: 'execution',
      event: 'unresolved_price_unit',
      level: 'error',
      message:
        'a priced fill arrived for a Uic no pool line resolves, so the quote unit is unknown ' +
        'and the fill cannot be expressed as cash — it is refused, and every subsequent poll ' +
        'refuses it again until the pool and the venue agree',
      payload: {
        client_order_id: alert.client_order_id,
        broker_fill_id: alert.broker_fill_id,
        uic: alert.uic,
        observed_at: alert.observed_at.toISOString(),
      },
    }),
    text: (alert) =>
      `Samurai UNPRICEABLE FILL: a priced fill arrived for Uic ${alert.uic}, which resolves to ` +
      'no pool line, so its quote unit is unknown and the cash it represents cannot be ' +
      'derived.\n' +
      `Lot ${alert.client_order_id}, venue fill ${alert.broker_fill_id}, observed ` +
      `${alert.observed_at.toISOString()}.\n` +
      'The fill is refused rather than booked — on a pence-quoted line an unscaled price is ' +
      '100x wrong — and every subsequent poll refuses it again, so no lot goes terminal ' +
      'until the pool and the venue agree on this instrument.',
  },

  flattenReconcileAlerts: {
    method: 'postFlattenReconcileAlert',
    delivery: 'awaited',
    page: (alert) => !isControlArmTraceId(alert.trace_id),
    log: (alert) => ({
      // Threaded from the alert (#1331): the live and control arms post
      // through this SAME instance, and the `control-arm-` prefix is what
      // names the arm — the startup pass logs `reconcile`/`control-arm-reconcile`,
      // the poll `fill-sync`/`control-arm-fill-sync`. See
      // `FlattenReconcileAlert.trace_id`.
      trace_id: alert.trace_id,
      stage: 'execution',
      event: 'flatten_reconcile_unresolved',
      level: 'error',
      message:
        "reconcile() could not settle a flatten_submissions row — the flatten's outcome is " +
        'genuinely unknown; check the order on the venue by hand',
      payload: {
        idempotency_key: alert.idempotency_key,
        instrument: alert.instrument,
        reason: alert.reason,
        observed_at: alert.observed_at.toISOString(),
      },
    }),
    // Labelled with `trace_id` (#1349): the poll's `reconcile`/`fill-sync`
    // split otherwise has no operator-visible marker on the page itself.
    text: (alert) =>
      `Samurai UNRESOLVED FLATTEN [${alert.trace_id}]: ${alert.instrument} (flatten ` +
      `${alert.idempotency_key}) could not be settled against the venue as of ` +
      `${alert.observed_at.toISOString()}.\n` +
      `${alert.reason}\n` +
      'Whether this position is still held is genuinely unknown. Check the order and the position ' +
      'on the venue by hand.',
  },

  analystSkipAlerts: {
    method: 'postAnalystSkipAlert',
    delivery: 'awaited',
    log: (alert) => ({
      // The alert is about a RUN of ticks, so it belongs to none of them.
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
    }),
    // The reasons are the only thing that distinguishes a bad API key from a
    // data outage from a market that is genuinely closed.
    text: (alert) => {
      const reasons = alert.failures
        .map((failure) => `- ${failure.analyst_type} (${failure.role}): ${failure.reason}`)
        .join('\n');

      return (
        `Samurai ANALYST STAGE SKIPPING: ${alert.instrument} has skipped ` +
        `${alert.consecutive_skips} consecutive ticks as of ` +
        `${alert.reported_at.toISOString()}.\n` +
        'No debate, no trade and no decision is being produced for it — the heartbeat keeps ' +
        'beating regardless, so this will not show up as downtime.\n' +
        `Failures behind the current skip:\n${reasons || '- (none reported)'}`
      );
    },
  },

  breachAlerts: {
    method: 'postBreachAlert',
    delivery: 'detached',
    log: (alert) => ({
      // Mixed, so answered at runtime (#1280): the daily kill-line batch keeps
      // the synthetic `feedback-cycle` trace; an `llm_spend_cap` breach is
      // raised inside a tick by `SqliteSpendCap#refuse` and joins that trace.
      // A third provenance — boot's `startingTotal()`, with no ambient trace —
      // lands on the fallback and is indistinguishable from the daily batch;
      // `BreachAlert` carries no field to resolve it.
      trace_id: currentTraceId() ?? 'feedback-cycle',
      stage: breachStage(alert),
      event: 'kill_threshold_breach',
      level: 'error',
      message: breachLogMessage(alert.breaches),
      payload: {
        breaches: alert.breaches,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: formatBreachAlert,
    // A breach that could not be delivered is itself an operator-visible
    // event — otherwise the one alert that matters most fails silently.
    sendFailed: (alert, error) => ({
      trace_id: currentTraceId() ?? 'feedback-cycle',
      stage: breachStage(alert),
      event: 'breach_alert_send_failed',
      level: 'error',
      message: `${breachLabel(alert.breaches)} alert failed to send — the breach still stands`,
      payload: {
        breaches: alert.breaches,
        reported_at: alert.reported_at.toISOString(),
        error: describeThrownSafely(error),
      },
    }),
  },

  loosenNotices: {
    method: 'notifyLoosenApplied',
    delivery: 'detached',
    // `warn`, not `error`: a dial moved inside limits a human set. Not `info`
    // either: a safety limit widening with nobody asked is the thing an
    // operator scanning a soak log must not scroll past.
    log: (notice) => ({
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
    }),
    // Past tense and no call to action: ADR-0013 Decision 2 removed the gate
    // this used to ask for, and nothing here polls Telegram for a reply.
    text: (notice) =>
      `Samurai RISK-THRESHOLD LOOSENED: ${notice.name} ${notice.from} -> ${notice.to}.\n` +
      `Applied ${notice.applied_at.toISOString()} — already in force.\n` +
      'This is a notification, not a request: the Feedback Loop applies its own bounded dial moves ' +
      '(ADR-0013). The move was capped at one step, clamped to the dial bounds, and logged to ' +
      'dial_adjustments, which is what you reverse it from. No reply is read here.',
    // `error`: the move is already in force, so a lost notice means the
    // operator's picture of the risk limits is wrong until they read the
    // adjustment log.
    sendFailed: (notice, error) => ({
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      event: 'loosen_notice_send_failed',
      level: 'error',
      message:
        'risk-threshold loosening notice failed to send — the threshold WAS loosened and ' +
        'nobody was told',
      payload: {
        name: notice.name,
        from: notice.from,
        to: notice.to,
        applied_at: notice.applied_at.toISOString(),
        applied: true,
        error: describeThrownSafely(error),
      },
    }),
  },

  traderDiagnosticAlerts: {
    method: 'postTraderDiagnosticAlert',
    delivery: 'awaited',
    text: (alert) => {
      const { diagnostic } = alert;
      // `asset_class` is `undefined` for exactly `control_arm_valuation_refused`
      // (see `TraderDiagnostic.asset_class`), so the parenthetical is omitted
      // rather than rendering the literal string "undefined".
      const assetClassSuffix =
        diagnostic.asset_class === undefined ? '' : ` (${diagnostic.asset_class})`;
      // Only `lot_carried_past_session_close` sets `arm` (see
      // `TraderDiagnosticAlert.arm`); omitted rather than printing "undefined arm".
      const armSuffix = alert.arm === undefined ? '' : ` [${alert.arm} arm]`;
      return (
        `Samurai TRADER DEGRADED: ${alert.instrument}${assetClassSuffix}${armSuffix} reported ` +
        `${diagnostic.kind} on ${alert.consecutive_ticks} consecutive tick(s) as of ` +
        `${alert.reported_at.toISOString()}.\n` +
        `${TRADER_DIAGNOSTIC_CONSEQUENCE[diagnostic.kind]}\n` +
        `Detail: ${diagnostic.detail}\n` +
        'The Trader is still running and still returning decisions, so this will not show up as ' +
        'downtime and the heartbeat will keep beating.'
      );
    },
  },

  miCoverageAlerts: {
    method: 'postCoverageAlert',
    delivery: 'awaited',
    // `warn` — a counter's severity, not an escalation's (#752 criterion 6).
    log: (alert) => ({
      trace_id: alert.trace_id,
      stage: 'analysts',
      event: 'mi_coverage_degraded',
      level: 'warn',
      message:
        `market-intelligence coverage degraded for ${alert.instrument} (subclass=` +
        `${alert.subclass}) — no scored item inside the staleness window. ` +
        LOG_ONLY_CANNOT_PAGE,
      payload: {
        instrument: alert.instrument,
        asset_class: alert.asset_class,
        subclass: alert.subclass,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: (alert) =>
      `Samurai MARKET-INTELLIGENCE COVERAGE DEGRADED: ${alert.instrument} ` +
      `(${alert.asset_class}, subclass=${alert.subclass}) has no scored intelligence item inside ` +
      `the staleness window as of ${alert.reported_at.toISOString()}.\n` +
      'The debate is still running on this name — coverage is measured, never gated (ADR-0016 ' +
      "D2) — but the desk is narrowed by one analyst's worth of evidence until this clears. " +
      'This is a PER-TICKER gap: the macro layers (GDELT, Polymarket) file class-wide items ' +
      'under macro series names on purpose, so they never clear it. See the coverage section of ' +
      'docs/specs/market-intelligence-spec.md for which sources can cover a ticker and what to ' +
      'check when one stops.',
  },

  thresholdClampAlerts: {
    method: 'postThresholdClampAlert',
    delivery: 'detached',
    text: (alert) =>
      `Samurai THRESHOLD CLAMP TRIPPED: ${THRESHOLD_CLAMP_WHERE_LABEL[alert.where]}.\n` +
      `Detected ${alert.reported_at.toISOString()}.\n` +
      `Refusal: ${alert.message}\n` +
      'An out-of-bound risk threshold was REFUSED rather than applied (#638) — this is fail-' +
      'closed on trading, not a live risk exposure. Fix the offending risk_thresholds row.',
    sendFailed: (alert, error) => ({
      // The seam's own id, threaded on the alert (#1280), so this line joins
      // whichever catch raised it rather than a third taxonomy joining neither.
      trace_id: alert.trace_id,
      stage: THRESHOLD_CLAMP_WHERE_STAGE[alert.where],
      event: 'threshold_clamp_alert_send_failed',
      level: 'error',
      message: 'threshold-clamp alert failed to send — the clamp trip still stands',
      payload: {
        where: alert.where,
        reported_at: alert.reported_at.toISOString(),
        error: describeThrownSafely(error),
      },
    }),
  },

  dataFailoverAlerts: {
    method: 'postDataFailoverAlert',
    delivery: 'awaited',
    // `warn`, not `error`: by the time this is called the fallback vendor has
    // already been asked. What this records is that the run has left its
    // primary data vendor — a fact an operator needs, not a stage failure.
    log: (alert) => ({
      // A single failover on a single fetch belongs to the tick that caused
      // it, matching `production/data-failover.ts`'s catch-line (#1118/#1181);
      // the constant only outside a tick (#1183).
      trace_id: currentTraceId() ?? 'data-failover',
      stage: 'orchestrator',
      event: 'ohlcv_failover_engaged',
      level: 'warn',
      message:
        `OHLCV failover on the ${alert.leg} leg: ${alert.primaryName} failed for ` +
        `${alert.symbol} ${alert.timeframe} (${alert.primaryError}), so ${alert.fallbackName} ` +
        'is serving those bars. ' +
        LOG_ONLY_CANNOT_PAGE,
      payload: {
        leg: alert.leg,
        instrument: alert.symbol,
        timeframe: alert.timeframe,
        primary: alert.primaryName,
        fallback: alert.fallbackName,
        reported_at: alert.reported_at.toISOString(),
        suppressed_since_last: alert.suppressed_since_last,
      },
    }),
    text: (alert) =>
      `Samurai MARKET-DATA FAILOVER (${alert.leg}): ${alert.primaryName} failed for ` +
      `${alert.symbol} ${alert.timeframe} at ${alert.reported_at.toISOString()} — ` +
      `${alert.primaryError}\n` +
      (alert.suppressed_since_last > 0
        ? `${alert.suppressed_since_last} further failover(s) for this instrument were suppressed ` +
          'by the alert throttle since the last message — the stall is ongoing, not intermittent.\n'
        : '') +
      `${alert.fallbackName} is serving those bars instead. The run continues on a DEGRADED ` +
      'data path: fallback bars are stamped with their own source, and their volume convention ' +
      "differs from the primary's, which moves getADV()'s denominator while they sit in the " +
      'window. Marks are NOT failed over — only bars — so a primary that cannot quote still ' +
      'fails loudly. Check whether the primary vendor is stalled.',
  },

  exitValuationAlerts: {
    method: 'postExitValuationDegradedAlert',
    delivery: 'detached',
    text: (alert) => {
      const copy = EXIT_VALUATION_SEAM_COPY[alert.seam];
      return (
        `Samurai ${copy.headline}: ${alert.instrument} at ${EXIT_VALUATION_SEAM_LABEL[alert.seam]}.\n` +
        `Detected ${alert.reported_at.toISOString()}.\n` +
        `${copy.namesLabel}: ${alert.unvalued_instruments.join(', ')}.\n` +
        `Why: ${alert.reason}\n` +
        copy.consequence
      );
    },
    sendFailed: (alert, error) => ({
      // `reportExitValuationDegraded` (direct-bind.ts) already logs this same
      // failed exit under `context.trace_id`; this joins it (#1183, #1280).
      trace_id: currentTraceId() ?? 'exit-valuation-degraded',
      // The seam that raised it, not a hardcoded `'risk'` — #826 added a
      // `trader` seam, and a line naming the wrong stage is worse than a
      // generic one when the operator is grepping for the feed fault.
      stage: alert.seam,
      event: 'exit_valuation_alert_send_failed',
      level: 'error',
      message:
        'exit-valuation-degraded alert failed to send — an exit was priced on a partly-' +
        'valued book (or, on the trader seam, sent with no mark at all) and nobody has ' +
        'been told',
      payload: {
        instrument: alert.instrument,
        seam: alert.seam,
        unvalued_instruments: alert.unvalued_instruments,
        reported_at: alert.reported_at.toISOString(),
        error: describeThrownSafely(error),
      },
    }),
  },

  calendarFallbackAlerts: {
    method: 'postCalendarFallbackAlert',
    delivery: 'detached',
    // `error`, not `warn`: unlike an OHLCV failover the fallback here is a
    // DIFFERENT calendar, hand-entered and checked only through
    // `fallback_coverage_end` — and its coverage gaps are the dangerous
    // direction for a flatten boundary (#684).
    log: (alert) => ({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'calendar_fallback_engaged',
      level: 'error',
      message:
        "paper equity leg's Alpaca calendar fetch failed at boot — fell back to the " +
        'hand-entered US equity session table. ' +
        LOG_ONLY_CANNOT_PAGE,
      payload: {
        reason: alert.reason,
        fallback_coverage_end: alert.fallback_coverage_end,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: (alert) =>
      `Samurai CALENDAR FETCH FAILED: the paper equity leg could not fetch Alpaca's ` +
      `GET /v2/calendar at boot, and fell back to the hand-entered session table.\n` +
      `Detected ${alert.reported_at.toISOString()}.\n` +
      `Fetch error: ${alert.reason}\n` +
      `Fallback table is checked through ${alert.fallback_coverage_end} — a date past that will ` +
      'THROW rather than silently assume a normal close (#684). Verify Alpaca connectivity; ' +
      'the run continues on the hand table until a restart re-fetches the live one.',
    sendFailed: (alert, error) => ({
      trace_id: 'calendar-fallback',
      stage: 'orchestrator',
      event: 'calendar_fallback_alert_send_failed',
      level: 'error',
      message: 'calendar-fallback alert failed to send — the fallback still stands',
      payload: {
        reported_at: alert.reported_at.toISOString(),
        error: describeThrownSafely(error),
      },
    }),
  },

  armDivergenceAlerts: {
    method: 'postArmDivergenceAlert',
    delivery: 'detached',
    // `warn`: a MEASUREMENT the operator acts on with judgement — nothing has
    // failed, nothing was auto-tightened, no position is unprotected.
    log: (alert) => {
      const { live, control } = alert.comparison;
      return {
        trace_id: 'arm-divergence',
        stage: 'feedback-loop',
        event: 'arm_divergence_detected',
        level: 'warn',
        message:
          'ARM DIVERGENCE — the matched control (falsifier arm 2) is out-performing the live ' +
          'arm. ' +
          LOG_ONLY_CANNOT_PAGE,
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
      };
    },
    // Both arms, both columns, one line each — the D4 discipline
    // `formatArmComparison` holds at the CLI surface. The convergence caveat
    // travels with the alert: the control is always treated as converged, so a
    // non-converging stretch can PRODUCE this alert on its own, and an
    // operator acting on a phone notification has to see that in the message.
    text: (alert) => {
      const { live, control } = alert.comparison;
      return (
        'Samurai ARM DIVERGENCE: the matched control (falsifier arm 2) is out-performing the ' +
        'debate-driven live arm.\n' +
        `Window ${alert.comparison.from.toISOString()} → ${alert.comparison.to.toISOString()}, ` +
        `basis $${alert.comparison.basis.toFixed(2)} (the same denominator for both arms).\n` +
        `live:    ${live.trade_count} trade(s), return ${pct(live.return_pct)}, ` +
        `max drawdown ${pct(live.max_drawdown_pct)}\n` +
        `control: ${control.trade_count} trade(s), return ${pct(control.return_pct)}, ` +
        `max drawdown ${pct(control.max_drawdown_pct)}\n` +
        `Why this fired: ${alert.reason}.\n` +
        'Read both columns together — doc 12 D4 rules out a return-only reading against a ' +
        'risk-targeted stream.\n' +
        'ONE KNOWN ASYMMETRY: the control has no debate rounds, so it is always treated as ' +
        'converged. On bars where the live debate did not converge, the live arm takes a size ' +
        'haircut and refuses a scale-in and the control takes neither — a non-converging stretch ' +
        'can produce this reading on its own.\n' +
        `Detected ${alert.reported_at.toISOString()}. Nothing was auto-tightened: this is a ` +
        'measurement, not a kill-line breach.'
      );
    },
    sendFailed: (alert, error) => ({
      trace_id: 'arm-divergence',
      stage: 'feedback-loop',
      event: 'arm_divergence_alert_send_failed',
      level: 'error',
      message: 'arm-divergence alert failed to send — the divergence still stands',
      payload: {
        reported_at: alert.reported_at.toISOString(),
        reason: alert.reason,
        error: describeThrownSafely(error),
      },
    }),
  },

  tickSkipAlerts: {
    method: 'postTickSkipAlert',
    delivery: 'awaited',
    // Named instruments, not just a count: WHICH instruments are stuck decides
    // whether this is one venue lagging or the whole universe.
    log: (alert) => ({
      trace_id: 'tick-skip',
      stage: 'tick-loop',
      event: 'tick_pass_degraded',
      level: 'warn',
      message:
        `tick pass materially degraded: ${alert.skipped} of ${alert.planned} planned ` +
        `instrument(s) skipped (still running from a previous pass), ` +
        `${alert.consecutive_ticks} consecutive tick(s). ` +
        LOG_ONLY_CANNOT_PAGE,
      payload: {
        skipped: alert.skipped,
        planned: alert.planned,
        skipped_instruments: alert.skipped_instruments,
        consecutive_ticks: alert.consecutive_ticks,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: (alert) => {
      const names = alert.skipped_instruments.join(', ');
      return (
        `Samurai TICK PASS DEGRADED: ${alert.skipped} of ${alert.planned} planned instrument(s) ` +
        `skipped this tick — still running from a previous pass.\n` +
        `Consecutive degraded tick(s): ${alert.consecutive_ticks}.\n` +
        `Skipped: ${names || '(none named)'}\n` +
        `As of ${alert.reported_at.toISOString()}.\n` +
        'The skip mechanism itself is unchanged (#669, #692) — this is an escalation, not a new ' +
        'behaviour. Check whether one instrument is hung or the concurrency cap needs revisiting.'
      );
    },
  },

  promptTierAlerts: {
    method: 'postPromptTierAlert',
    delivery: 'detached',
    log: (alert) => ({
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
    }),
    text: (alert) =>
      `Samurai PROMPT-TIER CROSSED: ${alert.model} priced ${alert.prompt_tokens} prompt ` +
      `tokens, above its ${alert.above_prompt_tokens}-token large-prompt tier ` +
      `(#${alert.consecutive_crossings} consecutive call as of ${alert.reported_at.toISOString()}).\n` +
      'This call priced at the tier rate — a 2.5x unit-cost step against the base rate, ' +
      "against ADR-0008's $50/14d cap.\n" +
      `Trace ${alert.trace_id}, stage ${alert.stage}${alert.debate_id ? `, debate ${alert.debate_id}` : ''}.`,
    sendFailed: (alert, error) => ({
      trace_id: alert.trace_id,
      stage: alert.stage,
      event: 'prompt_tier_alert_send_failed',
      level: 'error',
      message: 'prompt-tier alert failed to send — the crossing still stands',
      payload: {
        model: alert.model,
        consecutive_crossings: alert.consecutive_crossings,
        reported_at: alert.reported_at.toISOString(),
        error: describeThrownSafely(error),
      },
    }),
  },

  lseCalendarCoverageAlerts: {
    method: 'postLseCalendarCoverageAlert',
    delivery: 'detached',
    // `warn`, not `error`: nothing has degraded yet — the guard posts this
    // only while the cliff is still ahead; once it is behind, boot REFUSES
    // outright instead of reaching this channel at all (#1378).
    log: (alert) => ({
      trace_id: 'startup',
      stage: 'orchestrator',
      event: 'lse_calendar_coverage_horizon',
      level: 'warn',
      message:
        `the LIVE equity leg's hand-entered LSE session tables are checked only through ` +
        `${alert.coverage_end} — ${alert.days_remaining} day(s) remaining. Extend ` +
        'LSE_HOLIDAYS/LSE_HALF_DAYS before that date; boot will refuse the live leg once it ' +
        'passes. ' +
        LOG_ONLY_CANNOT_PAGE,
      payload: {
        coverage_end: alert.coverage_end,
        days_remaining: alert.days_remaining,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: (alert) =>
      'Samurai LSE CALENDAR COVERAGE ENDING SOON: the LIVE equity leg runs on ' +
      `LseRegularHoursCalendar's hand-entered tables, checked through ${alert.coverage_end}.\n` +
      `${alert.days_remaining} day(s) remaining as of ${alert.reported_at.toISOString()}.\n` +
      'Extend LSE_HOLIDAYS/LSE_HALF_DAYS (trading-calendar.ts) before that date — boot will ' +
      'REFUSE to start the live leg once it passes, naming the date and what to extend.',
    sendFailed: (alert, error) => ({
      trace_id: 'lse-calendar-coverage',
      stage: 'orchestrator',
      event: 'lse_calendar_coverage_alert_send_failed',
      level: 'error',
      message: 'LSE calendar coverage-horizon alert failed to send — the horizon still stands',
      payload: {
        coverage_end: alert.coverage_end,
        days_remaining: alert.days_remaining,
        reported_at: alert.reported_at.toISOString(),
        error: describeThrownSafely(error),
      },
    }),
  },

  llmFailureRateAlerts: {
    method: 'postLlmFailureRateAlert',
    delivery: 'awaited',
    log: (alert) => ({
      trace_id: 'llm-failure-rate',
      stage: 'debate',
      event: 'llm_failure_rate_elevated',
      level: 'warn',
      message:
        `llm_failure rate ${(alert.rate * 100).toFixed(1)}% over the last ${Math.round(alert.window_ms / 3_600_000)}h ` +
        `(${alert.llm_failure_count}/${alert.total_count} truncations) — ` +
        LOG_ONLY_CANNOT_PAGE,
      payload: {
        rate: alert.rate,
        llm_failure_count: alert.llm_failure_count,
        total_count: alert.total_count,
        window_ms: alert.window_ms,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: (alert) => {
      const hours = Math.round(alert.window_ms / 3_600_000);
      const rate = (alert.rate * 100).toFixed(1);
      return (
        `Samurai LLM FAILURE RATE ELEVATED: ${rate}% of truncations over the last ${hours}h ` +
        `(${alert.llm_failure_count}/${alert.total_count}) truncated on an outright LLM call ` +
        `failure, as of ${alert.reported_at.toISOString()}.\n` +
        'Check the LLM provider status and the rate-limited client for sustained 429s/5xxs — a ' +
        'debate log row alone cannot tell live provider trouble from a spend-cap refusal.'
      );
    },
  },

  // #1533. A SEPARATE entry from `llmFailureRateAlerts` above, not extra words
  // in its text: refusals are a designed steady state (four of every six
  // concurrent debates at the shipped gate settings, `production/defaults.ts`)
  // and only their RATIO climbing toward 1 is a fault, so the two conditions
  // need different thresholds and different remedies. Blending them into one
  // alert is review round 1's F1 (`gate-refusal-rate-guard.ts`).
  gateRefusalRateAlerts: {
    method: 'postGateRefusalRateAlert',
    delivery: 'awaited',
    log: (alert) => ({
      trace_id: 'gate-refusal-rate',
      stage: 'debate',
      event: 'gate_refusal_rate_elevated',
      level: 'warn',
      message:
        `in-flight gate refused ${(alert.rate * 100).toFixed(1)}% of debates over the last ${Math.round(alert.window_ms / 3_600_000)}h ` +
        `(${alert.gate_refused_count}/${alert.decision_count} refused or run) — ` +
        LOG_ONLY_CANNOT_PAGE,
      payload: {
        rate: alert.rate,
        gate_refused_count: alert.gate_refused_count,
        decision_count: alert.decision_count,
        window_ms: alert.window_ms,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: (alert) => {
      const hours = Math.round(alert.window_ms / 3_600_000);
      const rate = (alert.rate * 100).toFixed(1);
      return (
        `Samurai GATE REFUSAL RATE ELEVATED: the in-flight LLM gate refused ${rate}% of debates ` +
        `over the last ${hours}h (${alert.gate_refused_count} refused of ` +
        `${alert.decision_count} refused-or-run), as of ${alert.reported_at.toISOString()}.\n` +
        'Refusing most of a pass is DESIGNED (maxInFlightLlmCalls admits two of six concurrent ' +
        'instruments); refusing nearly all of one is not — check whether a permit is stuck, ' +
        'whether per-call latency has risen past expectedLlmCallMs, and how few debates reached ' +
        'debate_log at all. This threshold is provisional and unmeasured (#1427).'
      );
    },
  },

  nonSterlingFeeAlerts: {
    method: 'postNonSterlingFeeAlert',
    delivery: 'awaited',
    text: (alert) =>
      `Samurai NON-STERLING FEE: ${alert.instrument} (lot ${alert.idempotency_key}) booked a fill ` +
      `fee of ${alert.fee} ${alert.fee_currency}, not ${alert.book_currency}.\n` +
      `Fill ${alert.broker_fill_id}. tradeableUniverse() should have excluded this instrument — ` +
      'check the universe pool and universe-selector wiring for a selection-layer defect.',
  },

  unattributedFlattenFillAlerts: {
    method: 'postUnattributedFlattenFillAlert',
    delivery: 'awaited',
    text: (alert) =>
      `Samurai UNATTRIBUTED FLATTEN FILL: flatten ${alert.flatten_idempotency_key} sold ` +
      `${alert.qty} against lot ${alert.lot_idempotency_key}, which had already closed, as of ` +
      `${alert.observed_at.toISOString()}.\n` +
      `Fill ${alert.broker_fill_id} is booked, but that lot's closed trade understates the sale — ` +
      'check the venue for a REVERSE position no open lot explains, and correct the realized ' +
      'record by hand.',
  },

  saxoSessionLostAlerts: {
    method: 'postSaxoSessionLostAlert',
    delivery: 'detached',
    text: (alert) =>
      `Samurai SAXO SESSION LOST (${alert.environment}): ${alert.reason}\n` +
      `Detected ${alert.reported_at.toISOString()}.\n` +
      'No order can reach this venue until a fresh session is established. Run ' +
      `\`yarn saxo:login --env ${alert.environment}\` to log in again.`,
    sendFailed: (alert, error) => ({
      trace_id: 'saxo-token',
      stage: 'orchestrator',
      event: 'saxo_session_lost_alert_send_failed',
      level: 'error',
      message: 'Saxo session-lost alert failed to send — the session is still lost',
      payload: {
        environment: alert.environment,
        reason: alert.reason,
        reported_at: alert.reported_at.toISOString(),
        error: describeThrownSafely(error),
      },
    }),
  },

  saxoWeeklyReminderAlerts: {
    method: 'postSaxoWeeklyReminderAlert',
    delivery: 'awaited',
    // `warn`: nothing has failed, this is a standing reminder Saxo itself
    // recommends (see saxo-weekly-reminder-alert.ts's module doc).
    log: (alert) => ({
      trace_id: 'saxo-weekly-reminder',
      stage: 'orchestrator',
      event: 'saxo_weekly_relogin_reminder',
      level: 'warn',
      message: `weekly Saxo ${alert.environment} re-login reminder due. ${LOG_ONLY_CANNOT_PAGE}`,
      payload: {
        environment: alert.environment,
        last_logged_in_at: alert.last_logged_in_at ?? null,
        reported_at: alert.reported_at.toISOString(),
      },
    }),
    text: (alert) =>
      `Samurai SAXO WEEKLY RE-LOGIN REMINDER (${alert.environment}): Saxo recommends logging in ` +
      'by hand at least once a week — run ' +
      `\`yarn saxo:login --env ${alert.environment}\` before Monday's open.\n` +
      (alert.last_logged_in_at === undefined
        ? 'The current saved session has no recorded manual login (predates this reminder, or ' +
          'none has been run yet).\n'
        : `The current session was last established by a manual login at ${alert.last_logged_in_at}.\n`) +
      `Sent ${alert.reported_at.toISOString()}.`,
  },
};

/**
 * The one cast on the alert path: a computed-key object literal types as an
 * index signature, which the compiler cannot relate to the port's named
 * method. alert-catalogue.test.ts drives every port through its real method
 * name against the catalogue's `method`, which is what makes the cast safe.
 */
function asPort<K extends AlertId>(
  method: string,
  post: (alert: unknown) => void | Promise<void>,
): AlertPort<K> {
  return { [method]: post } as unknown as AlertPort<K>;
}

/**
 * `SAMURAI_ALERTS=log-only`'s form of alert `id`: the catalogue's log line,
 * and nothing that reaches a phone. Fine for a supervised run, never for an
 * unattended soak (#238), which is why selecting it requires saying
 * `log-only` out loud (#322).
 */
export function loggingAlertChannel<K extends LoggedAlertId>(id: K, logger: Logger): AlertPort<K> {
  const spec: AnyAlertSpec = ALERT_CATALOGUE[id];
  const { log } = spec;
  if (log === undefined) {
    throw new Error(`alert '${id}' has no log-only form — see UNLOGGED_ALERT_IDS`);
  }
  const post =
    spec.delivery === 'awaited'
      ? async (alert: unknown) => {
          logger.log(log(alert));
        }
      : (alert: unknown) => {
          logger.log(log(alert));
        };
  return asPort(spec.method, post);
}

/**
 * `SAMURAI_ALERTS=telegram`'s form of alert `id`: the catalogue's text, over
 * the one shared `TelegramClient`, to `chatId`. One transport, deliberately
 * (#1154): the durable `alert_delivery_failures` count, not a fallback
 * transport, is what answers "is the channel down".
 */
export function tradeChannelAlert<K extends AlertId>(
  id: K,
  deps: { telegram: TelegramClient; chatId: string; logger: Logger },
): AlertPort<K> {
  const spec: AnyAlertSpec = ALERT_CATALOGUE[id];
  const send = (alert: unknown) => deps.telegram.sendMessage(deps.chatId, spec.text(alert));

  if (spec.delivery === 'awaited') {
    return asPort(spec.method, async (alert: unknown) => {
      if (spec.page?.(alert) === false) return;
      await send(alert);
    });
  }

  const { sendFailed } = spec;
  if (sendFailed === undefined) {
    throw new Error(`detached alert '${id}' has no sendFailed log line`);
  }
  return asPort(spec.method, (alert: unknown) => {
    void send(alert).catch((error: unknown) => {
      deps.logger.log(sendFailed(alert, error));
    });
  });
}
