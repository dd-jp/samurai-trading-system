/**
 * The send half every `TradeChannel*` operator-escalation adapter shares: one
 * Telegram client, one chat id, text the subclass composes from the alert's
 * own curated fields (never a venue error or response body — see each alert
 * type's CREDENTIALS note). `alert-transport.ts` builds every adapter over
 * the ESCALATION chat; the heartbeat alone goes to its own chat (#342), and
 * the caller chooses which by what it passes here.
 *
 * One transport, deliberately (#1154): the durable `alert_delivery_failures`
 * count, not a fallback transport, is what answers "is the channel down"
 * (telegram-bot-api-client.ts), so a second client here would be a seam
 * nothing calls.
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';

export abstract class TradeChannelAlert {
  readonly #telegram: TelegramClient;
  readonly #chatId: string;

  constructor(telegram: TelegramClient, chatId: string) {
    this.#telegram = telegram;
    this.#chatId = chatId;
  }

  /** Rejects on a failed post — for the ports whose caller owns the failure. */
  protected send(text: string): Promise<void> {
    return this.#telegram.sendMessage(this.#chatId, text);
  }

  /**
   * Fire-and-forget, for the `void`-returning ports. `onFailure` is the
   * subclass's own log line: an escalation that failed to send must itself
   * stay visible in the log stream, and only the subclass knows which facts
   * of the alert the operator needs in it.
   */
  protected sendDetached(text: string, onFailure: (error: unknown) => void): void {
    void this.send(text).catch(onFailure);
  }
}
