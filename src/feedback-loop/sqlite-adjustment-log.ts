/**
 * SQLite-backed `AdjustmentLog` over `dial_adjustments` (#193) — the real
 * store behind `InMemoryAdjustmentLog` (#91). See
 * docs/specs/shared-sqlite-store-spec.md ("Feedback Loop" schema section)
 * and docs/specs/feedback-loop-spec.md ("Module: Guardrailed Tuning").
 *
 * Two capabilities beyond the `AdjustmentLog` port `runDailyCycle` consumes
 * (`append`, always an already-applied move — `record()` in daily-cycle.ts
 * never writes a pending row):
 *
 * - `getEntries()` — a read-back convenience mirroring
 *   `InMemoryAdjustmentLog`'s, so test harnesses can swap fixtures for the
 *   real store with no other change. Returns only `status = 'applied'`
 *   rows: a pending/rejected row is not a resolved `Adjustment` (it never
 *   took effect on the dial), and a reverted one no longer holds.
 * - `recordPendingApproval`/`resolvePendingApproval` — the
 *   pending-approval-mutated-in-place lifecycle the `dial_adjustments`
 *   schema exists to support (its own comment: "pending_approval rows are
 *   mutated in place on approval/rejection — the one exception to
 *   append-only"). No current caller drives this: `runDailyCycle` queues a
 *   gated loosening into `result.loosen_pending_approval` and
 *   `LoosenApprovalChannel.requestLoosenApproval`, not into this log
 *   (feedback-loop-spec.md names "acting on the human's answer" as a later
 *   cycle's job or a later ticket's). These two methods are the store-level
 *   capability that later ticket will call — deliberately not on the
 *   `AdjustmentLog` port itself, since widening a port for a caller that
 *   doesn't exist yet would be exactly the kind of invented business logic
 *   `SqliteConfigTrialLog`'s module doc warns against.
 *
 * `cycle_date` has no equivalent field on `Adjustment`/`PendingApprovalAdjustment`
 * (another documented port/schema gap, `SqliteConfigTrialLog`'s `config_json`
 * pattern): derived as the UTC calendar date of `applied_at`/`requested_at`.
 *
 * `reason` was missing from the original `dial_adjustments` schema (#193) —
 * `Adjustment.reason` has no column to round-trip through without it.
 * Added by migration `0002_dial_adjustments_reason.sql`.
 */

import type { SharedStore } from '../shared/store/index.js';
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
  constructor(private readonly db: SharedStore) {}

  /** Always a new row, status 'applied' — this port method never queues an approval. */
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
        entry.applied_at.toISOString(),
        entry.reason,
      );
  }

  /** Read-back convenience — see module doc. Write order via `id`, matching append-only intent. */
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
      applied_at: new Date(row.created_at),
      reason: row.reason,
    }));
  }

  /** Queues a gated loosening. Returns the row `id` — the key `resolvePendingApproval` needs. */
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
        entry.requested_at.toISOString(),
        entry.reason,
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Mutates the SAME row in place — the one exception to append-only. Guard
   * is in the UPDATE's own WHERE (status = 'pending_approval'), not a
   * read-then-write, so a second resolution cannot slip through between
   * check and write (mirrors `SqliteSetupStore.labelSetup`).
   */
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
