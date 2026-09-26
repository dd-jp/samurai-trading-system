import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2_CONTRACT_VERSION } from '../../../../contracts/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { annualisedSharpe } from '../../../tools/backtest/index.js';
import { Journal } from '../journal/journal.js';
import { EvidenceReader } from './evidence.js';

const clock = { now: () => new Date('2026-10-06T21:40:00.000Z') };

let db: StoreHandle;

afterEach(() => db?.close());

function open(): void {
  db = openSharedStore(':memory:');
}

function book(bookId: string, variant: string): void {
  db.prepare(
    `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
     VALUES (?, 'debate', ?, 1000, 1000, 'x')`,
  ).run(bookId, variant);
}

function day(bookId: string, date: string, equity: number): void {
  db.prepare(
    `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp, ytd_loss_gbp,
       size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
     VALUES (?, ?, ?, 0, 0, 0, 1, 0, 0, 'x')`,
  ).run(bookId, date, equity);
}

function exitOrder(id: string, bookId: string, leg: 'entry' | 'exit' = 'exit'): void {
  new Journal(db, clock).recordOrder({
    client_order_id: id,
    decision_id: null,
    book_id: bookId,
    trading_date: '2026-10-05',
    instrument: 'AAPL',
    venue: 'alpaca',
    leg,
    side: 'sell',
    dry_run: false,
    outcome: 'simulated',
    payload: {},
  });
}

function fillOf(fillId: string, orderId: string, bookId: string): void {
  new Journal(db, clock).recordFill({
    fill_id: fillId,
    client_order_id: orderId,
    book_id: bookId,
    trading_date: '2026-10-05',
    instrument: 'AAPL',
    venue: 'alpaca',
    leg: 'exit',
    side: 'sell',
    qty: 1,
    price_gbp: 100,
    fee_gbp: 0,
  });
}

function read() {
  return new EvidenceReader(db, clock).read();
}

describe('EvidenceReader (P5–P8)', () => {
  it('is empty before any book exists, and names the owner of every unbuilt panel', () => {
    open();
    expect(read()).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      generated_at: '2026-10-06T21:40:00.000Z',
      performance: { status: 'empty' },
      vs_arm2: { status: 'not-yet-fed', owner: 'arm 2', ticket: '#1773' },
      vs_benchmark: { status: 'not-yet-fed', owner: 'Step 1b', ticket: '#1785' },
      trade_count: { status: 'empty' },
      arm2_test: { status: 'not-yet-fed', owner: 'arm 2', ticket: '#1773' },
      band: { status: 'not-yet-fed', owner: 'Step 1b', ticket: '#1785' },
      gate: { status: 'not-yet-fed', owner: 'Step 1b and Step 4', ticket: '#1785' },
    });
  });

  it('serves each book on its own dates, never on a merged timeline', () => {
    open();
    book('debate/primary', 'primary');
    book('debate/no-veto', 'no-veto');
    day('debate/primary', '2026-10-01', 1000);
    day('debate/primary', '2026-10-02', 1010);
    day('debate/no-veto', '2026-10-02', 990);
    day('debate/primary', '2026-10-05', 1005);
    expect(read().performance).toEqual({
      status: 'fed',
      books: [
        {
          book_id: 'debate/primary',
          sleeve_id: 'debate',
          variant: 'primary',
          days: 3,
          sharpe: annualisedSharpe([1010 / 1000 - 1, 1005 / 1010 - 1]),
          max_drawdown: 1 - 1005 / 1010,
          equity: [
            { trading_date: '2026-10-01', equity_gbp: 1000 },
            { trading_date: '2026-10-02', equity_gbp: 1010 },
            { trading_date: '2026-10-05', equity_gbp: 1005 },
          ],
        },
        {
          book_id: 'debate/no-veto',
          sleeve_id: 'debate',
          variant: 'no-veto',
          days: 1,
          sharpe: null,
          max_drawdown: 0,
          equity: [{ trading_date: '2026-10-02', equity_gbp: 990 }],
        },
      ],
    });
  });

  it('has no Sharpe under two returns, or across a non-positive equity', () => {
    open();
    book('debate/primary', 'primary');
    book('debate/no-veto', 'no-veto');
    day('debate/primary', '2026-10-01', 1000);
    day('debate/primary', '2026-10-02', 1010);
    day('debate/no-veto', '2026-10-01', 0);
    day('debate/no-veto', '2026-10-02', 10);
    day('debate/no-veto', '2026-10-05', 20);
    expect(read().performance).toMatchObject({
      books: [
        { days: 2, sharpe: null },
        { days: 3, sharpe: null },
      ],
    });
  });

  it('measures the deepest fall from a running peak', () => {
    open();
    book('debate/primary', 'primary');
    for (const [date, equity] of [
      ['2026-10-01', 100],
      ['2026-10-02', 120],
      ['2026-10-05', 90],
      ['2026-10-06', 130],
    ] as const) {
      day('debate/primary', date, equity);
    }
    expect(read().performance).toMatchObject({ books: [{ max_drawdown: 0.25 }] });
  });

  it('counts closed round trips per book: exits that filled, once each', () => {
    open();
    book('debate/primary', 'primary');
    book('debate/no-veto', 'no-veto');
    exitOrder('exit-1', 'debate/primary');
    fillOf('f1', 'exit-1', 'debate/primary');
    fillOf('f2', 'exit-1', 'debate/primary');
    exitOrder('exit-2', 'debate/primary');
    fillOf('f3', 'exit-2', 'debate/primary');
    exitOrder('exit-unfilled', 'debate/primary');
    exitOrder('entry-1', 'debate/primary', 'entry');
    fillOf('f4', 'entry-1', 'debate/primary');
    exitOrder('exit-shadow', 'debate/no-veto');
    fillOf('f5', 'exit-shadow', 'debate/no-veto');
    expect(read().trade_count).toEqual({
      status: 'fed',
      target: 100,
      books: [
        { book_id: 'debate/primary', variant: 'primary', closed_trades: 2 },
        { book_id: 'debate/no-veto', variant: 'no-veto', closed_trades: 1 },
      ],
    });
  });

  it('reads both panels in one transaction', () => {
    open();
    const transaction = vi.spyOn(db, 'transaction');
    read();
    expect(transaction).toHaveBeenCalledOnce();
  });
});
