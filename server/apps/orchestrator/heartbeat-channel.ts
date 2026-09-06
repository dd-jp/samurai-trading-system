/**
 * Trade-channel adapter for the heartbeat (#96) — see
 * docs/specs/orchestrator-spec.md (Module: Heartbeat): "reuses Verdict's
 * already-provisioned Telegram/Discord transport (verdict-spec story 14) — a
 * different message type over the same client, not a new integration." Wraps
 * a `TelegramClient`/`DiscordClient` transport directly — the same
 * `TelegramClient` verdict/notifications' `TelegramChannel` wraps — rather
 * than routing through `TradeChannelNotifier.notify` (which is shaped for a
 * `VerdictDecision`, not a liveness ping).
 *
 * The same client, but **not the same chat** (#342): the composition root
 * hands this adapter `TELEGRAM_HEARTBEAT_CHAT_ID`, never the escalation chat
 * the orphan/unpriced-fill/breach adapters are given. A liveness ping
 * repeating forever alongside the escalations is what gets the escalations
 * muted. The chat id is a constructor argument precisely so that decision
 * stays at the composition root; see alert-transport.ts.
 */
import type { DiscordClient, TelegramClient } from '../../pipeline/verdict/index.js';
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
