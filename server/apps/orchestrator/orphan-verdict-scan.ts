
import { describeThrownSafely } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp } from '../../shared/store/index.js';
import type { Logger } from './types.js';

export interface OrphanGoVerdict {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  verdict_timestamp: Date;
}

export interface OrphanAlertChannel {
  postOrphanAlert(orphan: OrphanGoVerdict): Promise<void>;
}

interface OrphanRow {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  timestamp: string;
}

export class OrphanVerdictScanner {
  async scan(
    db: StoreHandle,
    channel: OrphanAlertChannel,
    logger: Logger,
  ): Promise<OrphanGoVerdict[]> {
    const rows = db
      .prepare(
        `SELECT trace_id, idempotency_key, instrument, timestamp
           FROM verdict_log
          WHERE status = 'go'
            AND NOT EXISTS (
              SELECT 1 FROM audit_log
               WHERE audit_log.trace_id = verdict_log.trace_id
                 AND audit_log.stage = 'execution'
            )
          ORDER BY timestamp, trace_id`,
      )
      .all() as OrphanRow[];

    const orphans: OrphanGoVerdict[] = rows.map((row) => ({
      trace_id: row.trace_id,
      idempotency_key: row.idempotency_key,
      instrument: row.instrument,
      verdict_timestamp: fromStoredTimestamp(row.timestamp),
    }));

    for (const orphan of orphans) {
      try {
        await channel.postOrphanAlert(orphan);
      } catch (error) {
        logger.log({
          trace_id: orphan.trace_id,
          stage: 'orphan-verdict-scan',
          event: 'orphan_verdict_alert_failed',
          level: 'error',
          message: 'orphan go-verdict alert failed',
          payload: { error: describeThrownSafely(error) },
        });
      }
    }

    return orphans;
  }
}
