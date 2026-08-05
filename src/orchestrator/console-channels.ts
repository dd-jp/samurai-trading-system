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
import type { UnpricedFillAlert, UnpricedFillAlertChannel } from '../execution/index.js';
import type {
  BreachAlert,
  BreachAlertChannel,
  LoosenApprovalChannel,
  LoosenApprovalRequest,
} from '../feedback-loop/index.js';
import type { CiiScoreProvider } from '../market-intelligence/index.js';
import type { ApprovalChannel, ApprovalOutcome, ApprovalRequest } from '../verdict/index.js';
import type { HeartbeatChannel } from './heartbeat.js';
import type { OrphanAlertChannel, OrphanGoVerdict } from './orphan-verdict-scan.js';
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
 * A kill-threshold breach (#93), written to the log at `error`.
 *
 * `error`, for `LoggingOrphanAlertChannel`'s reason and more so: a breach
 * means the strategy's own validation says its edge may be gone — PBO over
 * its line, out-of-sample Sharpe under it, a statistically insignificant
 * Deflated Sharpe, or live performance diverging from the backtest that
 * justified the config. The Feedback Loop has already defensively tightened
 * every risk threshold by the time this fires; the kill/rework call is the
 * human's, and this is how the human hears about it.
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
      // The daily batch belongs to no single tick, so it uses the same
      // synthetic trace the feedback cycle already logs under.
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      level: 'error',
      message:
        'kill-threshold breach — risk thresholds auto-tightened; review the strategy and ' +
        'decide kill or rework (no automatic kill is ever applied)',
      payload: {
        breaches: alert.breaches,
        reported_at: alert.reported_at.toISOString(),
      },
    });
  }
}

/**
 * A gated risk-threshold LOOSENING, written to the log at `warn` (#366).
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
 * - `LoosenApprovalChannel.requestLoosenApproval` returns `void`. It is
 *   outbound-only by construction (feedback-loop/types.ts: "Fire-and-forget by
 *   design ... a loosening is queued into `loosen_pending_approval` and never
 *   applied by the cycle that proposed it"). There is no answer to fabricate,
 *   so this channel cannot approve anything even if it wanted to.
 *
 * **Which way it fails, explicitly: CLOSED.** A loosen request that reaches
 * nobody leaves the risk threshold exactly where it was. `runDailyCycle`
 * `continue`s past a gated move without writing the dial and without appending
 * to the `AdjustmentLog`, so the safety limit stands until a human changes it
 * out of band. The cost of no approver is a threshold that stays tight
 * forever, never one that quietly relaxes — and that is the correct direction
 * to fail in for the dial that bounds loss.
 *
 * The one path that *does* auto-apply a loosening is `mode: 'backtest'`
 * (`gate = isThreshold && mode !== 'backtest'`, daily-cycle.ts), which spends
 * no money and records the move as `proposal:backtest_auto_approved`. Paper
 * and live take the gated path — deliberately, per `DailyCycleInput.mode`.
 *
 * Same caveat as the other log-only stand-ins: a log line nobody tails is not
 * a notification. `TradeChannelLoosenApproval` (loosen-approval-channel.ts) is
 * the reachable-from-a-phone implementation, selected by
 * `SAMURAI_ALERTS=telegram` (#322/#366) — which an unattended soak (#238) sets.
 *
 * `warn`, not `error`: nothing is broken and no position is at risk. The
 * system asked a question and will keep running safely without an answer.
 */
export class LoggingLoosenApprovalChannel implements LoosenApprovalChannel {
  constructor(private readonly logger: Logger) {}

  requestLoosenApproval(request: LoosenApprovalRequest): void {
    this.logger.log({
      // The daily batch belongs to no single tick, so it shares the synthetic
      // trace the feedback cycle already logs under.
      trace_id: 'feedback-cycle',
      stage: 'feedback-loop',
      level: 'warn',
      message:
        'risk-threshold LOOSENING proposed and NOT applied — it needs a human, and no approval ' +
        'transport can deliver one back to this process. The threshold stays where it is until ' +
        'somebody changes it out of band (fail-closed, #366).',
      payload: {
        name: request.name,
        from: request.from,
        to: request.to,
        requested_at: request.requested_at.toISOString(),
        applied: false,
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
 * gate 6, acceptable exactly where the gate is protecting nothing real:
 * `paper` and `backtest` spend no money. In `live` it is never acceptable, so
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
