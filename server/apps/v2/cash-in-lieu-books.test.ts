import { describe, expect, it } from 'vitest';
import type { BrokerActivityStatus, OrderSide } from '../../../contracts/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { type CashInLieuCorrection, SqliteCashInLieuBooks } from './cash-in-lieu-books.js';
import { Journal } from './journal/index.js';

const clock = new SimulatedClock(new Date('2026-10-02T07:00:00.000Z'));
const FX = 1.25;
const SPLIT_DAY = '2026-09-29';
const READ_DAY = '2026-10-01';
const NEXT_DAY = '2026-10-02';

interface Estimate {
  readonly book: string;
  readonly qty: number;
  readonly side?: OrderSide;
  readonly outcome?: 'submitted' | 'simulated';
  readonly venue?: 'alpaca' | 'saxo_cfd_usd';
}

function seed(db: StoreHandle, estimates: readonly Estimate[]): void {
  const journal = new Journal(db, clock);
  estimates.forEach((estimate, index) => {
    const order = `o-${index}`;
    const venue = estimate.venue ?? 'alpaca';
    journal.recordOrder({
      client_order_id: order,
      decision_id: null,
      book_id: estimate.book,
      trading_date: '2026-09-01',
      instrument: 'NVDA',
      venue,
      leg: 'entry',
      side: 'buy',
      dry_run: false,
      outcome: estimate.outcome ?? 'submitted',
      payload: {},
    });
    journal.recordFill({
      fill_id: `est-${index}`,
      client_order_id: order,
      book_id: estimate.book,
      trading_date: SPLIT_DAY,
      instrument: 'NVDA',
      venue,
      leg: 'cash_in_lieu',
      side: estimate.side ?? 'sell',
      qty: estimate.qty,
      price_gbp: 24,
      fee_gbp: 0,
      currency: 'USD',
      price_native: 30,
      fee_native: 0,
      fx_quote_per_gbp: FX,
      fx_source: 'year-start',
      fill_date: SPLIT_DAY,
      broker_mode: 'paper',
    });
  });
}

interface Read {
  readonly id?: string;
  readonly qty?: number | null;
  readonly amount: number;
  readonly status?: BrokerActivityStatus;
  readonly fx?: number;
  readonly tradingDate?: string;
}

function read(db: StoreHandle, row: Read): void {
  new Journal(db, clock).recordCashInLieu({
    venue: 'alpaca',
    activity_id: row.id ?? 'cil-1',
    instrument: 'NVDA',
    activity_date: '2026-09-30',
    qty: row.qty === undefined ? 0.5 : row.qty,
    amount_native: row.amount,
    currency: 'USD',
    status: row.status ?? 'executed',
    fx_quote_per_gbp: row.fx ?? FX,
    fx_source: 'read-day',
    trading_date: row.tradingDate ?? READ_DAY,
  });
}

function store(estimates: readonly Estimate[], reads: readonly Read[]): StoreHandle {
  const db = migratedMemoryStore();
  seed(db, estimates);
  for (const row of reads) read(db, row);
  return db;
}

function applyAll(ledger: SqliteCashInLieuBooks, date: string): CashInLieuCorrection[] {
  const pending = [...ledger.pending(date)];
  for (const correction of pending) {
    if (!ledger.record(correction)) throw new Error(`not recorded: ${correction.activity_key}`);
  }
  return pending;
}

function bookedNative(db: StoreHandle, fillId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(amount_native), 0) AS n FROM v2_cash_in_lieu_adjustments WHERE estimate_fill_id = ?',
    )
    .get(fillId) as { n: number };
  return row.n;
}

const BOTH_BOOKS: readonly Estimate[] = [
  { book: 'debate/primary', qty: 0.3 },
  { book: 'debate/no-macro-gate', qty: 0.2 },
];

