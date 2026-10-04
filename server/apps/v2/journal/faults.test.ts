import { describe, expect, it, vi } from 'vitest';
import type {
  JournalledOrder,
  JournalledReconcile,
  JournalledRefusal,
} from '../../../../contracts/index.js';
import type { LogEntry } from '../../../shared/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import {
  countedFaultFreeDays,
  FAULT_KINDS,
  type Fault,
  FaultLedger,
  FaultRecordingLogger,
  missedRunDates,
  orderFault,
  pausedDates,
  reconcileFaults,
  refusalFault,
} from './faults.js';
import { Journal } from './journal.js';

const clock = new SimulatedClock(new Date('2026-10-01T07:30:00.000Z'));
const NO_SKIP = () => false;

function ledger(db: StoreHandle = migratedMemoryStore(), logs: LogEntry[] = []) {
  return new FaultLedger(db, clock, { log: (entry) => logs.push(entry) });
}

function rows(db: StoreHandle): Fault[] {
  return db
    .prepare('SELECT kind, trading_date, code, detail FROM v2_faults ORDER BY fault_id')
    .all() as Fault[];
}

const fault = (kind: Fault['kind'], trading_date = '2026-10-01'): Fault => ({
  kind,
  trading_date,
  code: 'CODE',
  detail: `${kind} detail`,
});

