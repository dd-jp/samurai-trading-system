import { describe, expect, it } from 'vitest';
import type { BookSpec, ExposureHoldingWire } from '../../../contracts/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  crossSleeveExposure,
  type EquityRow,
  type ExposureInput,
  newWarnings,
  pearson,
  readLatestExposure,
  SqliteExposureJournal,
} from './cross-sleeve-exposure.js';

const LEVELS = { overlapInstruments: 1, correlation: 0.7, windowReturns: 60, minObservations: 5 };
const clock = { now: () => new Date('2026-11-19T21:40:00.000Z') };

const DEBATE: BookSpec = {
  id: 'debate/primary',
  sleeve: 'debate',
  variant: 'primary',
  instantiated: true,
};
const SHADOW: BookSpec = {
  id: 'debate/no-macro-gate',
  sleeve: 'debate',
  variant: 'no-macro-gate',
  instantiated: true,
};
const SIGNALS: BookSpec = {
  id: 'signals/primary',
  sleeve: 'signals',
  variant: 'primary',
  instantiated: true,
};

function holding(book: BookSpec, instrument: string, signedGbp: number): ExposureHoldingWire {
  return { book_id: book.id, sleeve_id: book.sleeve, instrument, signed_gbp: signedGbp };
}

function dates(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2026, 9, 1) + index * 86_400_000).toISOString().slice(0, 10),
  );
}

function series(book: BookSpec, returns: readonly number[]): EquityRow[] {
  const days = dates(returns.length + 1);
  let equity = 1_000;
  return days.map((trading_date, index) => {
    if (index > 0) equity *= 1 + (returns[index - 1] as number);
    return { book_id: book.id, trading_date, equity_gbp: equity };
  });
}

const WAVE = [0.01, -0.02, 0.015, -0.005, 0.02, -0.01, 0.005, -0.015];

function input(overrides: Partial<ExposureInput> = {}): ExposureInput {
  return {
    tradingDate: '2026-10-31',
    books: [DEBATE, SIGNALS],
    holdings: [],
    equity: [],
    levels: LEVELS,
    ...overrides,
  };
}

