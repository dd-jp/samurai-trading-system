import { openSharedStore } from '../../shared/store/index.js';
import { type AuditLogEntry, SqliteAuditLog } from './sqlite-audit-log.js';

const TRACE_ID = 'trace-aapl-1400';

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    trace_id: TRACE_ID,
    stage: 'analysts',
    decision: 'proceed',
    input_digest: 'digest-in',
    output_digest: 'digest-out',
    timestamp: new Date('2026-07-15T14:00:00Z'),
    ...overrides,
  };
}

function makeStore(): SqliteAuditLog {
  return new SqliteAuditLog(openSharedStore(':memory:'));
}

describe('SqliteAuditLog', () => {
  it('returns nothing for a trace_id with no rows', () => {
    const log = makeStore();

    expect(log.getByTraceId(TRACE_ID)).toEqual([]);
  });

  it('appends one row per record() call', () => {
    const log = makeStore();

    log.record(entry({ stage: 'analysts' }));
    log.record(entry({ stage: 'debate', timestamp: new Date('2026-07-15T14:00:05Z') }));

    expect(log.getByTraceId(TRACE_ID).map((row) => row.stage)).toEqual(['analysts', 'debate']);
  });

  it('orders rows by timestamp, oldest first, even when recorded out of order', () => {
    const log = makeStore();

    log.record(entry({ stage: 'verdict', timestamp: new Date('2026-07-15T14:00:20Z') }));
    log.record(entry({ stage: 'analysts', timestamp: new Date('2026-07-15T14:00:00Z') }));
    log.record(entry({ stage: 'debate', timestamp: new Date('2026-07-15T14:00:10Z') }));

    expect(log.getByTraceId(TRACE_ID).map((row) => row.stage)).toEqual([
      'analysts',
      'debate',
      'verdict',
    ]);
  });

  it('breaks same-timestamp ties by insertion order (rowid)', () => {
    const log = makeStore();
    const sameInstant = new Date('2026-07-15T14:00:00Z');

    log.record(entry({ stage: 'analysts', timestamp: sameInstant }));
    log.record(entry({ stage: 'debate', timestamp: sameInstant }));
    log.record(entry({ stage: 'trader', timestamp: sameInstant }));

    expect(log.getByTraceId(TRACE_ID).map((row) => row.stage)).toEqual([
      'analysts',
      'debate',
      'trader',
    ]);
  });

  it('only returns rows for the requested trace_id', () => {
    const log = makeStore();

    log.record(entry({ trace_id: 'trace-other', stage: 'analysts' }));
    log.record(entry({ trace_id: TRACE_ID, stage: 'debate' }));

    expect(log.getByTraceId(TRACE_ID).map((row) => row.stage)).toEqual(['debate']);
  });

  it('round-trips every field, including timestamp as a Date', () => {
    const log = makeStore();
    const row = entry();

    log.record(row);

    expect(log.getByTraceId(TRACE_ID)).toEqual([row]);
  });
});
