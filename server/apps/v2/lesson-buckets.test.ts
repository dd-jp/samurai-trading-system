import { describe, expect, it } from 'vitest';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  bootstrapMeanCi,
  computeLessonBuckets,
  formatLessonRun,
  LESSON_BASELINE_BOOK_ID,
  LESSON_BOOK_ID,
  LESSON_MIN_BUCKET_N,
  writeLessonBuckets,
} from './lesson-buckets.js';

interface Trade {
  readonly book?: string;
  readonly venue?: string;
  readonly direction?: string;
  readonly excess: number;
  readonly settled: string;
  readonly confidence?: number;
  readonly headlines?: number;
}

function store(): StoreHandle {
  const db = migratedMemoryStore();
  for (const [book, sleeve, variant] of [
    [LESSON_BOOK_ID, 'debate', 'primary'],
    [LESSON_BASELINE_BOOK_ID, 'arm2', 'technical-only'],
  ]) {
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
        VALUES (?, ?, ?, 1000, 1000, 't')`,
    ).run(book, sleeve, variant);
  }
  return db;
}

let next = 0;

function settle(db: StoreHandle, trade: Trade): string {
  next += 1;
  const id = `d-${next}`;
  const book = trade.book ?? LESSON_BOOK_ID;
  const payload =
    book === LESSON_BOOK_ID
      ? { disagreement: 'bull and bear disagree on direction', headlines: trade.headlines ?? 0 }
      : { technical: [] };
  db.prepare(
    `INSERT INTO v2_decisions (decision_id, book_id, trading_date, instrument, venue, inputs_hash,
        direction, confidence, action, reason, size_shares, stop_price, payload, recorded_at)
      VALUES (?, ?, '2026-10-01', 'AAPL', ?, 'h', ?, ?, 'enter', 'r', 1, 90, ?, 't')`,
  ).run(
    id,
    book,
    trade.venue ?? 'alpaca',
    trade.direction ?? 'long',
    trade.confidence ?? 0.75,
    JSON.stringify(payload),
  );
  db.prepare(
    `INSERT INTO v2_decision_outcomes (decision_id, book_id, sleeve_id, instrument, venue,
        direction, decision_date, entry_client_order_id, exit_client_order_id, exit_leg,
        exit_reason, entry_date, exit_date, holding_days, entry_qty, exit_qty, entry_price_gbp,
        exit_price_gbp, fees_gbp, carry_gbp, realised_pnl_gbp, trade_return, benchmark_symbol,
        benchmark_return, excess_return, settled_at, schema_version)
      VALUES (?, ?, ?, 'AAPL', ?, ?, '2026-10-01', ?, ?, 'exit', 'time_stop', '2026-10-02', ?, 5,
        1, 1, 100, 100, 0, 0, 0, 0, 'SPY', 0, ?, ?, 1)`,
  ).run(
    id,
    book,
    book === LESSON_BOOK_ID ? 'debate' : 'arm2',
    trade.venue ?? 'alpaca',
    trade.direction ?? 'long',
    `${id}-in`,
    `${id}-out`,
    trade.settled,
    trade.excess,
    trade.settled,
  );
  return id;
}

function settleMany(db: StoreHandle, count: number, trade: (index: number) => Trade): string[] {
  return Array.from({ length: count }, (_, index) => settle(db, trade(index)));
}

function bucket(db: StoreHandle, asOf: string, tag: string) {
  return computeLessonBuckets(db, asOf).buckets.find((row) => row.bucket === tag);
}

describe('bootstrapMeanCi', () => {
  it('is the same interval for the same seed and brackets the sample mean', () => {
    const values = [0.01, -0.02, 0.03, 0.005, -0.01, 0.02, 0.015, -0.005, 0.01, 0.0];
    const [low, high] = bootstrapMeanCi(values, 7);
    expect(bootstrapMeanCi(values, 7)).toEqual([low, high]);
    expect(low).toBeLessThan(0.0055);
    expect(high).toBeGreaterThan(0.0055);
  });

  it('collapses to the value when every trade returned the same', () => {
    const [low, high] = bootstrapMeanCi(Array(10).fill(0.02), 1);
    expect(low).toBeCloseTo(0.02, 12);
    expect(high).toBeCloseTo(0.02, 12);
  });
});

describe('computeLessonBuckets', () => {
  it(`emits a bucket only at n >= ${LESSON_MIN_BUCKET_N}, with mean, hit rate and evidence`, () => {
    const db = store();
    const longs = settleMany(db, 10, (index) => ({
      excess: index < 6 ? 0.02 : -0.01,
      settled: '2026-10-10',
    }));
    settleMany(db, 9, () => ({
      direction: 'short',
      venue: 'saxo_cfd_usd',
      excess: -0.03,
      settled: '2026-10-10',
    }));
    const tags = computeLessonBuckets(db, '2026-11-01').buckets.map((row) => row.bucket);
    expect(tags).toContain('direction=long');
    expect(tags).not.toContain('direction=short');
    expect(tags).not.toContain('venue=saxo_cfd_usd');
    const long = bucket(db, '2026-11-01', 'direction=long');
    expect(long).toMatchObject({ n: 10, hit_rate: 0.6, book_id: LESSON_BOOK_ID });
    expect(long?.mean_excess).toBeCloseTo((6 * 0.02 - 4 * 0.01) / 10, 12);
    expect(JSON.parse(long?.evidence ?? '[]')).toEqual([...longs].sort());
    expect(bucket(db, '2026-11-01', 'all')?.n).toBe(19);
  });

  it('reads only outcomes settled strictly before as_of', () => {
    const db = store();
    settleMany(db, 10, () => ({ excess: 0.01, settled: '2026-10-10' }));
    const late = settle(db, { excess: 0.5, settled: '2026-11-01' });
    const all = bucket(db, '2026-11-01', 'all');
    expect(all?.n).toBe(10);
    expect(all?.evidence).not.toContain(late);
    expect(bucket(db, '2026-11-02', 'all')?.n).toBe(11);
  });

  it("tags the judge's confidence band, the disagreement and the news count", () => {
    const db = store();
    settleMany(db, 10, (index) => ({
      excess: 0.01,
      settled: '2026-10-10',
      confidence: 0.79,
      headlines: index < 5 ? 0 : 6,
    }));
    const tags = computeLessonBuckets(db, '2026-11-01').buckets.map((row) => row.bucket);
    expect(tags).toEqual([
      'all',
      'confidence=0.7',
      'direction=long',
      'disagreement=bull and bear disagree on direction',
      'venue=alpaca',
    ]);
  });

  it('gives two tags holding the same trades the same interval', () => {
    const db = store();
    settleMany(db, 10, (index) => ({ excess: (index % 4) / 100 - 0.01, settled: '2026-10-10' }));
    const intervals = new Set(
      computeLessonBuckets(db, '2026-11-01').buckets.map((row) => `${row.ci_low}|${row.ci_high}`),
    );
    expect(intervals.size).toBe(1);
  });

  it("baselines a shared tag on arm 2's same tag and a debate-only tag on all of arm 2", () => {
    const db = store();
    settleMany(db, 10, () => ({ excess: 0.01, settled: '2026-10-10' }));
    settleMany(db, 4, () => ({
      book: LESSON_BASELINE_BOOK_ID,
      excess: 0.02,
      settled: '2026-10-10',
    }));
    settleMany(db, 2, () => ({
      book: LESSON_BASELINE_BOOK_ID,
      direction: 'short',
      excess: -0.04,
      settled: '2026-10-10',
    }));
    expect(bucket(db, '2026-11-01', 'direction=long')).toMatchObject({
      baseline_book_id: LESSON_BASELINE_BOOK_ID,
      baseline_n: 4,
    });
    expect(bucket(db, '2026-11-01', 'direction=long')?.baseline_mean_excess).toBeCloseTo(0.02, 12);
    expect(bucket(db, '2026-11-01', 'confidence=0.7')?.baseline_n).toBe(6);
    expect(bucket(db, '2026-11-01', 'confidence=0.7')?.baseline_mean_excess).toBeCloseTo(0, 12);
  });

  it('has no baseline mean when arm 2 has no matching trade', () => {
    const db = store();
    settleMany(db, 10, () => ({ excess: 0.01, settled: '2026-10-10' }));
    expect(bucket(db, '2026-11-01', 'all')).toMatchObject({
      baseline_n: 0,
      baseline_mean_excess: null,
    });
  });
});

describe('writeLessonBuckets', () => {
  it('writes once, and a rerun at the same as_of reproduces the stored rows and writes nothing', () => {
    const db = store();
    settleMany(db, 12, (index) => ({
      excess: index % 3 === 0 ? -0.01 : 0.02,
      settled: '2026-10-10',
    }));
    const first = writeLessonBuckets(db, '2026-11-01', '2026-11-20');
    expect(first.written).toBe(first.buckets.length);
    settle(db, { excess: 0.4, settled: '2026-11-05' });
    const second = writeLessonBuckets(db, '2026-11-01', '2026-11-20');
    expect(second.written).toBe(0);
    expect(second.buckets).toEqual(first.buckets);
    expect(db.prepare('SELECT * FROM v2_lesson_buckets ORDER BY bucket').all()).toEqual(
      first.buckets,
    );
  });

  it('gives byte-identical rows from two independent stores holding the same outcomes', () => {
    const rows = [store(), store()].map((db) => {
      next = 0;
      settleMany(db, 15, (index) => ({ excess: (index % 5) / 100 - 0.015, settled: '2026-10-10' }));
      writeLessonBuckets(db, '2026-11-01', '2026-11-20');
      return JSON.stringify(db.prepare('SELECT * FROM v2_lesson_buckets ORDER BY bucket').all());
    });
    expect(rows[0]).toBe(rows[1]);
  });

  it('refuses a stored run that the outcomes no longer reproduce', () => {
    const db = store();
    settleMany(db, 10, () => ({ excess: 0.01, settled: '2026-10-10' }));
    writeLessonBuckets(db, '2026-11-01', '2026-11-20');
    settle(db, { excess: 0.4, settled: '2026-10-11' });
    expect(() => writeLessonBuckets(db, '2026-11-01', '2026-11-20')).toThrow(
      /differ from the stored run/,
    );
  });

  it('refuses an as_of after today, whose outcomes have not all settled', () => {
    expect(() => writeLessonBuckets(store(), '2026-11-21', '2026-11-20')).toThrow(/after today/);
  });

  it('reaches the kill line at 100 closed trades when no interval excludes zero', () => {
    const db = store();
    settleMany(db, 100, (index) => ({
      excess: index % 2 === 0 ? 0.01 : -0.01,
      settled: '2026-10-10',
    }));
    const run = writeLessonBuckets(db, '2026-11-01', '2026-11-20');
    expect(run.closedTrades).toBe(100);
    expect(run.killLine).toBe(true);
    expect(formatLessonRun(run)).toContain('kill line: 100 closed trades');
  });

  it('stops short of the kill line when a bucket interval excludes zero', () => {
    const db = store();
    settleMany(db, 100, () => ({ excess: 0.01, settled: '2026-10-10' }));
    const run = writeLessonBuckets(db, '2026-11-01', '2026-11-20');
    expect(run.killLine).toBe(false);
    expect(formatLessonRun(run)).toContain('all: n 100, mean excess 1.00% [1.00%, 1.00%]');
  });

  it('stops short of the kill line below 100 closed trades', () => {
    const db = store();
    settleMany(db, 99, (index) => ({
      excess: index % 2 === 0 ? 0.01 : -0.01,
      settled: '2026-10-10',
    }));
    expect(writeLessonBuckets(db, '2026-11-01', '2026-11-20').killLine).toBe(false);
  });
});

describe('formatLessonRun', () => {
  it('reports the run, each bucket with arm 2 beside it, and marks an interval clear of zero', () => {
    const db = store();
    settleMany(db, 10, () => ({ excess: 0.01, settled: '2026-10-10' }));
    const text = formatLessonRun(writeLessonBuckets(db, '2026-11-01', '2026-11-20'));
    expect(text).toContain(
      `lesson buckets for ${LESSON_BOOK_ID} at as_of 2026-11-01: 10 closed trades`,
    );
    expect(text).toContain('arm 2 n/a (n 0) *');
  });
});