describe('crossSleeveExposure', () => {
  it('reports no overlap when the sleeves hold different names, with gross and net per book', () => {
    const report = crossSleeveExposure(
      input({
        holdings: [
          holding(DEBATE, 'AAPL', 300),
          holding(DEBATE, 'TSLA', -100),
          holding(SIGNALS, 'MSFT', 500),
        ],
      }),
    );

    expect(report.overlaps).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.books).toEqual([
      {
        book_id: 'debate/primary',
        sleeve_id: 'debate',
        variant: 'primary',
        long_gbp: 300,
        short_gbp: 100,
        gross_gbp: 400,
        net_gbp: 200,
      },
      {
        book_id: 'signals/primary',
        sleeve_id: 'signals',
        variant: 'primary',
        long_gbp: 500,
        short_gbp: 0,
        gross_gbp: 500,
        net_gbp: 500,
      },
    ]);
  });

  it('flags every name both sleeves hold the same way', () => {
    const holdings = [
      holding(DEBATE, 'MSFT', 200),
      holding(DEBATE, 'AAPL', 300),
      holding(SIGNALS, 'AAPL', 500),
      holding(SIGNALS, 'MSFT', 100),
    ];
    const report = crossSleeveExposure(input({ holdings }));

    expect(report.overlaps).toEqual([
      {
        instrument: 'AAPL',
        sleeves: ['debate', 'signals'],
        opposed: false,
        holders: [holdings[1], holdings[2]],
      },
      {
        instrument: 'MSFT',
        sleeves: ['debate', 'signals'],
        opposed: false,
        holders: [holdings[0], holdings[3]],
      },
    ]);
    expect(report.warnings).toEqual(['overlap:AAPL', 'overlap:MSFT']);
  });

  it('marks an overlap held in opposite directions as opposed', () => {
    const report = crossSleeveExposure(
      input({ holdings: [holding(DEBATE, 'AAPL', -300), holding(SIGNALS, 'AAPL', 500)] }),
    );

    expect(report.overlaps.map((overlap) => overlap.opposed)).toEqual([true]);
  });

  it('warns on overlaps only once their count reaches the configured level', () => {
    const report = crossSleeveExposure(
      input({
        holdings: [holding(DEBATE, 'AAPL', 300), holding(SIGNALS, 'AAPL', 500)],
        levels: { ...LEVELS, overlapInstruments: 2 },
      }),
    );

    expect(report.overlaps).toHaveLength(1);
    expect(report.warnings).toEqual([]);
  });

  it('never counts a primary and its own shadow as an overlap', () => {
    const report = crossSleeveExposure(
      input({
        books: [DEBATE, SHADOW],
        holdings: [holding(DEBATE, 'AAPL', 300), holding(SHADOW, 'AAPL', 300)],
      }),
    );

    expect(report.overlaps).toEqual([]);
  });

  it('reports shadow and arm 2 books but never overlaps or warns on them', () => {
    const arm2: BookSpec = {
      id: 'arm2/technical-only',
      sleeve: 'arm2',
      variant: 'technical-only',
      instantiated: true,
    };
    const report = crossSleeveExposure(
      input({
        books: [DEBATE, SHADOW, arm2, SIGNALS],
        holdings: [
          holding(SHADOW, 'AAPL', 300),
          holding(arm2, 'AAPL', 200),
          holding(SIGNALS, 'AAPL', 500),
        ],
        equity: [...series(SHADOW, WAVE), ...series(arm2, WAVE), ...series(SIGNALS, WAVE)],
      }),
    );

    expect(report.overlaps).toEqual([]);
    expect(
      report.correlations
        .filter((pair) => pair.correlation !== null)
        .map((pair) => pair.cross_sleeve),
    ).toEqual([true, true, true]);
    expect(report.warnings).toEqual([]);
  });

  it('gives a pair under the minimum history no correlation, never 0 (#303)', () => {
    const report = crossSleeveExposure(
      input({
        equity: [...series(DEBATE, WAVE.slice(0, 4)), ...series(SIGNALS, WAVE.slice(0, 4))],
      }),
    );

    expect(report.correlations).toEqual([
      {
        book_a: 'debate/primary',
        book_b: 'signals/primary',
        cross_sleeve: true,
        correlation: null,
        observations: 4,
        gap: 'warm_up',
      },
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('gives a book that never moved no correlation', () => {
    const report = crossSleeveExposure(
      input({
        equity: [
          ...series(DEBATE, WAVE),
          ...series(
            SIGNALS,
            WAVE.map(() => 0),
          ),
        ],
      }),
    );

    expect(report.correlations[0]).toMatchObject({ correlation: null, gap: 'zero_variance' });
  });

  it('warns on a cross-sleeve pair moving together, and reads a mirrored pair as -1', () => {
    const together = crossSleeveExposure(
      input({ equity: [...series(DEBATE, WAVE), ...series(SIGNALS, WAVE)] }),
    );
    const mirrored = crossSleeveExposure(
      input({
        equity: [
          ...series(DEBATE, WAVE),
          ...series(
            SIGNALS,
            WAVE.map((value) => -value),
          ),
        ],
      }),
    );

    expect(together.correlations[0]?.correlation).toBeCloseTo(1, 12);
    expect(together.correlations[0]?.observations).toBe(WAVE.length);
    expect(together.warnings).toEqual(['correlation:debate/primary|signals/primary']);
    expect(mirrored.correlations[0]?.correlation).toBeCloseTo(-1, 12);
    expect(mirrored.warnings).toEqual(['correlation:debate/primary|signals/primary']);
  });

  it('reports a same-sleeve pair but never warns on it', () => {
    const report = crossSleeveExposure(
      input({
        books: [DEBATE, SHADOW],
        equity: [...series(DEBATE, WAVE), ...series(SHADOW, WAVE)],
      }),
    );

    expect(report.correlations[0]).toMatchObject({ cross_sleeve: false, gap: null });
    expect(report.warnings).toEqual([]);
  });

  it('reads one sleeve alone with no overlap and no cross-sleeve pair', () => {
    const report = crossSleeveExposure(
      input({ books: [DEBATE], holdings: [holding(DEBATE, 'AAPL', 300)] }),
    );

    expect(report.overlaps).toEqual([]);
    expect(report.correlations).toEqual([]);
    expect(report.books).toHaveLength(1);
  });

  it('aligns on the dates both books marked and keeps only the window', () => {
    const debate = series(DEBATE, WAVE);
    const signals = series(SIGNALS, WAVE).filter((_, index) => index !== 3);
    const report = crossSleeveExposure(
      input({
        equity: [...debate, ...signals],
        levels: { ...LEVELS, windowReturns: 4, minObservations: 2 },
      }),
    );

    expect(report.correlations[0]?.observations).toBe(4);
  });

  it('ignores equity journalled after the report date', () => {
    const late = { book_id: DEBATE.id, trading_date: '2026-11-30', equity_gbp: 5_000 };
    const equity = [...series(DEBATE, WAVE), ...series(SIGNALS, WAVE)];

    expect(crossSleeveExposure(input({ equity: [...equity, late] }))).toEqual(
      crossSleeveExposure(input({ equity })),
    );
  });
});

describe('pearson', () => {
  it('is the textbook correlation of two short series', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 5, 9])).toBeCloseTo(11 / Math.sqrt(130), 12);
  });
});

