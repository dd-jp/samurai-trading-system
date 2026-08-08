/**
 * Trade-channel adapter for the flatten-reconcile-unresolved alert (#519) —
 * the same move `TradeChannelResidualExposureAlert` makes
 * (residual-exposure-alert-channel.ts): reuse Verdict's already-provisioned
 * Telegram/Discord transports rather than introduce a second integration,
 * and wrap the raw clients rather than route through
 * `TradeChannelNotifier.notify`, which is shaped for a `VerdictDecision` and
 * not for an operational anomaly.
 *
 * This is the implementation that makes #519's escalation reachable during
 * an UNATTENDED soak (#238): `LoggingFlattenReconcileAlertChannel` writes a
 * line nobody is tailing at 3am, whereas this one reaches a phone.
 * `SAMURAI_ALERTS=telegram` builds it over a `TelegramBotApiClient` at the
 * entrypoint (alert-transport.ts), and posts to the ESCALATION chat, never
 * the heartbeat chat (#342) — a flatten stuck in genuine ambiguity about
 * whether it is still held is a decision waiting on the operator, not a beat.
 *
 * Discord is optional and mirrors the shape every other adapter here takes:
 * both are attempted together, so a Telegram outage does not silence the
 * Discord copy.
 */
import type { FlattenReconcileAlert, FlattenReconcileAlertChannel } from '../execution/index.js';
import type { DiscordClient, TelegramClient } from '../verdict/index.js';

/**
 * Composed only from the alert's own curated fields — see
 * `FlattenReconcileAlert`'s CREDENTIALS note for why that boundary is hard.
 */
function formatFlattenReconcileAlert(alert: FlattenReconcileAlert): string {
  return (
    `Samurai UNRESOLVED FLATTEN: ${alert.instrument} (flatten ${alert.idempotency_key}) could ` +
    `not be settled against the venue as of ${alert.observed_at.toISOString()}.\n` +
    `${alert.reason}\n` +
    'Whether this position is still held is genuinely unknown. Check the order and the position ' +
    'on the venue by hand.'
  );
}

export class TradeChannelFlattenReconcileAlert implements FlattenReconcileAlertChannel {
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

  async postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void> {
    const text = formatFlattenReconcileAlert(alert);
    await Promise.all([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]);
  }
}
