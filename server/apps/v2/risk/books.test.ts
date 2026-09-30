import { describe, expect, it } from 'vitest';
import type { BookFill, Sleeve, SleeveSpec } from '../../../../contracts/index.js';
import { saxoCustodyAccrual } from '../../../pipeline/momentum/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import type { StoreHandle } from '../../../shared/store/index.js';
import { openSharedStore } from '../../../shared/store/index.js';
import { bookSpecsFor } from './allocation.js';
import { PaperBooks } from './books.js';
import { CapitalConfigStore } from './capital-config.js';

const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));
const flat = () => undefined;

const DEBATE_SPEC: SleeveSpec = {
  capitalShare: 1,
  minimumCapitalGbp: 0,
  capacityGbp: Number.POSITIVE_INFINITY,
  validation: 'forward-paper',
  macroGate: true,
  sizing: {
    riskFraction: 0.005,
    stopAtrMultiple: 2,
    targetAtrMultiple: 3,
    timeStopTradingDays: 10,
    advShare: 0.01,
    advWindowBars: 20,
  },
  books: [
    { variant: 'primary', instantiated: true },
    { variant: 'no-macro-gate', instantiated: true },
    { variant: 'no-sentiment', instantiated: false },
    { variant: 'no-social', instantiated: false },
    { variant: 'large-cap-only', instantiated: false },
  ],
};
const DEBATE: readonly Pick<Sleeve, 'id' | 'spec'>[] = [{ id: 'debate', spec: DEBATE_SPEC }];

function seededStore(): StoreHandle {
  const db = openSharedStore(':memory:');
  const capital = new CapitalConfigStore(db, clock);
  for (const year of [2025, 2026, 2027]) capital.setYear(year, 1_000, 1_500);
  return db;
}

function openBooks(
  db: StoreHandle,
  openingDate = '2026-09-25',
  sleeves: readonly Pick<Sleeve, 'id' | 'spec'>[] = DEBATE,
): PaperBooks {
  return new PaperBooks(db, clock, new CapitalConfigStore(db, clock), openingDate, sleeves);
}

