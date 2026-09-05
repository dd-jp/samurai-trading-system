/**
 * SQLite-backed durable record of a Telegram alert send that exhausted
 * retries (#1108) — see migration 0043 for why this is a dedicated table
 * rather than a row in `audit_log`.
 */

import { sanitizeLogText } from '../../shared/sanitize-log-text.js';
import type { SharedStore } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/sqlite-utils.js';

export interface AlertDeliveryFailure {
  chat_id: string;
  method: string;
  body: string;
  error: string;
  timestamp: Date;
}

export class SqliteAlertDeliveryLog {
  constructor(private readonly db: SharedStore) {}

  /**
   * `body`/`error` are attacker/upstream-influenced free text (an alert's
   * rendered content, a thrown error's message) reaching a durable table
   * outside `formatLogLine`'s central redaction (#1035) — masked here so a
   * misconfigured `baseUrl` that puts the bot token in a `TypeError`'s
   * message (see `classifyTelegramThrown`) cannot leave it on disk.
   *
   * `sanitizeLogText` (mask-then-cap), not a caller-side truncate before this
   * call: `sanitize-log-text.ts` is explicit that truncating before masking
   * can bisect a token mid-string and leave an unmasked remainder that no
   * longer matches the credential patterns — this method is the one place
   * both decisions happen, in the order that avoids that.
   */
  recordFailure(entry: AlertDeliveryFailure): void {
    this.db
      .prepare(
        `INSERT INTO alert_delivery_failures (chat_id, method, body, error, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.chat_id,
        entry.method,
        sanitizeLogText(entry.body),
        sanitizeLogText(entry.error),
        toStoredTimestamp(entry.timestamp),
      );
  }

  /**
   * Permanently-undeliverable alerts recorded FOR `chatId` as of `asOf`
   * — #1108's "count… answerable after the fact", scoped by the third
   * review pass's finding: `alert_delivery_failures` holds rows for every
   * chat a send targeted, heartbeat included (#342's isolation only stops a
   * heartbeat failure from advancing or triggering the escalation-chat
   * alert in `telegram-bot-api-client.ts` — it does not stop the row being
   * written here). An unfiltered `COUNT(*)` would answer "how many sends
   * failed anywhere", not "is the alert channel down", so `chatId` is a
   * required parameter rather than a default: the caller (the one place
   * that knows which chat IS the alert/escalation channel) must say so
   * explicitly, the same way `getMarks`/`getFillsForTrades` take their scope
   * as a parameter rather than this store inventing one.
   */
  countFailures(asOf: Date, chatId: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM alert_delivery_failures WHERE timestamp <= ? AND chat_id = ?',
      )
      .get(toStoredTimestamp(asOf), chatId) as { n: number };
    return row.n;
  }
}
