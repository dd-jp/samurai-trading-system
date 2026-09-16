import { openSharedStore } from '../../shared/store/index.js';
import { SqliteAdjustmentLog } from './sqlite-adjustment-log.js';
import type { Adjustment, PendingApprovalAdjustment } from './types.js';

const APPLIED_AT = new Date('2026-07-19T00:00:00Z');
const REQUESTED_AT = new Date('2026-07-19T00:05:00Z');

function makeAdjustment(overrides: Partial<Adjustment> = {}): Adjustment {
  return {
    dial: 'analyst_weight',
    name: 'bull',
    from: 0.5,
    to: 0.55,
    direction: 'loosen',
    applied_at: APPLIED_AT,
    reason: 'attribution',
    ...overrides,
  };
}

function makePending(
  overrides: Partial<PendingApprovalAdjustment> = {},
): PendingApprovalAdjustment {
  return {
    dial: 'risk_threshold',
    name: 'max_position_size',
    from: 1000,
    to: 1200,
    direction: 'loosen',
    requested_at: REQUESTED_AT,
    reason: 'proposal',
    ...overrides,
  };
}

describe('SqliteAdjustmentLog.append', () => {
  it('persists an applied adjustment as a new row', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);

    log.append(makeAdjustment());

    expect(db.prepare('SELECT * FROM dial_adjustments').all()).toEqual([
      {
        id: 1,
        dial_type: 'analyst_weight',
        dial_name: 'bull',
        from_value: 0.5,
        to_value: 0.55,
        direction: 'loosen',
        status: 'applied',
        cycle_date: '2026-07-19',
        created_at: APPLIED_AT.toISOString(),
        reason: 'attribution',
      },
    ]);
  });

  it('adds a new row per call — never merges or overwrites', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);

    log.append(makeAdjustment({ to: 0.55 }));
    log.append(makeAdjustment({ to: 0.6 }));

    expect(db.prepare('SELECT COUNT(*) AS n FROM dial_adjustments').get()).toEqual({ n: 2 });
  });
});

describe('SqliteAdjustmentLog.getEntries', () => {
  it('reads back applied entries in write order', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);
    const first = makeAdjustment({ name: 'bull', to: 0.55 });
    const second = makeAdjustment({ name: 'bear', to: 0.4 });

    log.append(first);
    log.append(second);

    expect(log.getEntries()).toEqual([first, second]);
  });

  it('excludes pending-approval rows — they are not resolved Adjustments yet', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);
    log.append(makeAdjustment());
    log.recordPendingApproval(makePending());

    expect(log.getEntries()).toHaveLength(1);
  });
});

describe('SqliteAdjustmentLog — pending-approval lifecycle', () => {
  it('recordPendingApproval writes a pending_approval row and returns its id', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);

    const id = log.recordPendingApproval(makePending());

    expect(db.prepare('SELECT * FROM dial_adjustments WHERE id = ?').get(id)).toEqual({
      id,
      dial_type: 'risk_threshold',
      dial_name: 'max_position_size',
      from_value: 1000,
      to_value: 1200,
      direction: 'loosen',
      status: 'pending_approval',
      cycle_date: '2026-07-19',
      created_at: REQUESTED_AT.toISOString(),
      reason: 'proposal',
    });
  });

  it('resolvePendingApproval("approved") mutates the SAME row to applied — not a new row', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);
    const id = log.recordPendingApproval(makePending());

    log.resolvePendingApproval(id, 'approved');

    expect(db.prepare('SELECT COUNT(*) AS n FROM dial_adjustments').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT status FROM dial_adjustments WHERE id = ?').get(id)).toEqual({
      status: 'applied',
    });
    expect(log.getEntries()).toEqual([
      {
        dial: 'risk_threshold',
        name: 'max_position_size',
        from: 1000,
        to: 1200,
        direction: 'loosen',
        applied_at: REQUESTED_AT,
        reason: 'proposal',
      },
    ]);
  });

  it('resolvePendingApproval("rejected") mutates the row to rejected', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);
    const id = log.recordPendingApproval(makePending());

    log.resolvePendingApproval(id, 'rejected');

    expect(db.prepare('SELECT status FROM dial_adjustments WHERE id = ?').get(id)).toEqual({
      status: 'rejected',
    });
    // A rejected row is not a resolved Adjustment — it never applied
    expect(log.getEntries()).toEqual([]);
  });

  it('rejects resolving an id that is not pending (already resolved)', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);
    const id = log.recordPendingApproval(makePending());
    log.resolvePendingApproval(id, 'approved');

    expect(() => log.resolvePendingApproval(id, 'rejected')).toThrow(
      /no pending adjustment with id/,
    );
  });

  it('rejects resolving an id that was never recorded', () => {
    const db = openSharedStore(':memory:');
    const log = new SqliteAdjustmentLog(db);

    expect(() => log.resolvePendingApproval(999, 'approved')).toThrow(
      /no pending adjustment with id/,
    );
  });
});

describe('SqliteAdjustmentLog — status CHECK constraint', () => {
  it('the dial_adjustments.status column rejects a value outside the four valid statuses', () => {
    const db = openSharedStore(':memory:');

    expect(() =>
      db
        .prepare(
          `INSERT INTO dial_adjustments (
             dial_type, dial_name, from_value, to_value, direction, status, cycle_date, created_at
           ) VALUES ('analyst_weight', 'bull', 0.5, 0.55, 'loosen', 'not_a_real_status', '2026-07-19', ?)`,
        )
        .run(APPLIED_AT.toISOString()),
    ).toThrow(/CHECK constraint failed/);
  });
});
