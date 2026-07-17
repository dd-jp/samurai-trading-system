/**
 * Trade-channel adapter for the heartbeat (#96) — see
 * docs/specs/orchestrator-spec.md (Module: Heartbeat): "reuses Verdict's
 * already-provisioned Telegram/Discord trade channel (verdict-spec story
 * 14) — a different message type on the same channel, not a new
 * integration." Wraps the same `TelegramClient`/`DiscordClient` transports
 * verdict/notifications' `TelegramChannel`/`DiscordChannel` use, rather than
 * routing through `TradeChannelNotifier.notify` (which is shaped for a
 * `VerdictDecision`, not a liveness ping).
 */
import type { DiscordClient, TelegramClient } from '../verdict/notifications/types.js';
import type { HeartbeatChannel } from './heartbeat.js';

function formatHeartbeat(timestamp: Date): string {
  return `Samurai heartbeat: alive at ${timestamp.toISOString()}`;
}

export class TradeChannelHeartbeat implements HeartbeatChannel {
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

  async postHeartbeat(timestamp: Date): Promise<void> {
    const text = formatHeartbeat(timestamp);
    await Promise.all([
      this.#telegram.sendMessage(this.#telegramChatId, text),
      this.#discord && this.#discordChannelId
        ? this.#discord.sendMessage(this.#discordChannelId, text)
        : Promise.resolve(),
    ]);
  }
}
