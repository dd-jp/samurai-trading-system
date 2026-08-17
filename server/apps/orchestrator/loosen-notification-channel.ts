/**
 * Trade-channel adapter for the Feedback Loop's APPLIED risk-threshold
 * loosening notice (#91, wired by #366, retargeted by #736) — the same move
 * `TradeChannelBreachAlert`, `TradeChannelUnpricedFillAlert` and
 * `TradeChannelHeartbeat` make: reuse Verdict's already-provisioned
 * Telegram/Discord transports rather than introduce a second integration, and
 * wrap the raw clients rather than route through `TradeChannelNotifier.notify`,
 * which is shaped for a `VerdictDecision` and not for a threshold move.
 *
 * This is what makes a self-moved safety limit visible during an UNATTENDED
 * soak (#238). `LoggingLoosenNotificationChannel` (console-channels.ts) writes
 * a line nobody is tailing; this one reaches a phone.
 *
 * ## It reports. It never asked, and it is not a gate
 *
 * This adapter used to be `TradeChannelLoosenApproval`, pushing a question
 * nobody could answer: nothing in this repo polls Telegram for replies
 * (`alert-transport.ts` builds the client but never calls `client.start()`,
 * because `getUpdates` is single-consumer per bot token), so the "approval" it
 * requested could never arrive and the threshold never moved.
 * [ADR-0013](../../../docs/adr/0013-no-human-gate-anywhere.md) Decision 2
 * removed that gate — "a queue that nobody drains is not a control — it is a
 * permanently-stuck dial that reads as governed" — and #736 implemented the
 * removal. The message below is therefore past tense and carries no call to
 * action the system is waiting on.
 *
 * **What still bounds the move is not this channel.** A loosening is capped at
 * one `max_step`, clamped to the dial's `[floor, ceiling]`, and — for a
 * guarded threshold — REFUSED outright by the in-code clamp
 * (`server/shared/threshold-bounds.ts`, #638) before any notice is composed. By
 * the time this adapter runs, the dial has already moved and the
 * `AdjustmentLog` row that makes it reversible has already been written.
 *
 * ## Why fire-and-forget, and what that costs
 *
 * Same shape as `TradeChannelBreachAlert`: the port is synchronous because
 * `runDailyCycle` is, so the send is started and not awaited, and its rejection
 * is caught here rather than left to surface as an unhandled rejection that
 * would take the process down mid-soak. A transport failure must not fail the
 * cycle, and — unlike the old approval push — it cannot fail safe either: the
 * threshold has already widened. So the failure log below says exactly that,
 * at `error`, because an applied relaxation the operator was never told about
 * is the one outcome nobody can reconstruct from the absence of a message.
 * There is no retry queue here; the `dial_adjustments` row is the durable
 * record.
 */
import type {
  LoosenAppliedNotice,
  LoosenNotificationChannel,
} from '../../pipeline/feedback-loop/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
import type { Logger } from './types.js';

/**
 * Composed only from the notice's own fields, plus the one thing the operator
 * cannot infer from them: that this already happened and nothing is waiting on
 * them. The previous version told them a reply would not be read, which was
 * true and useless; what they need now is that a safety limit moved without
 * being asked, and where to look to undo it.
 */
function formatLoosenNotice(notice: LoosenAppliedNotice): string {
  return (
    `Samurai RISK-THRESHOLD LOOSENED: ${notice.name} ${notice.from} -> ${notice.to}.\n` +
    `Applied ${notice.applied_at.toISOString()} — already in force.\n` +
    'This is a notification, not a request: the Feedback Loop applies its own bounded dial moves ' +
    '(ADR-0013). The move was capped at one step, clamped to the dial bounds, and logged to ' +
    'dial_adjustments, which is what you reverse it from. No reply is read here.'
  );
}

export class TradeChannelLoosenNotice implements LoosenNotificationChannel {
  readonly #telegram: TelegramClient;
  readonly #telegramChatId: string;
  readonly #discord: DiscordClient | undefined;
  readonly #discordChannelId: string | undefined;
  readonly #logger: Logger;

  /**
   * `logger` is REQUIRED and sits ahead of the optional Discord pair for
   * `TradeChannelBreachAlert`'s reason: the only alternative to logging a
   * failed send is silence, and a limit the system widened by itself and told
   * nobody about is something the operator has to be able to find afterwards.
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

  notifyLoosenApplied(notice: LoosenAppliedNotice): void {
    const text = formatLoosenNotice(notice);
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
        // `error`, and more clearly so than before #736: the move is already
        // in force, so a lost notice means the operator's picture of the risk
        // limits is wrong until they read the adjustment log.
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
          failures: failed.length,
        },
      });
    });
  }
}
