import { afterEach, describe, expect, it } from 'vitest';
import type { StoreHandle } from '../../../shared/store/index.js';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { readClosedTradeLedger } from './closed-trade-ledger.js';

let db: StoreHandle;
let nextId = 0;

afterEach(() => db?.close());

function book(bookId: string, variant: string): void {
  db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES (?, 'debate', ?, 1000, 1000, 'x')`,
  ).run(bookId, variant);
}

function outcome(bookId: string, exitDate: string, pnl: number): void {
  nextId += 1;
  const id = `d-${nextId}`;
  db.prepare(
    `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash, direction,
       confidence, action, reason, size_shares, stop_price, payload, recorded_at)
     VALUES (?, ?, '2026-10-01', 'AAPL', 'alpaca', 'h', 'long', 0.7, 'enter_long', 'r', 1, 90, '{}', 'x')`,
  ).run(id, bookId);
  db.prepare(
    `INSERT INTO v2_decision_outcomes (decision_id, book_id, sleeve_id, instrument, venue, direction,
       decision_date, entry_client_order_id, exit_client_order_id, exit_leg, exit_reason, entry_date,
       exit_date, holding_days, entry_qty, exit_qty, entry_price_gbp, exit_price_gbp, fees_gbp,
       carry_gbp, realised_pnl_gbp, trade_return, r_multiple, benchmark_symbol, benchmark_return,
       excess_return, settled_at, schema_version)
     VALUES (?, ?, 'debate', 'AAPL', 'alpaca', 'long', '2026-10-01', ?, ?, 'exit', 'stop', '2026-10-02',
       ?, 3, 1, 1, 100, 105, 0, 0, ?, 0.05, 0.5, 'SPY', 0.01, 0.04, 'x', 1)`,
  ).run(id, bookId, `e-${id}`, `x-${id}`, exitDate, pnl);
}

function fresh(): void {
  db = migratedMemoryStore();
  book('debate/primary', 'primary');
}

describe('readClosedTradeLedger', () => {
  it('is empty with no settled trade', () => {
    fresh();
    expect(readClosedTradeLedger(db)).toEqual({ status: 'empty' });
  });

  it('totals wins, expectancy, net and profit factor per primary book', () => {
    fresh();
    outcome('debate/primary', '2026-10-05', 30);
    outcome('debate/primary', '2026-10-06', -10);
    outcome('debate/primary', '2026-10-07', 0);
    expect(readClosedTradeLedger(db)).toMatchObject({
      status: 'fed',
      stats: [
        {
          book_id: 'debate/primary',
          trades: 3,
          win_rate: 1 / 3,
          expectancy_gbp: 20 / 3,
          profit_factor: 3,
          net_gbp: 20,
        },
      ],
    });
  });

  it('reports no profit factor when nothing has lost', () => {
    fresh();
    outcome('debate/primary', '2026-10-05', 30);
    expect(readClosedTradeLedger(db)).toMatchObject({ stats: [{ profit_factor: null }] });
  });

  it('leaves shadow books out of the totals and the rows', () => {
    fresh();
    book('debate/no-veto', 'no-veto');
    outcome('debate/no-veto', '2026-10-05', 30);
    expect(readClosedTradeLedger(db)).toEqual({ status: 'empty' });
  });

  it('serves the newest trades first, fifty at most, while the totals count them all', () => {
    fresh();
    for (let n = 0; n < 51; n += 1) outcome('debate/primary', '2026-10-05', 1);
    outcome('debate/primary', '2026-10-09', 7);
    const ledger = readClosedTradeLedger(db);
    if (ledger.status !== 'fed') throw new Error('expected fed');
    expect(ledger.stats[0]?.trades).toBe(52);
    expect(ledger.newest).toHaveLength(50);
    expect(ledger.newest[0]).toEqual({
      decision_id: `d-${nextId}`,
      book_id: 'debate/primary',
      instrument: 'AAPL',
      direction: 'long',
      entry_date: '2026-10-02',
      exit_date: '2026-10-09',
      exit_reason: 'stop',
      holding_days: 3,
      realised_pnl_gbp: 7,
      trade_return: 0.05,
      r_multiple: 0.5,
      benchmark_symbol: 'SPY',
      excess_return: 0.04,
    });
  });
});