describe('cash-in-lieu book-cash corrections (#2001)', () => {
  it("shares the broker's amount pro rata over the estimates it pairs, less each estimate", () => {
    const db = store(BOTH_BOOKS, [{ amount: 16 }]);
    const ledger = new SqliteCashInLieuBooks(db, clock);
    expect(ledger.pending(NEXT_DAY)).toEqual([
      {
        book_id: 'debate/primary',
        estimate_fill_id: 'est-0',
        venue: 'alpaca',
        instrument: 'NVDA',
        activity_id: 'cil-1',
        activity_key: 'alpaca:cil-1:executed',
        amount_native: expect.closeTo(0.6, 9),
        amount_gbp: expect.closeTo(0.48, 9),
        fx_quote_per_gbp: FX,
        fx_source: 'read-day',
        estimate_fill_seq: 1,
        broker_mode: 'paper',
        trading_date: NEXT_DAY,
      },
      expect.objectContaining({
        book_id: 'debate/no-macro-gate',
        estimate_fill_id: 'est-1',
        amount_native: expect.closeTo(0.4, 9),
        amount_gbp: expect.closeTo(0.32, 9),
        estimate_fill_seq: 2,
      }),
    ]);
  });

  it("converts the broker's amount at the reading row's rate, not the estimate's (ruling (a))", () => {
    const db = store([{ book: 'debate/primary', qty: 0.5 }], [{ amount: 16, fx: 1.6 }]);
    const [correction] = new SqliteCashInLieuBooks(db, clock).pending(NEXT_DAY);
    expect(correction?.amount_native).toBeCloseTo(1, 9);
    expect(correction?.amount_gbp).toBeCloseTo(16 / 1.6 - 0.5 * 24, 9);
    expect(correction?.fx_quote_per_gbp).toBe(1.6);
  });

  it('a buy-back estimate is corrected towards the broker debit', () => {
    const db = store([{ book: 'debate/primary', qty: 0.5, side: 'buy' }], [{ amount: -16 }]);
    const [correction] = new SqliteCashInLieuBooks(db, clock).pending(NEXT_DAY);
    expect(correction?.amount_native).toBeCloseTo(-1, 9);
    expect(correction?.amount_gbp).toBeCloseTo(-16 / FX + 12, 9);
  });

  it('takes only reads journalled before the day (ruling (e))', () => {
    const db = store([{ book: 'debate/primary', qty: 0.5 }], [{ amount: 16 }]);
    const ledger = new SqliteCashInLieuBooks(db, clock);
    expect(ledger.pending(READ_DAY)).toEqual([]);
    expect(ledger.pending(NEXT_DAY)).toHaveLength(1);
  });

  it('is idempotent: a recorded correction is not pending again and a repeat insert is ignored', () => {
    const db = store(BOTH_BOOKS, [{ amount: 16 }]);
    const ledger = new SqliteCashInLieuBooks(db, clock);
    const applied = applyAll(ledger, NEXT_DAY);
    expect(ledger.pending(NEXT_DAY)).toEqual([]);
    expect(ledger.pending('2026-10-05')).toEqual([]);
    expect(ledger.record(applied[0] as CashInLieuCorrection)).toBe(false);
    const rows = db
      .prepare('SELECT fills_before, trading_date FROM v2_cash_in_lieu_adjustments')
      .all();
    expect(rows).toEqual([
      { fills_before: 0, trading_date: NEXT_DAY },
      { fills_before: 0, trading_date: NEXT_DAY },
    ]);
  });

  it('an activity the broker later cancels reverses its correction under the canceled key, netting to zero', () => {
    const db = store(BOTH_BOOKS, [{ amount: 16 }]);
    const ledger = new SqliteCashInLieuBooks(db, clock);
    applyAll(ledger, NEXT_DAY);
    read(db, { amount: 16, status: 'canceled', fx: 1.6, tradingDate: NEXT_DAY });
    expect(ledger.pending(NEXT_DAY)).toEqual([]);
    const reversals = applyAll(ledger, '2026-10-05');
    expect(reversals).toEqual([
      expect.objectContaining({
        estimate_fill_id: 'est-0',
        activity_key: 'alpaca:cil-1:canceled',
        amount_native: expect.closeTo(-0.6, 9),
        amount_gbp: expect.closeTo(-0.48, 9),
        fx_quote_per_gbp: 1.6,
      }),
      expect.objectContaining({
        estimate_fill_id: 'est-1',
        amount_native: expect.closeTo(-0.4, 9),
        amount_gbp: expect.closeTo(-0.32, 9),
      }),
    ]);
    expect(bookedNative(db, 'est-0')).toBeCloseTo(0, 12);
    expect(ledger.pending('2026-10-06')).toEqual([]);
  });

  it('a later payment that pairs after a cancel corrects to its own amount', () => {
    const db = store([{ book: 'debate/primary', qty: 0.5 }], [{ amount: 16 }]);
    const ledger = new SqliteCashInLieuBooks(db, clock);
    applyAll(ledger, NEXT_DAY);
    read(db, { amount: 16, status: 'canceled', tradingDate: NEXT_DAY });
    read(db, { id: 'cil-2', amount: 17, tradingDate: NEXT_DAY });
    const [correction] = applyAll(ledger, '2026-10-05');
    expect(correction).toMatchObject({ activity_key: 'alpaca:cil-2:executed' });
    expect(correction?.amount_native).toBeCloseTo(1, 9);
    expect(bookedNative(db, 'est-0')).toBeCloseTo(2, 9);
  });

  it('writes nothing for a held-out pairing and leaves earlier corrections as booked (ruling (b))', () => {
    const db = store([{ book: 'debate/primary', qty: 0.5 }], [{ amount: 16 }]);
    const ledger = new SqliteCashInLieuBooks(db, clock);
    applyAll(ledger, NEXT_DAY);
    read(db, { id: 'cil-9', amount: 3, status: 'correct', tradingDate: NEXT_DAY });
    expect(ledger.pending('2026-10-05')).toEqual([]);
    expect(bookedNative(db, 'est-0')).toBeCloseTo(1, 9);
  });

  it.each([
    ['a qty the estimates do not hold', { amount: 16, qty: 0.7 }],
    ['the wrong sign for a sale', { amount: -16 }],
  ])('writes nothing for a payment with %s', (_name, row) => {
    const db = store([{ book: 'debate/primary', qty: 0.5 }], [row]);
    expect(new SqliteCashInLieuBooks(db, clock).pending(NEXT_DAY)).toEqual([]);
  });

  it('leaves shadow and control estimates at the latest close (ruling (c))', () => {
    const db = store(
      [
        { book: 'debate/primary', qty: 0.5 },
        { book: 'debate/no-macro-gate', qty: 0.5, outcome: 'simulated' },
      ],
      [{ amount: 16 }],
    );
    expect(new SqliteCashInLieuBooks(db, clock).pending(NEXT_DAY)).toEqual([
      expect.objectContaining({ book_id: 'debate/primary', amount_native: expect.closeTo(1, 9) }),
    ]);
  });

  it('corrects nothing on a CFD venue or for a payment matching the estimate', () => {
    const cfd = store([{ book: 'debate/primary', qty: 0.5, venue: 'saxo_cfd_usd' }], []);
    read(cfd, { amount: 16 });
    expect(new SqliteCashInLieuBooks(cfd, clock).pending(NEXT_DAY)).toEqual([]);
    const exact = store([{ book: 'debate/primary', qty: 0.5 }], [{ amount: 15 }]);
    expect(new SqliteCashInLieuBooks(exact, clock).pending(NEXT_DAY)).toEqual([]);
  });
});
