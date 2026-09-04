/**
 * Trade-channel adapter for the tick-skip escalation (#1084) — the
 * eighteenth outbound operator escalation.
 *
 * Same shape as `TradeChannelAnalystSkipAlert` / `TradeChannelMiCoverageAlert`:
 * wrap the already-provisioned Telegram client and post to the ESCALATION
 * chat, never the heartbeat chat (#342) — a pass that dropped at least half
 * the universe is a decision waiting on the operator (is the concurrency cap
 * sized right? is one instrument's debate hanging?), not a beat.
 *
 * What it replaces on that path is `LoggingTickSkipAlertChannel`
 * (console-channels.ts), which writes the same facts to the log at `warn` —
 * fine for a supervised run, but not reachable from a phone. See
 * `tick-skip-alert.ts`'s file doc for the real-world measurement that shows
 * why that gap is not enough for an unattended run.
 *
 * A failed post rejects rather than being swallowed; `reportTickSkip`
 * (production/tick-skip-alert.ts) catches and logs it, so the tick still
 * proceeds and the undelivered alert is on the record.
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import type { TickSkipAlert, TickSkipAlertChannel } from './production/tick-skip-alert.js';

/**
 * Names how many instruments were dropped, out of how many, and which ones —
 * the operator's first question is "how bad", answered by the fraction, and
 * "why", which starts with knowing which names are stuck.
 */
export function formatTickSkipAlert(alert: TickSkipAlert): string {
  const names = alert.skipped_instruments.join(', ');
  return (
    `Samurai TICK PASS DEGRADED: ${alert.skipped} of ${alert.planned} planned instrument(s) ` +
    `skipped this tick — still running from a previous pass.\n` +
    `Consecutive degraded tick(s): ${alert.consecutive_ticks}.\n` +
    `Skipped: ${names || '(none named)'}\n` +
    `As of ${alert.reported_at.toISOString()}.\n` +
    'The skip mechanism itself is unchanged (#669, #692) — this is an escalation, not a new ' +
    'behaviour. Check whether one instrument is hung or the concurrency cap needs revisiting.'
  );
}

export class TradeChannelTickSkipAlert implements TickSkipAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #telegramChatId: string;

  constructor(telegram: TelegramClient, telegramChatId: string) {
    this.#telegram = telegram;
    this.#telegramChatId = telegramChatId;
  }

  async postTickSkipAlert(alert: TickSkipAlert): Promise<void> {
    await this.#telegram.sendMessage(this.#telegramChatId, formatTickSkipAlert(alert));
  }
}
