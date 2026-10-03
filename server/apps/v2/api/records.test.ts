import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { V2_CONTRACT_VERSION } from '../../../../contracts/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { Journal } from '../journal/index.js';
import { parseTaxQuery, RECONCILE_RUNS_SHOWN, ReconcileReader } from './records.js';

describe('parseTaxQuery', () => {
  it('defaults to JSON for no year', () => {
    expect(parseTaxQuery(new URLSearchParams())).toEqual({
      ok: true,
      query: { year: null, format: 'json' },
    });
  });

  it('takes a year and a format', () => {
    expect(parseTaxQuery(new URLSearchParams('year=2026&format=csv'))).toEqual({
      ok: true,
      query: { year: 2026, format: 'csv' },
    });
  });

  it.each([
    ['year=26', 'year is invalid'],
    ['year=1999', 'year is invalid'],
    ['year=x2026', 'year is invalid'],
    ['year=2026x', 'year is invalid'],
    ['format=xlsx', 'format is invalid'],
    ['year=2026&year=2027', 'year is given more than once'],
    ['from=2026', 'unknown parameter; allowed: year, format'],
  ])('refuses %s', (raw, reason) => {
    expect(parseTaxQuery(new URLSearchParams(raw))).toEqual({ ok: false, reason });
  });
});

describe('ReconcileReader', () => {
  const clock = new SimulatedClock(new Date('2026-09-28T07:00:00.000Z'));

  function recordRuns(db: StoreHandle, count: number): void {
    const journal = new Journal(db, clock);
    for (let day = 0; day < count; day += 1) {
      journal.recordReconcile({
        trading_date: `run-${day}`,
        venue: 'alpaca',
        source: 'broker',
        status: day % 2 === 0 ? 'clean' : 'read_failed',
        book_ids: ['debate/primary'],
        diffs: day === count - 1 ? [DIFF] : [],
        detail: '',
        broker_mode: 'paper',
        cash_quote: null,
      });
    }
  }

  const DIFF = { kind: 'cash', instrument: null, order_id: null, store: 800, broker: 700 } as const;

  it('serves an empty log before any run, and before the table exists on an older store', () => {
    expect(new ReconcileReader(openSharedStore(':memory:')).read()).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      reconcile: { status: 'empty' },
    });
    const older = new BetterSqlite3(':memory:');
    expect(new ReconcileReader(older).read().reconcile).toEqual({ status: 'empty' });
  });

  it('serves the newest runs first, parsed, capped at the runs shown', () => {
    const db = openSharedStore(':memory:');
    recordRuns(db, RECONCILE_RUNS_SHOWN + 2);
    const served = new ReconcileReader(db).read().reconcile;
    if (served.status !== 'fed') throw new Error(served.status);

    expect(served.runs).toHaveLength(RECONCILE_RUNS_SHOWN);
    expect(served.runs[0]).toEqual({
      trading_date: `run-${RECONCILE_RUNS_SHOWN + 1}`,
      venue: 'alpaca',
      source: 'broker',
      status: 'read_failed',
      book_ids: ['debate/primary'],
      diffs: [DIFF],
      detail: '',
      recorded_at: '2026-09-28T07:00:00.000Z',
    });
    expect(served.runs.at(-1)?.trading_date).toBe('run-2');
  });
});
