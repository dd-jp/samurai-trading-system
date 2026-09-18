import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { Adjustment, AdjustmentLog, PendingApprovalAdjustment } from './types.js';

type DialType = 'analyst_weight' | 'strategy_param' | 'risk_threshold';
type Direction = 'tighten' | 'loosen';

interface DialAdjustmentRow {
  dial_type: DialType;
  dial_name: string;
  from_value: number;
  to_value: number;
  direction: Direction;
  reason: string;
  created_at: string;
}

function cycleDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export class SqliteAdjustmentLog implements AdjustmentLog {
  constructor(private readonly db: StoreHandle) {}

  append(entry: Adjustment): void {
    this.db
      .prepare(
        `INSERT INTO dial_adjustments (
           dial_type, dial_name, from_value, to_value, direction, status, cycle_date, created_at, reason
         ) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?)`,
      )
      .run(
        entry.dial,
        entry.name,
        entry.from,
        entry.to,
        entry.direction,
        cycleDateOf(entry.applied_at),
        toStoredTimestamp(entry.applied_at),
        entry.reason,
      );
  }

  getEntries(): readonly Adjustment[] {
    const rows = this.db
      .prepare(
        `SELECT dial_type, dial_name, from_value, to_value, direction, created_at, reason
           FROM dial_adjustments
          WHERE status = 'applied'
          ORDER BY id`,
      )
      .all() as DialAdjustmentRow[];

    return rows.map((row) => ({
      dial: row.dial_type,
      name: row.dial_name,
      from: row.from_value,
      to: row.to_value,
      direction: row.direction,
      applied_at: fromStoredTimestamp(row.created_at),
      reason: row.reason,
    }));
  }

  recordPendingApproval(entry: PendingApprovalAdjustment): number {
    const info = this.db
      .prepare(
        `INSERT INTO dial_adjustments (
           dial_type, dial_name, from_value, to_value, direction, status, cycle_date, created_at, reason
         ) VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?)`,
      )
      .run(
        entry.dial,
        entry.name,
        entry.from,
        entry.to,
        entry.direction,
        cycleDateOf(entry.requested_at),
        toStoredTimestamp(entry.requested_at),
        entry.reason,
      );
    return Number(info.lastInsertRowid);
  }

  resolvePendingApproval(id: number, outcome: 'approved' | 'rejected'): void {
    const status = outcome === 'approved' ? 'applied' : 'rejected';
    const result = this.db
      .prepare(
        `UPDATE dial_adjustments SET status = ? WHERE id = ? AND status = 'pending_approval'`,
      )
      .run(status, id);

    if (result.changes === 0) {
      throw new Error(
        `SqliteAdjustmentLog.resolvePendingApproval: no pending adjustment with id '${id}' — ` +
          'either it was never recorded or has already been resolved.',
      );
    }
  }
}
