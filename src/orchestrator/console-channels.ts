/**
 * Log-only stand-ins for the three human-facing transports, so a smoke run
 * can start before a real `TelegramClient` exists (#275).
 *
 * These are stand-ins, not implementations. #275 stays open: a real channel
 * means long-polling `getUpdates`, an allowlisted `callback_query.from.id`,
 * and the HMAC round-trip through `SignedApprovalChannel` — none of which is
 * approximated here. What these give is an operator watching the log stream
 * instead of a phone, which is enough to observe a BTC-USD paper tick end to
 * end and nothing more.
 *
 * Two of the three are uncontroversial: a heartbeat and an orphan alert are
 * pure outbound notifications, and writing them to the log loses reachability
 * (nobody is paged) but changes no decision. The approval channel is
 * different, and is treated differently below.
 */
import type { UnpricedFillAlert, UnpricedFillAlertChannel } from '../execution/index.js';
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
 * supervised smoke run, not a substitute for #275 before an unattended soak
 * (#238).
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
 * not an alert. This is the production DEFAULT only because `TelegramClient`
 * has no composition-root wiring yet (#275); `TradeChannelUnpricedFillAlert`
 * (unpriced-fill-channel.ts) is the reachable-from-a-phone implementation, and
 * an unattended soak (#238) should inject it.
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
