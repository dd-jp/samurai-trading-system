/**
 * SQLite-backed durable record of a Telegram alert send that exhausted
 * retries (#1108) — see migration 0043 for why this is a dedicated table
 * rather than a row in `audit_log`.
 */

import { maskCredentials } from '../../shared/sanitize-log-text.js';
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
        maskCredentials(entry.body),
        maskCredentials(entry.error),
        toStoredTimestamp(entry.timestamp),
      );
  }

  /** Total permanently-undeliverable alerts recorded as of `asOf` — #1108's "count… answerable after the fact". */
  countFailures(asOf: Date): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM alert_delivery_failures WHERE timestamp <= ?')
      .get(toStoredTimestamp(asOf)) as { n: number };
    return row.n;
  }
}
