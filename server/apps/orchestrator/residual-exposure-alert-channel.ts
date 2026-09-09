/**
 * Trade-channel adapter for the residual-exposure re-arm-failure alert (#525)
 * — the same move `TradeChannelUnpricedFillAlert` makes (unpriced-fill-
 * channel.ts): reuse Verdict's already-provisioned Telegram
 * transport rather than introduce a second integration, and wrap the raw
 * clients rather than route through `TradeChannelNotifier.notify`, which is
 * shaped for a `VerdictDecision` and not for an operational anomaly.
 *
 * This is the implementation that makes #525's fallback alert reachable
 * during an UNATTENDED soak (#238) — the exact gap #551 closes:
 * `LoggingResidualExposureAlertChannel` writes a line nobody is tailing at
 * 3am, whereas this one reaches a phone. `SAMURAI_ALERTS=telegram` builds it
 * over a `TelegramBotApiClient` at the entrypoint (alert-transport.ts), and
 * posts to the ESCALATION chat, never the heartbeat chat (#342) — an
 * unprotected position sitting at the venue is a decision waiting on the
 * operator, not a beat.
 *
 * Discord is optional and mirrors the shape every other adapter here takes:
 * both are attempted together, so a Telegram outage does not silence the
 * Discord copy.
 */
import type {
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from '../../pipeline/execution/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';

/**
 * Composed only from the alert's own curated fields — no broker error, no
 * response body. See `ResidualExposureAlert`'s CREDENTIALS note for why that
 * boundary is hard: the underlying failure reason is for the logger, not
 * this channel.
 */
function formatResidualExposureAlert(alert: ResidualExposureAlert): string {
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
}

export class TradeChannelResidualExposureAlert implements ResidualExposureAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #telegramChatId: string;
  readonly #discord: DiscordClient | undefined;
  readonly #discordChannelId: string | undefined;

  constructor(
    telegram: TelegramClient,
    telegramChatId: string,
    discord?: DiscordClient,
    discordChannelId?: string,
  ) {
    this.#telegram = telegram;
    this.#telegramChatId = telegramChatId;
    this.#discord = discord;
    this.#discordChannelId = discordChannelId;
  }

  async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
    const text = formatResidualExposureAlert(alert);
    await Promise.all([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]);
  }
}
