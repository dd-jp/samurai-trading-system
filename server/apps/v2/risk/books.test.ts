import { describe, expect, it } from 'vitest';
import type { BookFill } from '../../../../contracts/index.js';
import { saxoCustodyAccrual } from '../../../pipeline/momentum/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { BOOK_SPECS, PaperBooks } from './books.js';
import { CapitalConfigStore } from './capital-config.js';

const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));
const flat = () => undefined;

function seededStore(): StoreHandle {
  const db = openSharedStore(':memory:');
  const capital = new CapitalConfigStore(db, clock);
  for (const year of [2025, 2026, 2027]) capital.setYear(year, 1_000, 1_500);
  return db;
}

function openBooks(db: StoreHandle, openingDate = '2026-09-25'): PaperBooks {
  return new PaperBooks(db, clock, new CapitalConfigStore(db, clock), openingDate);
}

function fill(overrides: Partial<BookFill> = {}): BookFill {
  return {
    instrument: 'AAPL',
    venue: 'alpaca',
    side: 'buy',
    qty: 2,
    priceGbp: 100,
    feeGbp: 0,
    clientOrderId: 'o1',
    tradingDate: '2026-09-25',
    stopGbp: 96,
    targetGbp: 106,
    ...overrides,
  };
}

describe('PaperBooks', () => {
  it('instantiates the primary and the no-macro-gate shadow only; the G18 shadows and momentum are declared', () => {
    expect(BOOK_SPECS.map((spec) => [spec.id, spec.instantiated])).toEqual([
      ['debate/primary', true],
      ['debate/no-macro-gate', true],
      ['debate/no-sentiment', false],
      ['debate/no-social', false],
      ['debate/large-cap-only', false],
      ['momentum/no-veto', false],
    ]);
  });

  it('creates one v2_books row per instantiated book at start cash and is idempotent', () => {
    const db = seededStore();
    const first = openBooks(db);
    const second = openBooks(db);
    expect(first.ids()).toEqual(second.ids());
    expect(first.ids()).toEqual(['debate/primary', 'debate/no-macro-gate']);
    const count = db.prepare('SELECT COUNT(*) AS n FROM v2_books').get() as { n: number };
    expect(count.n).toBe(2);
    expect(first.forSleeve('momentum')).toEqual([]);
    expect(first.forSleeve('debate')).toHaveLength(2);
    expect(first.cash('debate/primary')).toBe(1_000);
    expect(() => first.cash('nope')).toThrow(/unknown book/);
  });

  it('applies fills to cash and positions, averages adds, and closes on the opposite side', () => {
    const db = seededStore();
    const books = openBooks(db);
    const opened = books.applyFill('debate/primary', fill({ feeGbp: 1 }));
    expect(opened).toMatchObject({
      instrument: 'AAPL',
      qty: 2,
      avgPriceGbp: 100,
      stopGbp: 96,
      targetGbp: 106,
      openedDate: '2026-09-25',
      marksHeld: 0,
      exitClientOrderId: undefined,
    });
    expect(books.cash('debate/primary')).toBe(799);
    books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 110, clientOrderId: 'o2' }));
    expect(books.position('debate/primary', 'AAPL')).toMatchObject({ qty: 4, avgPriceGbp: 105 });
    expect(books.cash('debate/primary')).toBe(579);
    expect(
      books.applyFill('debate/primary', fill({ side: 'sell', qty: 1, priceGbp: 120 })),
    ).toMatchObject({
      qty: 3,
      avgPriceGbp: 105,
    });
    expect(
      books.applyFill('debate/primary', fill({ side: 'sell', qty: 3, priceGbp: 120 })),
    ).toBeUndefined();
    expect(books.positions('debate/primary')).toEqual([]);
    expect(books.cash('debate/primary')).toBe(1_059);
    expect(books.valuation('debate/primary', flat)).toEqual({
      equityGbp: 1_059,
      investedGbp: 0,
      investedSaxoGbp: 0,
    });
    expect(() => books.applyFill('nope', fill())).toThrow(/unknown book/);
  });

  it('prices a position that flips through zero at the flipping fill', () => {
    const books = openBooks(seededStore());
    books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 100 }));
    expect(
      books.applyFill('debate/primary', fill({ side: 'sell', qty: 5, priceGbp: 120 })),
    ).toMatchObject({ qty: -3, avgPriceGbp: 120 });
    expect(books.applyFill('debate/primary', fill({ qty: 1, priceGbp: 110 }))).toMatchObject({
      qty: -2,
      avgPriceGbp: 120,
    });
  });

  it('values positions at the mark, falls back to the entry price, and holds shorts as negative qty', () => {
    const db = seededStore();
    const books = openBooks(db);
    books.applyFill('debate/primary', fill({ side: 'sell', qty: 2, priceGbp: 100 }));
    expect(books.position('debate/primary', 'AAPL')?.qty).toBe(-2);
    expect(books.valuation('debate/primary', () => 90)).toEqual({
      equityGbp: 1_020,
      investedGbp: 180,
      investedSaxoGbp: 0,
    });
    expect(books.valuation('debate/primary', flat).equityGbp).toBe(1_000);
    books.applyFill(
      'debate/primary',
      fill({ instrument: 'CSP1', venue: 'saxo', qty: 1, priceGbp: 50 }),
    );
    expect(books.valuation('debate/primary', () => 50)).toMatchObject({ investedSaxoGbp: 50 });
    books.setExitPending('debate/primary', 'AAPL', 'x1');
    expect(books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBe('x1');
  });

  it('marks a day from positions, counts marks held, deducts Saxo custody and blocks entries on the daily cap', () => {
    const db = seededStore();
    const books = openBooks(db);
    const day1 = books.markDay('debate/primary', '2026-09-24', flat, 0);
    expect(day1).toMatchObject({ equityGbp: 1_000, cashGbp: 1_000, investedGbp: 0 });
    expect(day1.state).toMatchObject({ sizeMultiplier: 1, entriesBlockedAtNextFill: false });
    books.applyFill(
      'debate/primary',
      fill({ instrument: 'CSP1', venue: 'saxo', qty: 10, priceGbp: 36.5 }),
    );
    const day2 = books.markDay('debate/primary', '2026-09-25', () => 35, 1);
    const custody = saxoCustodyAccrual(350, 1);
    expect(custody).toBeGreaterThan(0);
    expect(day2.custodyAccrualGbp).toBeCloseTo(custody, 12);
    expect(day2.equityGbp).toBeCloseTo(985 - custody, 9);
    expect(day2.investedGbp).toBe(350);
    expect(day2.state.entriesBlockedAtNextFill).toBe(true);
    expect(day2.state.sizeMultiplier).toBe(1);
    expect(books.position('debate/primary', 'CSP1')?.marksHeld).toBe(1);
    expect(books.lastDay('debate/primary')).toMatchObject({
      tradingDate: '2026-09-25',
      cashGbp: expect.closeTo(635 - custody, 9),
      recordedAt: '2026-09-25T12:00:00.000Z',
      state: { entriesBlockedAtNextFill: true, halted: false, sizeMultiplier: 1 },
    });
    expect(books.lastDay('debate/no-macro-gate')).toBeUndefined();
    expect(books.isMarked('2026-09-25')).toBe(true);
    expect(books.isMarked('2026-09-26')).toBe(false);
  });

  it('steps size down as a losing fill sequence crosses the loss-budget thresholds and halts at the third', () => {
    const db = seededStore();
    const books = openBooks(db);
    const lose = (date: string, loss: number, orderId: string) => {
      books.applyFill(
        'debate/primary',
        fill({ qty: 1, priceGbp: 100 + loss, clientOrderId: orderId }),
      );
      books.applyFill(
        'debate/primary',
        fill({ side: 'sell', qty: 1, priceGbp: 100, clientOrderId: orderId }),
      );
      return books.markDay('debate/primary', date, flat, 1).state;
    };
    expect(lose('2026-09-21', 499, 'a').sizeMultiplier).toBe(1);
    expect(lose('2026-09-22', 1, 'b').sizeMultiplier).toBe(0.5);
    expect(books.cash('debate/primary')).toBe(500);
    expect(lose('2026-09-23', 500, 'c').sizeMultiplier).toBe(0.25);
    expect(lose('2026-09-24', 500, 'd')).toMatchObject({
      sizeMultiplier: 0,
      halted: true,
      entriesBlockedAtNextFill: true,
      ytdLossGbp: 1_500,
    });
    expect(books.lastDay('debate/primary')?.state).toMatchObject({
      halted: true,
      sizeMultiplier: 0,
    });
  });

  it('resets the reference equity at the calendar year boundary', () => {
    const db = seededStore();
    const books = openBooks(db);
    books.applyFill('debate/primary', fill({ qty: 6, priceGbp: 100 }));
    books.applyFill('debate/primary', fill({ side: 'sell', qty: 6, priceGbp: 0 }));
    books.markDay('debate/primary', '2026-12-31', flat, 0);
    const newYear = books.markDay('debate/primary', '2027-01-04', flat, 0);
    expect(newYear.equityGbp).toBe(400);
    expect(newYear.state.ytdLossGbp).toBe(0);
    expect(newYear.state.sizeMultiplier).toBe(1);
  });

  it('replays the year roll so a loss taken before a restart is measured from the new year reference', () => {
    const db = seededStore();
    const first = openBooks(db);
    first.applyFill('debate/primary', fill({ qty: 1, priceGbp: 500 }));
    first.applyFill('debate/primary', fill({ side: 'sell', qty: 1, priceGbp: 0 }));
    first.markDay('debate/primary', '2026-12-31', flat, 0);
    first.markDay('debate/primary', '2027-01-04', flat, 0);
    const second = openBooks(db);
    second.applyFill('debate/primary', fill({ qty: 1, priceGbp: 100, clientOrderId: 'b' }));
    second.applyFill(
      'debate/primary',
      fill({ side: 'sell', qty: 1, priceGbp: 0, clientOrderId: 'b' }),
    );
    expect(second.markDay('debate/primary', '2027-01-05', flat, 1).state).toMatchObject({
      referenceEquityGbp: 500,
      ytdLossGbp: 100,
      sizeMultiplier: 1,
    });
    db.close();
  });

  it('refuses to mark a date at or before the last mark and an unknown book', () => {
    const db = seededStore();
    const books = openBooks(db);
    books.markDay('debate/primary', '2026-09-25', flat, 0);
    expect(() => books.markDay('debate/primary', '2026-09-25', flat, 0)).toThrow(/already marked/);
    expect(() => books.markDay('nope', '2026-09-26', flat, 0)).toThrow(/unknown book/);
    expect(books.lastDay('nope')).toBeUndefined();
  });

  it('rehydrates cash, positions and the loss budget so a halt and the year reset survive a restart', () => {
    const db = seededStore();
    const first = openBooks(db);
    const lose = (books: PaperBooks, bookId: string, loss: number, orderId: string) => {
      books.applyFill(bookId, fill({ qty: 1, priceGbp: 100 + loss, clientOrderId: orderId }));
      books.applyFill(
        bookId,
        fill({ side: 'sell', qty: 1, priceGbp: 100, clientOrderId: orderId }),
      );
    };
    lose(first, 'debate/primary', 100, 'a');
    first.markDay('debate/primary', '2025-12-30', flat, 0);
    lose(first, 'debate/primary', 20, 'b');
    first.markDay('debate/primary', '2025-12-31', flat, 1);
    lose(first, 'debate/no-macro-gate', 300, 'c');
    first.markDay('debate/no-macro-gate', '2025-12-31', flat, 0);
    first.applyFill('debate/no-macro-gate', fill({ instrument: 'MSFT', qty: 1, priceGbp: 50 }));
    const second = openBooks(db);
    expect(second.cash('debate/primary')).toBe(880);
    expect(second.position('debate/no-macro-gate', 'MSFT')?.qty).toBe(1);
    expect(second.lastDay('debate/primary')?.state).toMatchObject({
      referenceEquityGbp: 1_000,
      ytdLossGbp: 120,
      halted: false,
    });
    lose(second, 'debate/primary', 10, 'd');
    expect(second.markDay('debate/primary', '2026-01-02', flat, 2).state).toMatchObject({
      referenceEquityGbp: 880,
      ytdLossGbp: 10,
      sizeMultiplier: 1,
      halted: false,
    });
    expect(second.lastDay('debate/primary')?.state.referenceEquityGbp).toBe(880);
    expect(second.markDay('debate/no-macro-gate', '2026-01-02', () => 50, 2).state).toMatchObject({
      referenceEquityGbp: 700,
      ytdLossGbp: 0,
    });
    const third = openBooks(db);
    lose(third, 'debate/primary', 1_570, 'e');
    third.markDay('debate/primary', '2026-01-05', flat, 3);
    const fourth = openBooks(db);
    expect(fourth.lastDay('debate/primary')?.state.halted).toBe(true);
    fourth.applyFill(
      'debate/primary',
      fill({ side: 'sell', qty: 1, priceGbp: 0, clientOrderId: 'f' }),
    );
    fourth.applyFill('debate/primary', fill({ qty: 1, priceGbp: -2_700, clientOrderId: 'f' }));
    expect(fourth.markDay('debate/primary', '2026-01-06', flat, 1).state).toMatchObject({
      halted: true,
      sizeMultiplier: 0,
    });
    expect(fourth.isMarked('2026-01-06')).toBe(true);
    expect(fourth.isMarked('2026-01-07')).toBe(false);
    db.close();
  });

  it("opens no book before a capital config is in force, then seeds books at that year's start capital", () => {
    const db = openSharedStore(':memory:');
    expect(openBooks(db).ids()).toEqual([]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM v2_books').get() as { n: number };
    expect(count.n).toBe(0);
    new CapitalConfigStore(db, clock).setYear(2026, 2_000, 1_500);
    const books = openBooks(db);
    expect(books.ids()).toEqual(['debate/primary', 'debate/no-macro-gate']);
    expect(books.cash('debate/primary')).toBe(2_000);
    expect(books.markDay('debate/primary', '2026-09-25', flat, 0).state).toMatchObject({
      referenceEquityGbp: 2_000,
      sizeMultiplier: 1,
    });
  });

  it('refuses to mark a day no capital config covers', () => {
    const db = openSharedStore(':memory:');
    new CapitalConfigStore(db, clock).setYear(2026, 1_000, 1_500);
    const books = openBooks(db);
    expect(() => books.markDay('debate/primary', '2025-12-31', flat, 0)).toThrow(/capital/);
  });

  it('steps against a tightened cap from its effective date without rewriting earlier days', () => {
    const db = seededStore();
    const books = openBooks(db);
    books.applyFill('debate/primary', fill({ qty: 1, priceGbp: 500, clientOrderId: 'a' }));
    books.applyFill(
      'debate/primary',
      fill({ side: 'sell', qty: 1, priceGbp: 100, clientOrderId: 'a' }),
    );
    expect(books.markDay('debate/primary', '2026-09-24', flat, 1).state.sizeMultiplier).toBe(1);
    new CapitalConfigStore(db, clock).tighten('2026-09-25', 900);
    expect(books.markDay('debate/primary', '2026-09-25', flat, 1).state).toMatchObject({
      sizeMultiplier: 0.5,
      ytdLossGbp: 400,
    });
    const reopened = openBooks(db, '2026-09-26');
    expect(reopened.lastDay('debate/primary')?.state.sizeMultiplier).toBe(0.5);
    const rows = db
      .prepare(
        "SELECT trading_date, size_multiplier FROM v2_book_days WHERE book_id = 'debate/primary' ORDER BY trading_date",
      )
      .all();
    expect(rows).toEqual([
      { trading_date: '2026-09-24', size_multiplier: 1 },
      { trading_date: '2026-09-25', size_multiplier: 0.5 },
    ]);
  });
});
