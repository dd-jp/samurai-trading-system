/**
 * Trade-channel adapter for the unpriced-fill age-out alert (#298) — the same
 * move `TradeChannelHeartbeat` makes for the heartbeat (heartbeat-channel.ts):
 * reuse Verdict's already-provisioned Telegram/Discord transports rather than
 * introduce a second integration, and wrap the raw clients rather than route
 * through `TradeChannelNotifier.notify`, which is shaped for a
 * `VerdictDecision` and not for an operational anomaly.
 *
 * This is the implementation that makes #298's acceptance criterion reachable
 * during an UNATTENDED soak (#238): `LoggingUnpricedFillAlertChannel` writes a
 * line nobody is tailing at 3am, whereas this one reaches a phone. Since #322
 * it is wired for real — `SAMURAI_ALERTS=telegram` builds it over a
 * `TelegramBotApiClient` at the entrypoint (alert-transport.ts).
 *
 * Discord is optional and mirrors the heartbeat's shape: both are attempted
 * together, so a Telegram outage does not silence the Discord copy.
 */
import type {
  UnpricedFillAlert,
  UnpricedFillAlertChannel,
} from '../../pipeline/execution/index.js';
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';

/**
 * Composed only from the alert's own curated fields — no broker error, no
 * response body. See `UnpricedFillAlert`'s doc for why that boundary is hard.
 */
function formatUnpricedFillAlert(alert: UnpricedFillAlert): string {
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
}

export class TradeChannelUnpricedFillAlert implements UnpricedFillAlertChannel {
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

  async postUnpricedFillAlert(alert: UnpricedFillAlert): Promise<void> {
    const text = formatUnpricedFillAlert(alert);
    await Promise.all([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]);
  }
}
