/**
 * Trade-channel adapter for the Feedback Loop's gated risk-threshold loosening
 * request (#91, wired by #366) — the same move `TradeChannelBreachAlert`,
 * `TradeChannelUnpricedFillAlert` and `TradeChannelHeartbeat` make: reuse
 * Verdict's already-provisioned Telegram/Discord transports rather than
 * introduce a second integration, and wrap the raw clients rather than route
 * through `TradeChannelNotifier.notify`, which is shaped for a
 * `VerdictDecision` and not for a threshold move.
 *
 * This is what makes the Feedback Loop's one human-facing question reachable
 * during an UNATTENDED soak (#238). `LoggingLoosenApprovalChannel`
 * (console-channels.ts) writes a line nobody is tailing; this one reaches a
 * phone.
 *
 * ## It notifies. It does not collect an answer — and that is fail-CLOSED
 *
 * Nothing in this repo polls Telegram for approvals: `alert-transport.ts`
 * builds the client but never calls `client.start()`, because `getUpdates` is
 * single-consumer per bot token. So this adapter is a one-way push, exactly
 * like the port it implements (`LoosenApprovalChannel.requestLoosenApproval`
 * returns `void` — see feedback-loop/types.ts, "Fire-and-forget by design").
 *
 * The safety consequence is the point of the ticket, so it is stated plainly:
 * **a loosening nobody answers is never applied.** `runDailyCycle` reports the
 * threshold in `loosen_pending_approval`, writes no dial, and appends no
 * `AdjustmentLog` entry; the limit stays where it is until a human moves it out
 * of band. A missing approver costs a threshold that stays too tight, never one
 * that quietly relaxes. The message below says so to the operator too, so that
 * a reply to the notification is not mistaken for consent the system will act
 * on.
 *
 * The one path that auto-applies a loosening is `mode: 'backtest'`
 * (daily-cycle.ts), which spends no money. Paper and live are gated.
 *
 * ## Why fire-and-forget, and what that costs
 *
 * Same shape as `TradeChannelBreachAlert`: the port is synchronous because
 * `runDailyCycle` is, so the send is started and not awaited, and its rejection
 * is caught here rather than left to surface as an unhandled rejection that
 * would take the process down mid-soak. A transport failure must not fail the
 * cycle that already correctly refused to apply the move.
 *
 * The catch is best-effort and silent to the caller, which is a real limitation
 * worth naming: if Telegram is down, the request reaches nobody. It fails in
 * the safe direction regardless — the threshold is unchanged either way — and
 * the failure is logged at `error` so the operator can see that a question was
 * asked and lost, rather than a retry queue this adapter does not have.
 */
import type {
  LoosenApprovalChannel,
  LoosenApprovalRequest,
} from '../../pipeline/feedback-loop/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import type { Logger } from './types.js';

/**
 * Composed only from the request's own fields, plus the one thing the operator
 * cannot infer from them: that nothing they send back will be read. A
 * notification that looks like an approval prompt, on a channel with no
 * listener, is how a "yes" gets typed into a void and believed.
 */
function formatLoosenRequest(request: LoosenApprovalRequest): string {
  return (
    `Samurai RISK-THRESHOLD LOOSENING proposed: ${request.name} ${request.from} -> ` +
    `${request.to}.\nRequested ${request.requested_at.toISOString()}.\n` +
    'NOT APPLIED, and it will not be: the daily cycle never relaxes its own safety limits, and ' +
    'nothing here reads replies. The threshold stays where it is until you change it yourself.'
  );
}

export class TradeChannelLoosenApproval implements LoosenApprovalChannel {
  readonly #telegram: TelegramClient;
  readonly #telegramChatId: string;
  readonly #discord: DiscordClient | undefined;
  readonly #discordChannelId: string | undefined;
  readonly #logger: Logger;

  /**
   * `logger` is REQUIRED and sits ahead of the optional Discord pair for
   * `TradeChannelBreachAlert`'s reason: the only alternative to logging a
   * failed send is silence, and a question the system asked and lost is
   * something the operator has to be able to find afterwards.
   */
  constructor(
    telegram: TelegramClient,
    telegramChatId: string,
    logger: Logger,
    discord?: DiscordClient,
    discordChannelId?: string,
  ) {
    this.#telegram = telegram;
    this.#telegramChatId = telegramChatId;
    this.#logger = logger;
    this.#discord = discord;
    this.#discordChannelId = discordChannelId;
  }

  requestLoosenApproval(request: LoosenApprovalRequest): void {
    const text = formatLoosenRequest(request);
    // Both attempted together, mirroring the breach alert's shape, so a
    // Telegram outage does not silence the Discord copy.
    void Promise.allSettled([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === 0) {
        return;
      }
      this.#logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        // `error` for the delivery failure even though the `warn` below would
        // match the request's own severity: the request itself is routine, but
        // a push that silently failed means the operator does not know a
        // decision is waiting on them.
        level: 'error',
        message:
          'risk-threshold loosening request failed to send — the threshold was NOT loosened ' +
          '(fail-closed) and nobody was asked',
        payload: {
          name: request.name,
          from: request.from,
          to: request.to,
          requested_at: request.requested_at.toISOString(),
          applied: false,
          failures: failed.length,
        },
      });
    });
  }
}
