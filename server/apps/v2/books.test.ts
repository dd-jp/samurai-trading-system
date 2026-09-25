import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { BOOK_SPECS, PaperBooks, START_CAPITAL_GBP } from './books.js';

const clock = new SimulatedClock(new Date('2026-09-25T12:00:00.000Z'));

describe('PaperBooks', () => {
  it('declares the primary, four debate shadows and the uninstantiated momentum shadow', () => {
    expect(BOOK_SPECS.map((spec) => spec.id)).toEqual([
      'debate/primary',
      'debate/no-macro-gate',
      'debate/no-sentiment',
      'debate/no-social',
      'debate/large-cap-only',
      'momentum/no-veto',
    ]);
    expect(BOOK_SPECS.find((spec) => spec.id === 'momentum/no-veto')?.instantiated).toBe(false);
    expect(START_CAPITAL_GBP).toBe(1_000);
  });

  it('creates one v2_books row per instantiated book and is idempotent', () => {
    const db = openSharedStore(':memory:');
    const first = new PaperBooks(db, clock);
    const second = new PaperBooks(db, clock);
    expect(first.ids()).toEqual(second.ids());
    expect(first.ids()).not.toContain('momentum/no-veto');
    const count = db.prepare('SELECT COUNT(*) AS n FROM v2_books').get() as { n: number };
    expect(count.n).toBe(5);
    expect(first.forSleeve('momentum')).toEqual([]);
    expect(first.forSleeve('debate')).toHaveLength(5);
  });

  it('marks a day through the loss budget, deducts custody and blocks entries on the daily cap', () => {
    const db = openSharedStore(':memory:');
    const books = new PaperBooks(db, clock);
    const day1 = books.markDay('debate/primary', '2026-09-24', 1_000, 0, 1);
    expect(day1.state).toMatchObject({ sizeMultiplier: 1, entriesBlockedAtNextFill: false });
    expect(day1.custodyAccrualGbp).toBe(0);

    const day2 = books.markDay('debate/primary', '2026-09-25', 985, 365, 1);
    expect(day2.custodyAccrualGbp).toBeCloseTo(0.0012, 9);
    expect(day2.equityGbp).toBeCloseTo(984.9988, 6);
    expect(day2.state.entriesBlockedAtNextFill).toBe(true);
    expect(day2.state.sizeMultiplier).toBe(1);
    expect(books.lastDay('debate/primary')?.tradingDate).toBe('2026-09-25');
    expect(books.lastDay('debate/primary')?.state).toMatchObject({
      entriesBlockedAtNextFill: true,
      halted: false,
      sizeMultiplier: 1,
      ytdLossGbp: day2.state.ytdLossGbp,
    });
    expect(books.lastDay('debate/no-social')).toBeUndefined();
    books.markDay('debate/no-social', '2026-09-25', 1_000, 0, 0);
    expect(books.lastDay('debate/no-social')?.state).toMatchObject({
      entriesBlockedAtNextFill: false,
      halted: false,
    });
  });

  it('steps size down at the loss-budget thresholds and halts at the third', () => {
    const db = openSharedStore(':memory:');
    const books = new PaperBooks(db, clock);
    expect(books.markDay('debate/primary', '2026-09-21', 501, 0, 0).state.sizeMultiplier).toBe(1);
    expect(books.markDay('debate/primary', '2026-09-22', 500, 0, 0).state.sizeMultiplier).toBe(0.5);
    expect(books.markDay('debate/primary', '2026-09-23', 0, 0, 0).state.sizeMultiplier).toBe(0.25);
    expect(books.markDay('debate/primary', '2026-09-24', -500, 0, 0).state).toMatchObject({
      sizeMultiplier: 0,
      halted: true,
      entriesBlockedAtNextFill: true,
    });
    expect(books.lastDay('debate/primary')?.state).toMatchObject({
      halted: true,
      sizeMultiplier: 0,
    });
  });

  it('resets the reference equity at the calendar year boundary', () => {
    const db = openSharedStore(':memory:');
    const books = new PaperBooks(db, clock);
    books.markDay('debate/primary', '2026-12-31', 400, 0, 0);
    const newYear = books.markDay('debate/primary', '2027-01-04', 400, 0, 0);
    expect(newYear.state.ytdLossGbp).toBe(0);
    expect(newYear.state.sizeMultiplier).toBe(1);
  });

  it('refuses to mark a date at or before the last mark and an unknown book', () => {
    const db = openSharedStore(':memory:');
    const books = new PaperBooks(db, clock);
    books.markDay('debate/primary', '2026-09-25', 1_000, 0, 0);
    expect(() => books.markDay('debate/primary', '2026-09-25', 1_000, 0, 0)).toThrow(
      /already marked/,
    );
    expect(() => books.markDay('nope', '2026-09-26', 1_000, 0, 0)).toThrow(/unknown book/);
    expect(books.lastDay('nope')).toBeUndefined();
  });

  it('rehydrates the loss budget from journalled days so a halt and the year reset survive a restart', () => {
    const db = openSharedStore(':memory:');
    const first = new PaperBooks(db, clock);
    first.markDay('debate/primary', '2025-12-30', 900, 0, 0);
    first.markDay('debate/primary', '2025-12-31', 880, 0, 1);
    first.markDay('debate/no-social', '2025-12-31', -600, 0, 0);
    first.markDay('debate/no-sentiment', '2025-12-31', 700, 0, 0);
    first.markDay('debate/no-sentiment', '2026-01-02', 690, 0, 2);
    const second = new PaperBooks(db, clock);
    expect(second.lastDay('debate/primary')?.state).toMatchObject({
      referenceEquityGbp: 1_000,
      halted: false,
    });
    expect(second.lastDay('debate/no-sentiment')?.state.referenceEquityGbp).toBe(700);
    expect(second.markDay('debate/no-sentiment', '2026-01-05', 680, 0, 3).state).toMatchObject({
      referenceEquityGbp: 700,
      ytdLossGbp: 20,
    });
    expect(second.markDay('debate/primary', '2026-01-02', 870, 0, 2).state).toMatchObject({
      referenceEquityGbp: 880,
      ytdLossGbp: 10,
      sizeMultiplier: 1,
      halted: false,
    });
    expect(second.lastDay('debate/primary')?.state.referenceEquityGbp).toBe(880);
    expect(second.markDay('debate/no-social', '2026-01-02', 2_000, 0, 2).state).toMatchObject({
      referenceEquityGbp: -600,
      halted: false,
    });
    const third = new PaperBooks(db, clock);
    third.markDay('debate/primary', '2026-01-05', -700, 0, 3);
    const fourth = new PaperBooks(db, clock);
    expect(fourth.lastDay('debate/primary')?.state.halted).toBe(true);
    expect(fourth.markDay('debate/primary', '2026-01-06', 2_000, 0, 1).state).toMatchObject({
      halted: true,
      sizeMultiplier: 0,
    });
    expect(() => fourth.assertUnmarked('2026-01-06')).toThrow(/already marked 2026-01-06/);
    expect(() => fourth.assertUnmarked('2026-01-07')).not.toThrow();
    db.close();
  });
});
