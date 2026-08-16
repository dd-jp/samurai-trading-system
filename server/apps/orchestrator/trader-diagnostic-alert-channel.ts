/**
 * Trade-channel adapter for a Trader diagnostic (#698) — the eleventh outbound
 * operator escalation.
 *
 * Same shape as `TradeChannelAnalystSkipAlert`: wrap the already-provisioned
 * Telegram client rather than introduce a second integration, and post to the
 * ESCALATION chat, never the heartbeat chat (#342). A Trader that has stopped
 * being able to trust its calendar is a decision waiting on the operator, not a
 * beat.
 *
 * What it replaces on that path is `LoggingTraderDiagnosticAlertChannel`
 * (console-channels.ts), which writes the same facts to the log at `error` —
 * fine for a supervised run, and not an alert at all at 3am on day 9 of a
 * fourteen-day soak.
 *
 * A failed post rejects rather than being swallowed; `buildTraderStep` catches
 * and logs it, so the tick still returns its decision and the undelivered alert
 * is on the record.
 */
import type { TelegramClient } from '../../pipeline/verdict/index.js';
import type {
  TraderDiagnosticAlert,
  TraderDiagnosticAlertChannel,
} from './production/trader-diagnostic-alert.js';

/**
 * What each kind means in one line, and what it costs while it persists.
 *
 * Spelled out per kind rather than left to the `detail` string because the
 * operator's first question is "do I have to do something about this tonight",
 * and the answer differs sharply: a stale calendar means the book is parked and
 * nothing will trade until it is fixed, while a non-finite ATR means one
 * instrument is skipping on bad data while the rest of the run continues.
 */
const CONSEQUENCE: Record<TraderDiagnosticAlert['diagnostic']['kind'], string> = {
  session_end_in_past:
    'The calendar resolved a close that has already passed, so the book is being parked FLAT ' +
    'and no new position will be opened for this leg while that persists. A run in this state ' +
    'looks identical to a quiet market.',
  session_end_absent_on_non_crypto:
    'A non-crypto calendar returned no session end at all, so flat-by-close (ADR-0014) cannot ' +
    'be enforced for this leg — a position opened on it may be carried overnight.',
  atr_not_finite:
    'ATR was not finite on a FULL bar window, which means corrupt market data rather than a ' +
    'warm-up gap. This instrument cannot price a stop and is skipping every tick.',
};

function formatTraderDiagnosticAlert(alert: TraderDiagnosticAlert): string {
  const { diagnostic } = alert;
  return (
    `Samurai TRADER DEGRADED: ${alert.instrument} (${diagnostic.asset_class}) reported ` +
    `${diagnostic.kind} on ${alert.consecutive_ticks} consecutive tick(s) as of ` +
    `${alert.reported_at.toISOString()}.\n` +
    `${CONSEQUENCE[diagnostic.kind]}\n` +
    `Detail: ${diagnostic.detail}\n` +
    'The Trader is still running and still returning decisions, so this will not show up as ' +
    'downtime and the heartbeat will keep beating.'
  );
}

export class TradeChannelTraderDiagnosticAlert implements TraderDiagnosticAlertChannel {
  readonly #telegram: TelegramClient;
  readonly #chatId: string;

  constructor(telegram: TelegramClient, chatId: string) {
    this.#telegram = telegram;
    this.#chatId = chatId;
  }

  async postTraderDiagnosticAlert(alert: TraderDiagnosticAlert): Promise<void> {
    await this.#telegram.sendMessage(this.#chatId, formatTraderDiagnosticAlert(alert));
  }
}
