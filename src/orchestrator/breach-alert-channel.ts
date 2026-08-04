/**
 * Trade-channel adapter for the Feedback Loop's kill-threshold breach alert
 * (#93, wired by #327) — the same move `TradeChannelUnpricedFillAlert` and
 * `TradeChannelHeartbeat` make: reuse Verdict's already-provisioned
 * Telegram/Discord transports rather than introduce a second integration, and
 * wrap the raw clients rather than route through `TradeChannelNotifier.notify`,
 * which is shaped for a `VerdictDecision` and not for a validation breach.
 *
 * This is what makes story 13's "alert the human" reachable during an
 * UNATTENDED soak (#238). `LoggingBreachAlertChannel` writes a line nobody is
 * tailing; this one reaches a phone.
 *
 * ## Why this one is fire-and-forget
 *
 * `BreachAlertChannel.postBreachAlert` returns `void`, not a promise — the
 * port is synchronous because `computeMetrics` is, and its own doc calls the
 * alert "fire-and-forget" (a breach expects no answer; the kill/rework call is
 * made later, out of band). So the send is started and not awaited, and its
 * rejection is caught here rather than left to surface as an unhandled
 * rejection that would take the process down mid-soak. A transport failure
 * must not undo the auto-tighten that already happened.
 *
 * The catch is deliberately best-effort and silent-to-the-caller, which is a
 * real limitation worth naming: if Telegram is down, the breach reaches
 * nobody. The mitigation is the log-line copy the orchestrator writes for
 * every cycle regardless (`daily metrics computed`), not a retry queue this
 * adapter does not have.
 */
import type { BreachAlert, BreachAlertChannel } from '../feedback-loop/index.js';
import type { DiscordClient, TelegramClient } from '../verdict/index.js';
import type { Logger } from './types.js';

/**
 * Composed only from the alert's own fields. Deliberately does NOT include the
 * metrics suite: `MetricsSuite` is ten floats whose meaning needs the report
 * beside it, and a push notification's job here is to get a human to go look.
 */
function formatBreachAlert(alert: BreachAlert): string {
  return (
    `Samurai KILL-THRESHOLD BREACH (${alert.breaches.length}): ${alert.breaches.join(', ')}.\n` +
    `Detected ${alert.reported_at.toISOString()}.\n` +
    'Every risk threshold has been defensively auto-tightened. No kill has been applied and ' +
    'none will be — kill or rework is your decision. Review the strategy before the next ' +
    'session.'
  );
}

export class TradeChannelBreachAlert implements BreachAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #telegramChatId: string;
  readonly #discord: DiscordClient | undefined;
  readonly #discordChannelId: string | undefined;
  readonly #logger: Logger | undefined;

  constructor(
    telegram: TelegramClient,
    telegramChatId: string,
    discord?: DiscordClient,
    discordChannelId?: string,
    logger?: Logger,
  ) {
    this.#telegram = telegram;
    this.#telegramChatId = telegramChatId;
    this.#discord = discord;
    this.#discordChannelId = discordChannelId;
    this.#logger = logger;
  }

  postBreachAlert(alert: BreachAlert): void {
    const text = formatBreachAlert(alert);
    // Both attempted together, mirroring the heartbeat's shape, so a Telegram
    // outage does not silence the Discord copy.
    void Promise.allSettled([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === 0 || this.#logger === undefined) {
        return;
      }
      // A breach that could not be delivered is itself an operator-visible
      // event — otherwise the one alert that matters most fails silently.
      this.#logger.log({
        trace_id: 'feedback-cycle',
        stage: 'feedback-loop',
        level: 'error',
        message: 'kill-threshold breach alert failed to send — the breach still stands',
        payload: {
          breaches: alert.breaches,
          reported_at: alert.reported_at.toISOString(),
          failures: failed.length,
        },
      });
    });
  }
}
