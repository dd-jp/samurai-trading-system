/**
 * SQLite-backed durable record of a Telegram alert send that exhausted
 * retries (#1108) — see migration 0043 for why this is a dedicated table
 * rather than a row in `audit_log`.
 */

import type { SharedStore } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';

export interface AlertDeliveryFailure {
  chat_id: string;
  method: string;
  body: string;
  error: string;
  timestamp: Date;
}

export interface AlertDeliveryLog {
  recordFailure(entry: AlertDeliveryFailure): void;
  /** Total permanently-undeliverable alerts recorded — #1108's "count… answerable after the fact". */
  countFailures(): number;
  /** Most recent failures, newest first — the forensic detail behind the count. */
  getRecentFailures(limit: number): AlertDeliveryFailure[];
}

interface AlertDeliveryFailureRow {
  chat_id: string;
  method: string;
  body: string;
  error: string;
  timestamp: string;
}

export class SqliteAlertDeliveryLog implements AlertDeliveryLog {
  constructor(private readonly db: SharedStore) {}

  recordFailure(entry: AlertDeliveryFailure): void {
    this.db
      .prepare(
        `INSERT INTO alert_delivery_failures (chat_id, method, body, error, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.chat_id,
        entry.method,
        entry.body,
        entry.error,
        toStoredTimestamp(entry.timestamp),
      );
  }

  countFailures(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM alert_delivery_failures').get() as {
      n: number;
    };
    return row.n;
  }

  getRecentFailures(limit: number): AlertDeliveryFailure[] {
    const rows = this.db
      .prepare('SELECT * FROM alert_delivery_failures ORDER BY timestamp DESC, rowid DESC LIMIT ?')
      .all(limit) as AlertDeliveryFailureRow[];
    return rows.map((row) => ({ ...row, timestamp: fromStoredTimestamp(row.timestamp) }));
  }
}