function markPaperStart(db: StoreHandle, tradingDate: string): void {
  db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES ('debate/primary', 'debate', 'primary', 1000, 1000, '2026-09-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp,
       ytd_loss_gbp, size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
     VALUES ('debate/primary', ?, 1000, 1000, 0, 0, 1, 0, 0, '2026-09-01T00:00:00.000Z')`,
  ).run(tradingDate);
}

function control(db: StoreHandle, action: string, setAt: string): void {
  db.prepare(
    `INSERT INTO v2_controls (action, reason, source, idempotency_key, set_at)
     VALUES (?, 'test', 'test', ?, ?)`,
  ).run(action, `${action}-${setAt}`, setAt);
}

describe('FaultLedger', () => {
  it('records each fault kind once, however often the same fault is reported', () => {
    const db = migratedMemoryStore();
    const faults = ledger(db);
    for (const kind of FAULT_KINDS) {
      faults.record(fault(kind));
      faults.record(fault(kind));
    }
    expect(rows(db)).toEqual(FAULT_KINDS.map((kind) => fault(kind)));
    expect(faults.faultsOn('2026-10-01')).toHaveLength(FAULT_KINDS.length);
    expect(faults.faultsOn('2026-10-02')).toEqual([]);
  });

  it('keeps a second fault of one kind on another day or with another detail', () => {
    const db = migratedMemoryStore();
    const faults = ledger(db);
    faults.record(fault('stale_bar', '2026-10-01'));
    faults.record(fault('stale_bar', '2026-10-02'));
    faults.record({ ...fault('stale_bar', '2026-10-01'), detail: 'MSFT stale' });
    expect(rows(db)).toHaveLength(3);
  });

  it('rejects any update or delete of a recorded fault', () => {
    const db = migratedMemoryStore();
    ledger(db).record(fault('missed_run'));
    expect(() => db.prepare("UPDATE v2_faults SET kind = 'stale_bar'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM v2_faults').run()).toThrow(/append-only/);
    expect(rows(db)).toEqual([fault('missed_run')]);
  });

  it('logs a fault it cannot write and never throws into the caller', () => {
    const logs: LogEntry[] = [];
    const faults = ledger(migratedMemoryStore(), logs);
    expect(() =>
      faults.record({ ...fault('stale_bar'), kind: 'unknown' as Fault['kind'] }),
    ).not.toThrow();
    expect(logs).toEqual([
      expect.objectContaining({
        level: 'error',
        event: 'v2_fault_record_failed',
        message: expect.stringContaining('unknown CODE not recorded'),
      }),
    ]);
  });

  it('records one missed run per scheduled weekday left unmarked', () => {
    const db = migratedMemoryStore();
    const faults = ledger(db);
    faults.recordMissedRuns(() => '2026-09-24', '2026-09-30', NO_SKIP);
    expect(rows(db)).toEqual([
      {
        kind: 'missed_run',
        trading_date: '2026-09-25',
        code: 'CYCLE_NOT_RUN',
        detail: 'no cycle marked 2026-09-25; the next ran 2026-09-30',
      },
      expect.objectContaining({ trading_date: '2026-09-28' }),
      expect.objectContaining({ trading_date: '2026-09-29' }),
    ]);
  });

  it('logs a missed-run check that cannot read the last mark and never throws into the cycle', () => {
    const logs: LogEntry[] = [];
    const db = migratedMemoryStore();
    const faults = ledger(db, logs);
    expect(() =>
      faults.recordMissedRuns(
        () => {
          throw new Error('book store unreadable');
        },
        '2026-09-30',
        NO_SKIP,
      ),
    ).not.toThrow();
    expect(rows(db)).toEqual([]);
    expect(logs).toEqual([
      expect.objectContaining({
        trace_id: 'v2-2026-09-30',
        event: 'v2_fault_record_failed',
        message: 'missed_run CYCLE_NOT_RUN not recorded: book store unreadable',
      }),
    ]);
  });
});

describe('missedRunDates', () => {
  it('names nothing before the first mark, after the previous weekday or across a weekend', () => {
    expect(missedRunDates(undefined, '2026-09-30', NO_SKIP)).toEqual([]);
    expect(missedRunDates('2026-09-29', '2026-09-30', NO_SKIP)).toEqual([]);
    expect(missedRunDates('2026-09-25', '2026-09-28', NO_SKIP)).toEqual([]);
    expect(missedRunDates('2026-09-30', '2026-09-30', NO_SKIP)).toEqual([]);
    expect(missedRunDates('2026-10-01', '2026-09-30', NO_SKIP)).toEqual([]);
  });

  it('names every weekday between the last mark and today', () => {
    expect(missedRunDates('2026-09-25', '2026-10-01', NO_SKIP)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
    ]);
  });

  it('never names a day the skip rule passes over', () => {
    const skipped = (date: string) => date === '2026-12-25';
    expect(missedRunDates('2026-12-24', '2026-12-29', skipped)).toEqual(['2026-12-28']);
  });
});

describe('fault classification', () => {
  const refusal = (parameter: string): JournalledRefusal => ({
    trading_date: '2026-10-01',
    scope: 'data',
    parameter,
    ticket: '#1',
    message: `${parameter} message`,
  });

  it('maps stale bars, a missing backstop and a lost Saxo session, and nothing else', () => {
    expect(refusalFault(refusal('MARK_FRESHNESS'))).toEqual({
      kind: 'stale_bar',
      trading_date: '2026-10-01',
      code: 'MARK_FRESHNESS',
      detail: 'MARK_FRESHNESS message',
    });
    expect(refusalFault(refusal('CALENDAR_REFERENCE'))?.kind).toBe('stale_bar');
    expect(refusalFault(refusal('REARM_BACKSTOP'))?.kind).toBe('missed_stop');
    expect(refusalFault(refusal('SAXO_SESSION'))?.kind).toBe('token_failure');
    for (const standing of ['MACRO_CALENDARS', 'CAPITAL_CONFIG', 'MANUAL_CONTROL', 'LOSS_BUDGET']) {
      expect(refusalFault(refusal(standing))).toBeUndefined();
    }
  });

  const reconcile = (overrides: Partial<JournalledReconcile>): JournalledReconcile => ({
    trading_date: '2026-10-01',
    venue: 'alpaca',
    source: 'broker',
    status: 'clean',
    book_ids: ['debate/primary'],
    diffs: [],
    detail: '',
    broker_mode: 'paper',
    cash_quote: null,
    ...overrides,
  });

  it('records a mismatch, a missed stop per unprotected position and a failed broker read', () => {
    expect(reconcileFaults(reconcile({}))).toEqual([]);
    expect(reconcileFaults(reconcile({ status: 'unverified', detail: 'cash' }))).toEqual([]);
    expect(reconcileFaults(reconcile({ status: 'read_failed', detail: 'HTTP 503' }))).toEqual([
      {
        kind: 'failed_broker_call',
        trading_date: '2026-10-01',
        code: 'BROKER_RECONCILE_READ',
        detail: 'alpaca broker: HTTP 503',
      },
    ]);
    const unprotected = {
      kind: 'position_unprotected' as const,
      instrument: 'UP',
      order_id: null,
      store: 3,
      broker: 3,
    };
    const qty = { ...unprotected, kind: 'position_qty' as const, instrument: 'DN' };
    expect(
      reconcileFaults(
        reconcile({ status: 'mismatch', diffs: [unprotected, qty], detail: 'diffs' }),
      ),
    ).toEqual([
      {
        kind: 'reconcile_mismatch',
        trading_date: '2026-10-01',
        code: 'BROKER_RECONCILE',
        detail: 'alpaca broker: diffs',
      },
      {
        kind: 'missed_stop',
        trading_date: '2026-10-01',
        code: 'position_unprotected',
        detail: 'alpaca broker: UP held without a stop',
      },
    ]);
  });

  const order = (outcome: JournalledOrder['outcome'], approval?: string): JournalledOrder => ({
    client_order_id: 'v2-x',
    decision_id: null,
    book_id: 'debate/primary',
    trading_date: '2026-10-01',
    instrument: 'UP',
    venue: 'alpaca',
    leg: 'exit',
    side: 'sell',
    dry_run: false,
    outcome,
    payload: { approval, detail: 'HTTP 422' },
  });

  it('counts only an approved order the venue rejected as a failed broker call', () => {
    expect(orderFault(order('rejected', 'exit:v2-x:3'))).toEqual({
      kind: 'failed_broker_call',
      trading_date: '2026-10-01',
      code: 'exit_rejected',
      detail: 'v2-x: HTTP 422',
    });
    expect(orderFault(order('rejected'))).toBeUndefined();
    expect(orderFault(order('rejected', ''))).toBeUndefined();
    expect(orderFault(order('submitted', 'exit:v2-x:3'))).toBeUndefined();
  });

  it('records the faults the journal writes through its own rows', () => {
    const db = migratedMemoryStore();
    const journal = new Journal(db, clock, ledger(db));
    journal.recordRefusal(refusal('MARK_FRESHNESS'));
    journal.recordRefusal(refusal('MACRO_CALENDARS'));
    journal.recordReconcile(reconcile({ status: 'mismatch', detail: 'qty' }));
    journal.recordOrder(order('rejected', 'exit:v2-x:3'));
    expect(rows(db).map((row) => row.kind)).toEqual([
      'stale_bar',
      'reconcile_mismatch',
      'failed_broker_call',
    ]);
  });
});

describe('FaultRecordingLogger', () => {
  it('passes every entry on and records the plumbing events against the trading date', () => {
    const inner = { log: vi.fn() };
    const sink = { record: vi.fn() };
    const logger = new FaultRecordingLogger(inner, sink, () => '2026-10-01');
    const entry = (event: string): LogEntry => ({
      trace_id: 't',
      stage: 'v2',
      level: 'warn',
      event,
      message: `${event} happened`,
    });
    for (const event of [
      'v2_fill_sweep_failed',
      'v2_resume_flatten_failed',
      'v2_cancel_failed',
      'v2_simulated_flatten_stale',
      'v2_rearm_backstop_failed',
      'v2_reconcile_threw',
      'v2_cycle_complete',
    ]) {
      logger.log(entry(event));
    }
    expect(inner.log).toHaveBeenCalledTimes(7);
    expect(sink.record.mock.calls.map(([recorded]) => recorded.kind)).toEqual([
      'failed_broker_call',
      'failed_broker_call',
      'stuck_order',
      'stuck_order',
      'missed_stop',
      'reconcile_mismatch',
    ]);
    expect(sink.record).toHaveBeenCalledWith({
      kind: 'stuck_order',
      trading_date: '2026-10-01',
      code: 'v2_cancel_failed',
      detail: 'v2_cancel_failed happened',
    });
  });
});

describe('kindsRecordedBetween', () => {
  it('counts faults by kind recorded inside the window, whatever trading date they carry', () => {
    const db = migratedMemoryStore();
    const at = new SimulatedClock(new Date('2026-09-29T07:30:00.000Z'));
    const faults = new FaultLedger(db, at);
    faults.record(fault('stale_bar', '2026-09-29'));
    at.advanceTo(new Date('2026-09-30T07:30:00.000Z'));
    faults.record(fault('missed_run', '2026-09-25'));
    faults.record({ ...fault('failed_broker_call'), code: 'A' });
    faults.record({ ...fault('failed_broker_call'), code: 'B' });
    expect(
      faults.kindsRecordedBetween('2026-09-29T07:30:00.000Z', '2026-09-30T07:30:00.000Z'),
    ).toEqual([
      { kind: 'failed_broker_call', count: 2 },
      { kind: 'missed_run', count: 1 },
    ]);
    expect(faults.kindsRecordedBetween('', '2026-09-30T07:30:00.000Z')).toHaveLength(3);
    expect(faults.kindsRecordedBetween('', '2026-09-29T07:30:00.000Z')).toEqual([
      { kind: 'stale_bar', count: 1 },
    ]);
  });
});

describe('fault-free weeks', () => {
  it('is zero before paper has marked a day', () => {
    expect(ledger().faultFreeWeeks('2026-10-01')).toEqual({
      weeks: 0,
      counted_days: 0,
      since: undefined,
      last_fault: undefined,
    });
  });

  it('counts from paper start with no fault, and restarts the day after a fault', () => {
    const db = migratedMemoryStore();
    const faults = ledger(db);
    markPaperStart(db, '2026-09-01');
    expect(faults.faultFreeWeeks('2026-09-28')).toEqual({
      weeks: 4,
      counted_days: 28,
      since: '2026-09-01',
      last_fault: undefined,
    });
    faults.record(fault('reconcile_mismatch', '2026-09-14'));
    expect(faults.faultFreeWeeks('2026-09-27')).toEqual({
      weeks: 1,
      counted_days: 13,
      since: '2026-09-15',
      last_fault: '2026-09-14',
    });
    expect(faults.faultFreeWeeks('2026-09-28').weeks).toBe(2);
    expect(faults.faultFreeWeeks('2026-09-14')).toMatchObject({ weeks: 0, counted_days: 0 });
    expect(faults.faultFreeWeeks('2026-09-13')).toMatchObject({
      weeks: 1,
      counted_days: 13,
      last_fault: undefined,
    });
  });

  it('stops the count over paused or halted days without restarting it (doc 66 U6)', () => {
    const db = migratedMemoryStore();
    const faults = ledger(db);
    markPaperStart(db, '2026-09-01');
    control(db, 'pause', '2026-09-08T12:00:00.000Z');
    control(db, 'halt', '2026-09-09T12:00:00.000Z');
    control(db, 'resume', '2026-09-10T09:00:00.000Z');
    expect(faults.faultFreeWeeks('2026-09-28')).toMatchObject({ weeks: 3, counted_days: 25 });
    control(db, 'pause', '2026-09-27T12:00:00.000Z');
    expect(faults.faultFreeWeeks('2026-09-28')).toMatchObject({ weeks: 3, counted_days: 23 });
  });
});

describe('pausedDates', () => {
  it('ignores a resume with nothing paused and runs an open pause through the as-of date', () => {
    expect([
      ...pausedDates(
        [
          { action: 'resume', set_at: '2026-09-01T00:00:00.000Z' },
          { action: 'halt', set_at: '2026-09-29T08:00:00.000Z' },
        ],
        '2026-10-01',
      ),
    ]).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });

  it('counts the days outside the paused set', () => {
    expect(countedFaultFreeDays(undefined, '2026-10-01', new Set())).toBe(0);
    expect(countedFaultFreeDays('2026-09-29', '2026-10-01', new Set(['2026-09-30']))).toBe(2);
  });
});