describe('newWarnings', () => {
  it('keeps only warnings the previous report did not carry', () => {
    const report = crossSleeveExposure(
      input({ holdings: [holding(DEBATE, 'AAPL', 300), holding(SIGNALS, 'AAPL', 500)] }),
    );

    expect(newWarnings(report, [])).toEqual(['overlap:AAPL']);
    expect(newWarnings(report, ['overlap:AAPL'])).toEqual([]);
  });
});

describe('SqliteExposureJournal', () => {
  function seeded() {
    const db = migratedMemoryStore();
    db.prepare(
      `INSERT INTO v2_books (book_id, sleeve_id, variant, start_capital_gbp, cash_gbp, created_at)
       VALUES (?, ?, ?, 1000, 1000, 't')`,
    ).run(DEBATE.id, DEBATE.sleeve, DEBATE.variant);
    const day = db.prepare(
      `INSERT INTO v2_book_days (book_id, trading_date, equity_gbp, cash_gbp, invested_gbp,
         ytd_loss_gbp, size_multiplier, entries_blocked, custody_accrual_gbp, recorded_at)
       VALUES (?, ?, ?, 0, 0, 0, 1, 0, 0, 't')`,
    );
    for (const [index, date] of dates(5).entries()) day.run(DEBATE.id, date, 1_000 + index);
    return db;
  }

  it('reads equity for the latest marked dates up to the report date', () => {
    const journal = new SqliteExposureJournal(seeded(), clock);

    expect(journal.equityThrough('2026-10-04', 2)).toEqual([
      { book_id: DEBATE.id, trading_date: '2026-10-03', equity_gbp: 1_002 },
      { book_id: DEBATE.id, trading_date: '2026-10-04', equity_gbp: 1_003 },
    ]);
  });

  it('keeps the first report of a date and reads the warnings of the one before', () => {
    const db = seeded();
    const journal = new SqliteExposureJournal(db, clock);
    const overlapping = crossSleeveExposure(
      input({
        tradingDate: '2026-10-02',
        holdings: [holding(DEBATE, 'AAPL', 300), holding(SIGNALS, 'AAPL', 500)],
      }),
    );
    journal.record(overlapping);
    journal.record({ ...overlapping, warnings: [] });

    expect(journal.warningsBefore('2026-10-02')).toEqual([]);
    expect(journal.warningsBefore('2026-10-03')).toEqual(['overlap:AAPL']);
    expect(readLatestExposure(db)).toEqual({ status: 'fed', ...overlapping });
  });

  it('reads an empty panel before any report', () => {
    expect(readLatestExposure(migratedMemoryStore())).toEqual({ status: 'empty' });
  });
});
