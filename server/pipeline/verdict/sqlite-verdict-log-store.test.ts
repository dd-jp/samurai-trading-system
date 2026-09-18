
import type { VerdictLog } from '../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { SqliteVerdictLogStore } from './sqlite-verdict-log-store.js';

function makeLog(overrides: Partial<VerdictLog> = {}): VerdictLog {
  return {
    trace_id: 'trace-1',
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    instrument: 'AAPL',
    status: 'go',
    no_go_reason: null,
    no_go_detail_measured_ms: null,
    no_go_detail_bound_ms: null,
    hitl_override: false,
    timestamp: new Date('2026-07-15T14:00:00Z'),
    ...overrides,
  };
}

interface VerdictLogRow {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  status: string;
  no_go_reason: string | null;
  hitl_override: number;
  timestamp: string;
}

function readRow(db: StoreHandle, trace_id: string): VerdictLogRow | undefined {
  return db.prepare('SELECT * FROM verdict_log WHERE trace_id = ?').get(trace_id) as
    | VerdictLogRow
    | undefined;
}

describe('SqliteVerdictLogStore', () => {
  it('persists a go row, readable back over the raw table', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteVerdictLogStore(db);

    store.writeLog(makeLog());

    const row = readRow(db, 'trace-1');
    expect(row).toMatchObject({
      trace_id: 'trace-1',
      idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
      instrument: 'AAPL',
      status: 'go',
      no_go_reason: null,
      no_go_detail_measured_ms: null,
      no_go_detail_bound_ms: null,
      hitl_override: 0,
      timestamp: '2026-07-15T14:00:00.000Z',
    });
  });

  it('persists a no_go row with a reason and hitl_override as 1', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteVerdictLogStore(db);

    store.writeLog(makeLog({ status: 'no_go', no_go_reason: 'staleness', hitl_override: true }));

    const row = readRow(db, 'trace-1');
    expect(row?.status).toBe('no_go');
    expect(row?.no_go_reason).toBe('staleness');
    expect(row?.hitl_override).toBe(1);
  });

  it('does not conflate rows across distinct trace_ids', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteVerdictLogStore(db);

    store.writeLog(makeLog({ trace_id: 'trace-a', instrument: 'AAPL' }));
    store.writeLog(makeLog({ trace_id: 'trace-b', instrument: 'TSLA' }));

    expect(readRow(db, 'trace-a')?.instrument).toBe('AAPL');
    expect(readRow(db, 'trace-b')?.instrument).toBe('TSLA');
  });

  it('a repeated trace_id does not throw, but the ORIGINAL row wins (first-write-wins, not last)', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteVerdictLogStore(db);

    store.writeLog(makeLog({ status: 'no_go', no_go_reason: 'drift' }));
    expect(() => store.writeLog(makeLog({ status: 'go', no_go_reason: null }))).not.toThrow();

    const rows = db.prepare('SELECT * FROM verdict_log WHERE trace_id = ?').all('trace-1');
    expect(rows).toHaveLength(1);
    expect(readRow(db, 'trace-1')?.status).toBe('no_go');
    expect(readRow(db, 'trace-1')?.no_go_reason).toBe('drift');
  });
});