function fill(overrides: Partial<BookFill> = {}): BookFill {
  return {
    instrument: 'AAPL',
    venue: 'alpaca',
    side: 'buy',
    leg: 'entry',
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
  it('derives book ids from the sleeve and its declared variants, in declaration order', () => {
    expect(bookSpecsFor(DEBATE).map((spec) => [spec.id, spec.instantiated])).toEqual([
      ['debate/primary', true],
      ['debate/no-macro-gate', true],
      ['debate/no-sentiment', false],
      ['debate/no-social', false],
      ['debate/large-cap-only', false],
    ]);
  });

  it('opens no book for a sleeve whose minimum exceeds the start capital and caps a seed at capacity', () => {
    const db = seededStore();
    const books = openBooks(db, '2026-09-25', [
      { id: 'futures', spec: { ...DEBATE_SPEC, minimumCapitalGbp: 1_001 } },
      { id: 'small', spec: { ...DEBATE_SPEC, capacityGbp: 400 } },
    ]);
    expect(books.forSleeve('futures')).toEqual([]);
    expect(books.ids()).toEqual(['small/primary', 'small/no-macro-gate']);
    expect(books.cash('small/primary')).toBe(400);
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

  it('#1933: a mark counts toward the time stop on every venue but the paused ones, in this book only', () => {
    const books = openBooks(seededStore());
    const held = (bookId: string) =>
      books.positions(bookId).map((position) => [position.instrument, position.marksHeld]);
    books.applyFill('debate/primary', fill({ instrument: 'AAPL', venue: 'alpaca' }));
    books.applyFill('debate/primary', fill({ instrument: 'MSFT', venue: 'saxo_cfd_usd' }));
    books.applyFill('debate/primary', fill({ instrument: 'ISF', venue: 'saxo' }));
    books.applyFill('debate/primary', fill({ instrument: 'VOD', venue: 'saxo_cfd_gbp' }));
    books.applyFill('debate/no-macro-gate', fill({ instrument: 'AAPL', venue: 'alpaca' }));

    books.markDay('debate/primary', '2026-09-25', flat, 0);
    books.markDay('debate/primary', '2026-09-26', flat, 1, ['alpaca', 'saxo_cfd_usd']);
    books.markDay('debate/primary', '2026-09-27', flat, 1, []);
    books.markDay('debate/primary', '2026-09-28', flat, 1, ['saxo', 'saxo_cfd_gbp']);

    expect(held('debate/primary')).toEqual([
      ['AAPL', 3],
      ['ISF', 3],
      ['MSFT', 3],
      ['VOD', 3],
    ]);
    books.markDay('debate/primary', '2026-09-29', flat, 1, ['alpaca']);
    expect(held('debate/primary')).toEqual([
      ['AAPL', 3],
      ['ISF', 4],
      ['MSFT', 4],
      ['VOD', 4],
    ]);
    expect(held('debate/no-macro-gate')).toEqual([['AAPL', 0]]);
  });

  it('prices a position that flips through zero at the flipping fill', () => {
    const books = openBooks(seededStore());
    books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 100 }));
    expect(
      books.applyFill('debate/primary', fill({ side: 'sell', qty: 5, priceGbp: 120 })),
    ).toMatchObject({ qty: -3, avgPriceGbp: 120, marksHeld: 0, exitClientOrderId: undefined });
    expect(books.applyFill('debate/primary', fill({ qty: 1, priceGbp: 110 }))).toMatchObject({
      qty: -2,
      avgPriceGbp: 120,
    });
  });

  it('#1778: a flip takes the new stop/target from the flipping fill, not the stale long ones', () => {
    const books = openBooks(seededStore());
    books.applyFill(
      'debate/primary',
      fill({ qty: 10, priceGbp: 100, stopGbp: 95, targetGbp: 115 }),
    );
    expect(
      books.applyFill(
        'debate/primary',
        fill({ side: 'sell', qty: 15, priceGbp: 110, stopGbp: 112, targetGbp: 90 }),
      ),
    ).toMatchObject({ qty: -5, avgPriceGbp: 110, stopGbp: 112, targetGbp: 90 });
  });

  it('#1778: a flip fill carrying no stop/target opens the new side unbracketed, not stale', () => {
    const books = openBooks(seededStore());
    books.applyFill(
      'debate/primary',
      fill({ qty: 10, priceGbp: 100, stopGbp: 95, targetGbp: 115 }),
    );
    expect(
      books.applyFill(
        'debate/primary',
        fill({ side: 'sell', qty: 15, priceGbp: 110, stopGbp: undefined, targetGbp: undefined }),
      ),
    ).toMatchObject({ qty: -5, avgPriceGbp: 110, stopGbp: undefined, targetGbp: undefined });
  });

  it('#1831: a crossing fill marks the position stray atomically, and it persists across a same-side resize and clears on the next clean reopen', () => {
    const books = openBooks(seededStore());
    books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 100 }));
    expect(
      books.applyFill(
        'debate/primary',
        fill({ side: 'sell', qty: 5, priceGbp: 110, leg: 'stop', clientOrderId: 'o-stop' }),
      ),
    ).toMatchObject({ qty: -3, stray: true });

    books.applyFill(
      'debate/primary',
      fill({ side: 'sell', qty: 1, priceGbp: 110, clientOrderId: 'o3' }),
    );
    expect(books.position('debate/primary', 'AAPL')).toMatchObject({ qty: -4, stray: true });

    books.applyFill('debate/primary', fill({ qty: 4, priceGbp: 110, clientOrderId: 'o4' }));
    expect(books.positions('debate/primary')).toEqual([]);

    expect(
      books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 100, clientOrderId: 'o5' })),
    ).toMatchObject({ stray: false });
  });

  it('#1865: applySplit rescales qty and every price level atomically and leaves equity untouched', () => {
    const books = openBooks(seededStore());
    books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 100, feeGbp: 1 }));
    const cashBefore = books.cash('debate/primary');
    const equityBefore = books.valuation('debate/primary', () => 110).equityGbp;
    books.applySplit('debate/primary', 'AAPL', 10, '2026-09-26');
    expect(books.position('debate/primary', 'AAPL')).toMatchObject({
      qty: 20,
      avgPriceGbp: 10,
      stopGbp: 9.6,
      targetGbp: 10.6,
      splitFactor: 10,
      splitAnchorDate: '2026-09-26',
      marksHeld: 0,
      openedDate: '2026-09-25',
    });
    expect(books.cash('debate/primary')).toBe(cashBefore);
    expect(books.valuation('debate/primary', () => 11).equityGbp).toBeCloseTo(equityBefore, 9);
  });

  it('#1865: applySplit keeps qty x avgPrice for a 3:2 split (fractional qty) and a reverse split', () => {
    const books = openBooks(seededStore());
    books.applyFill('debate/primary', fill({ qty: 3, priceGbp: 90 }));
    books.applySplit('debate/primary', 'AAPL', 1.5, '2026-09-26');
    const held = books.position('debate/primary', 'AAPL');
    expect(held?.qty).toBeCloseTo(4.5, 12);
    expect(held?.avgPriceGbp).toBeCloseTo(60, 12);
    expect((held?.qty ?? 0) * (held?.avgPriceGbp ?? 0)).toBeCloseTo(270, 9);
    books.applySplit('debate/primary', 'AAPL', 0.1, '2026-09-29');
    const reversed = books.position('debate/primary', 'AAPL');
    expect(reversed?.qty).toBeCloseTo(0.45, 12);
    expect(reversed?.avgPriceGbp).toBeCloseTo(600, 9);
    expect(reversed?.splitFactor).toBeCloseTo(0.15, 12);
    expect(reversed?.splitAnchorDate).toBe('2026-09-29');
  });

  it('#1865: applySplit mirrors a short and leaves absent levels absent', () => {
    const books = openBooks(seededStore());
    books.applyFill(
      'debate/primary',
      fill({ side: 'sell', qty: 6, priceGbp: 50, stopGbp: undefined, targetGbp: undefined }),
    );
    books.applySplit('debate/primary', 'AAPL', 2, '2026-09-26');
    expect(books.position('debate/primary', 'AAPL')).toMatchObject({
      qty: -12,
      avgPriceGbp: 25,
      stopGbp: undefined,
      targetGbp: undefined,
    });
  });

  it('#1865: applySplit survives a restart and is undone by a fresh open, not by a resize', () => {
    const db = seededStore();
    const books = openBooks(db);
    books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 100 }));
    books.applySplit('debate/primary', 'AAPL', 2, '2026-09-26');
    books.applyFill('debate/primary', fill({ qty: 2, priceGbp: 60, clientOrderId: 'o2' }));
    expect(openBooks(db).position('debate/primary', 'AAPL')).toMatchObject({
      qty: 6,
      splitFactor: 2,
      splitAnchorDate: '2026-09-26',
    });
    books.applyFill('debate/primary', fill({ side: 'sell', qty: 6, priceGbp: 60 }));
    expect(
      books.applyFill('debate/primary', fill({ qty: 1, priceGbp: 60, clientOrderId: 'o3' })),
    ).toMatchObject({ splitFactor: 1, splitAnchorDate: undefined });
  });

  it('#1865: a position row written before the split columns existed reads as unsplit, unanchored', () => {
    const db = seededStore();
    const books = openBooks(db);
    db.prepare(
      `INSERT INTO v2_positions (book_id, instrument, venue, qty, avg_price_gbp, stop_gbp, target_gbp,
         client_order_id, exit_client_order_id, opened_date, marks_held, stray, updated_at)
       VALUES ('debate/primary', 'AAPL', 'alpaca', 2, 100, 96, 106, 'o1', NULL, '2026-09-25', 0, 0, 't')`,
    ).run();
    expect(books.position('debate/primary', 'AAPL')).toMatchObject({
      splitFactor: 1,
      splitAnchorDate: undefined,
    });
  });

  it('#1865: applySplit refuses an unknown position', () => {
    const books = openBooks(seededStore());
    expect(() => books.applySplit('debate/primary', 'AAPL', 2, '2026-09-26')).toThrow(
      /no AAPL position/,
    );
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
    books.clearExitPending('debate/primary', 'AAPL');
    expect(books.position('debate/primary', 'AAPL')?.exitClientOrderId).toBeUndefined();
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

  it('accrues no Saxo custody on a CFD position, long or short, but still counts its notional invested', () => {
    for (const venue of ['saxo_cfd_gbp', 'saxo_cfd_usd'] as const) {
      const db = seededStore();
      const books = openBooks(db);
      books.applyFill(
        'debate/primary',
        fill({ instrument: 'VOD', venue, side: 'sell', qty: 10, priceGbp: 36.5 }),
      );
      expect(books.valuation('debate/primary', () => 36.5)).toMatchObject({
        investedGbp: 365,
        investedSaxoGbp: 0,
      });
      const day = books.markDay('debate/primary', '2026-09-25', () => 36.5, 1);
      expect(day.custodyAccrualGbp).toBe(0);
    }
  });

  it('accrues CFD financing and borrow beside custody, deducts them from cash and journals both', () => {
    const db = seededStore();
    const books = new PaperBooks(
      db,
      clock,
      new CapitalConfigStore(db, clock),
      '2026-09-25',
      DEBATE,
      {
        financing: { dailyRate: (_venue, side) => (side === 'long' ? 0.001 : 0.0001) },
        borrow: { dailyRate: (_venue, quoted) => quoted ?? 0 },
        quotedBorrowPerDay: (instrument) => (instrument === 'TSLA' ? 0.0002 : undefined),
      },
    );
    books.applyFill(
      'debate/primary',
      fill({ instrument: 'TSLA', venue: 'saxo_cfd_usd', side: 'sell', qty: 1 }),
    );
    books.applyFill(
      'debate/primary',
      fill({ instrument: 'VOD', venue: 'saxo_cfd_gbp', qty: 2, clientOrderId: 'o2' }),
    );
    const cashBefore = books.cash('debate/primary');
    const day = books.markDay('debate/primary', '2026-09-25', () => 100, 3);
    expect(day.cfdFinancingAccrualGbp).toBeCloseTo(200 * 0.001 * 3 + 100 * 0.0001 * 3, 12);
    expect(day.cfdBorrowAccrualGbp).toBeCloseTo(100 * 0.0002 * 3, 12);
    const carried = day.cfdFinancingAccrualGbp + day.cfdBorrowAccrualGbp;
    expect(books.cash('debate/primary')).toBeCloseTo(cashBefore - carried, 9);
    expect(day.equityGbp).toBeCloseTo(1_000 - carried, 9);
    expect(books.lastDay('debate/primary')).toMatchObject({
      cfdFinancingAccrualGbp: day.cfdFinancingAccrualGbp,
      cfdBorrowAccrualGbp: day.cfdBorrowAccrualGbp,
    });
  });

  it('journals zero CFD carry when no carry rates are wired', () => {
    const db = seededStore();
    const books = openBooks(db);
    books.applyFill('debate/primary', fill({ venue: 'saxo_cfd_usd', side: 'sell', qty: 1 }));
    const day = books.markDay('debate/primary', '2026-09-25', () => 100, 1);
    expect(day).toMatchObject({ cfdFinancingAccrualGbp: 0, cfdBorrowAccrualGbp: 0 });
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

  it('seeds each sleeve at its share and steps a book against that share of the loss cap', () => {
    const db = openSharedStore(':memory:');
    new CapitalConfigStore(db, clock).setYear(2026, 2_000, 1_500);
    const books = openBooks(db, '2026-09-25', [
      { id: 'debate', spec: { ...DEBATE_SPEC, capitalShare: 0.3 } },
      { id: 'trend', spec: { ...DEBATE_SPEC, capitalShare: 0.7 } },
    ]);
    expect(books.cash('debate/primary')).toBe(600);
    expect(books.cash('trend/primary')).toBe(1_400);
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
    expect(lose('2026-09-14', 5, 'a')).toMatchObject({
      sizeMultiplier: 1,
      entriesBlockedAtNextFill: false,
    });
    expect(books.lastDay('debate/primary')?.state.entriesBlockedAtNextFill).toBe(false);
    expect(lose('2026-09-15', 6, 'b')).toMatchObject({
      sizeMultiplier: 1,
      entriesBlockedAtNextFill: true,
    });
    expect(lose('2026-09-16', 138, 'c').sizeMultiplier).toBe(1);
    expect(lose('2026-09-17', 1, 'd').sizeMultiplier).toBe(0.5);
    expect(lose('2026-09-18', 150, 'e').sizeMultiplier).toBe(0.25);
    expect(lose('2026-09-21', 150, 'f')).toMatchObject({ halted: true, ytdLossGbp: 450 });
    expect(books.markDay('trend/primary', '2026-09-21', flat, 1).state).toMatchObject({
      halted: false,
      sizeMultiplier: 1,
    });
  });

  describe('per-sleeve loss budgets (David 2026-09-30, #1941)', () => {
    const SLEEVES: readonly Pick<Sleeve, 'id' | 'spec'>[] = [
      { id: 'signals', spec: { ...DEBATE_SPEC, capitalShare: 0.7 } },
      { id: 'debate', spec: { ...DEBATE_SPEC, capitalShare: 0.3 } },
    ];
    const tenThousand = (openingDate = '2026-09-24') => {
      const db = openSharedStore(':memory:');
      new CapitalConfigStore(db, clock).setYear(2026, 10_000, 1_500);
      const books = openBooks(db, openingDate, SLEEVES);
      for (const id of ['signals/primary', 'debate/primary']) {
        books.markDay(id, '2026-09-24', flat, 0);
      }
      return books;
    };
    const lose = (books: PaperBooks, bookId: string, loss: number, date = '2026-09-25') => {
      books.applyFill(bookId, fill({ qty: 1, priceGbp: 100 + loss, clientOrderId: bookId }));
      books.applyFill(bookId, fill({ side: 'sell', qty: 1, priceGbp: 100, clientOrderId: bookId }));
      return books.markDay(bookId, date, flat, 1).state;
    };

    it('seeds each primary with its own share of the start capital', () => {
      const books = tenThousand();
      expect(books.cash('signals/primary')).toBe(7_000);
      expect(books.cash('debate/primary')).toBe(3_000);
    });

    it("steps signals down at a third of its £1,050 cap and leaves debate's sizing alone", () => {
      const books = tenThousand();
      expect(lose(books, 'signals/primary', 349)).toMatchObject({ sizeMultiplier: 1 });
      expect(lose(books, 'signals/primary', 1, '2026-09-28')).toMatchObject({
        sizeMultiplier: 0.5,
        ytdLossGbp: 350,
      });
      expect(books.markDay('debate/primary', '2026-09-25', flat, 1).state).toMatchObject({
        sizeMultiplier: 1,
        entriesBlockedAtNextFill: false,
      });
    });

    it("steps debate down at a third of its £450 cap and leaves signals' sizing alone", () => {
      const books = tenThousand();
      expect(lose(books, 'debate/primary', 150)).toMatchObject({ sizeMultiplier: 0.5 });
      expect(books.markDay('signals/primary', '2026-09-25', flat, 1).state).toMatchObject({
        sizeMultiplier: 1,
        entriesBlockedAtNextFill: false,
      });
    });

    it('halts signals at its own £1,050 cap while debate keeps trading', () => {
      const books = tenThousand();
      expect(lose(books, 'signals/primary', 1_050)).toMatchObject({ halted: true });
      expect(lose(books, 'debate/primary', 299)).toMatchObject({
        halted: false,
        sizeMultiplier: 0.5,
      });
    });

    it("blocks entries at each sleeve's own daily cap: £70 for signals, £30 for debate", () => {
      const under = tenThousand();
      expect(lose(under, 'signals/primary', 69).entriesBlockedAtNextFill).toBe(false);
      expect(lose(under, 'debate/primary', 29).entriesBlockedAtNextFill).toBe(false);
      const at = tenThousand();
      expect(lose(at, 'signals/primary', 70).entriesBlockedAtNextFill).toBe(true);
      expect(lose(at, 'debate/primary', 30).entriesBlockedAtNextFill).toBe(true);
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

  it('reopens existing books with no capital in force or a sleeve now below its minimum', () => {
    const db = seededStore();
    openBooks(db).applyFill('debate/primary', fill());
    const noCapital = openBooks(db, '2030-01-02');
    expect(noCapital.ids()).toEqual(['debate/primary', 'debate/no-macro-gate']);
    expect(noCapital.position('debate/primary', 'AAPL')?.qty).toBe(2);
    const belowMinimum = openBooks(db, '2026-09-28', [
      { id: 'debate', spec: { ...DEBATE_SPEC, minimumCapitalGbp: 5_000 } },
    ]);
    expect(belowMinimum.cash('debate/primary')).toBe(800);
    db.close();
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
