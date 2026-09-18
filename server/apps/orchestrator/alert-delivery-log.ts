import { sanitizeLogText } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

export interface AlertDeliveryFailure {
  chat_id: string;
  method: string;
  body: string;
  error: string;
  timestamp: Date;
}

export const ALERT_DELIVERY_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS = 30;

export class SqliteAlertDeliveryLog {
  constructor(private readonly db: StoreHandle) {}

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

  countFailures(asOf: Date, chatId: string): number {
    const windowStart = new Date(asOf.getTime() - ALERT_DELIVERY_FAILURE_WINDOW_MS);
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM alert_delivery_failures ' +
          'WHERE timestamp > ? AND timestamp <= ? AND chat_id = ?',
      )
      .get(toStoredTimestamp(windowStart), toStoredTimestamp(asOf), chatId) as { n: number };
    return row.n;
  }

  pruneOlderThan(cutoff: Date): number {
    return this.db
      .prepare('DELETE FROM alert_delivery_failures WHERE timestamp < ?')
      .run(toStoredTimestamp(cutoff)).changes;
  }
}
