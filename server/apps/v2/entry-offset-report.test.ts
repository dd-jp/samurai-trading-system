import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../contracts/index.js';
import {
  type BarsFrom,
  entryOffsetReport,
  formatEntryOffsetReport,
  type JournalledEntry,
} from './entry-offset-report.js';

function bar(
  date: string,
  open: number,
  high: number,
  low: number,
  close: number,
  split = 1,
): V2Bar {
  return { date, open, high, low, close, volume: 1, rawClose: close * split };
}

const FLAT_SPY = [bar('2026-09-28', 50, 50, 50, 50), bar('2026-09-29', 50, 50, 50, 50)];

function source(series: Record<string, readonly V2Bar[]>): BarsFrom {
  return (instrument, tradingDate, count) =>
    (series[instrument] ?? []).filter((one) => one.date >= tradingDate).slice(0, count);
}

function excessByOffset(entries: readonly JournalledEntry[], barsFrom: BarsFrom) {
  const report = entryOffsetReport(entries, barsFrom, 'SPY', 2);
  return report.rows.map((row) => [row.offset, row.filled, Number(row.meanExcessBps.toFixed(2))]);
}

describe('entryOffsetReport', () => {
  it('fills a buy only where the offset reaches the next low, at the open when the open is inside it', () => {
    const barsFrom = source({
      AAA: [bar('2026-09-28', 101.5, 103, 100.8, 102), bar('2026-09-29', 103, 105, 102, 104)],
      SPY: FLAT_SPY,
    });
    const entry: JournalledEntry = {
      tradingDate: '2026-09-28',
      instrument: 'AAA',
      side: 'buy',
      limit: 100,
    };
    expect(excessByOffset([entry], barsFrom)).toEqual([
      [0, 0, 0],
      [50, 0, 0],
      [100, 1, 297.03],
      [200, 1, 246.31],
      ['open', 1, 246.31],
    ]);
  });

  it('mirrors a short: the limit sits below the close and a fill needs the next high', () => {
    const barsFrom = source({
      BBB: [bar('2026-09-28', 99, 99.4, 97, 98), bar('2026-09-29', 97, 97, 95, 96)],
      SPY: FLAT_SPY,
    });
    const entry: JournalledEntry = {
      tradingDate: '2026-09-28',
      instrument: 'BBB',
      side: 'sell',
      limit: 100,
    };
    expect(excessByOffset([entry], barsFrom)).toEqual([
      [0, 0, 0],
      [50, 0, 0],
      [100, 1, 303.03],
      [200, 1, 303.03],
      ['open', 1, 303.03],
    ]);
  });

  it('nets the benchmark from the open to the exit close, and reads the quoted limit on the adjusted scale', () => {
    const barsFrom = source({
      CCC: [bar('2026-09-28', 101, 101, 100, 100, 2), bar('2026-09-29', 102, 102, 102, 102, 2)],
      SPY: [bar('2026-09-28', 100, 100, 100, 100), bar('2026-09-29', 101, 101, 101, 101)],
    });
    const entry: JournalledEntry = {
      tradingDate: '2026-09-28',
      instrument: 'CCC',
      side: 'buy',
      limit: 200,
    };
    expect(excessByOffset([entry], barsFrom)[0]).toEqual([0, 1, 100]);
  });

  it('counts a miss as zero in the mean and leaves an entry without enough bars pending', () => {
    const barsFrom = source({
      AAA: [bar('2026-09-28', 101.5, 103, 100.8, 102), bar('2026-09-29', 103, 105, 102, 104)],
      DDD: [bar('2026-09-28', 100, 100, 100, 100)],
      EEE: [bar('2026-09-28', 100, 100, 100, 100), bar('2026-09-29', 100, 100, 100, 100)],
      SPY: FLAT_SPY,
    });
    const entries: JournalledEntry[] = [
      { tradingDate: '2026-09-28', instrument: 'AAA', side: 'buy', limit: 100 },
      { tradingDate: '2026-09-28', instrument: 'EEE', side: 'buy', limit: 100 },
      { tradingDate: '2026-09-28', instrument: 'DDD', side: 'buy', limit: 100 },
      { tradingDate: '2026-09-29', instrument: 'EEE', side: 'buy', limit: 100 },
    ];
    const report = entryOffsetReport(entries, barsFrom, 'SPY', 2);
    expect([report.scored, report.pending]).toEqual([2, 2]);
    expect(
      report.rows.map((row) => [row.offset, row.filled, Number(row.meanExcessBps.toFixed(2))]),
    ).toEqual([
      [0, 1, 0],
      [50, 1, 0],
      [100, 2, 148.51],
      [200, 2, 123.15],
      ['open', 2, 123.15],
    ]);
  });

  it.each([
    ['entry day', '2026-09-30', ['2026-09-29', '2026-09-30']],
    ['exit day', '2026-09-29', ['2026-09-28', '2026-09-30']],
  ])('leaves an entry pending when the benchmark misses the %s', (_, exitDate, spyDates) => {
    const barsFrom = source({
      AAA: [bar('2026-09-28', 101.5, 103, 100.8, 102), bar(exitDate, 103, 105, 102, 104)],
      SPY: spyDates.map((date) => bar(date, 50, 50, 50, 50)),
    });
    const entry: JournalledEntry = {
      tradingDate: '2026-09-28',
      instrument: 'AAA',
      side: 'buy',
      limit: 100,
    };
    expect(entryOffsetReport([entry], barsFrom, 'SPY', 2).pending).toBe(1);
  });

  it('leaves an entry pending when the benchmark lacks the bars', () => {
    const barsFrom = source({
      AAA: [bar('2026-09-28', 101.5, 103, 100.8, 102), bar('2026-09-29', 103, 105, 102, 104)],
      SPY: [bar('2026-09-28', 50, 50, 50, 50)],
    });
    const entry: JournalledEntry = {
      tradingDate: '2026-09-28',
      instrument: 'AAA',
      side: 'buy',
      limit: 100,
    };
    const report = entryOffsetReport([entry], barsFrom, 'SPY', 2);
    expect([report.scored, report.pending]).toEqual([0, 1]);
    expect(report.rows.every((row) => row.filled === 0 && row.meanExcessBps === 0)).toBe(true);
  });
});

describe('entryOffsetReport at the touch', () => {
  it('fills a short whose limit equals the next high', () => {
    const barsFrom = source({
      FFF: [bar('2026-09-28', 99, 100, 98, 99), bar('2026-09-29', 98, 98, 98, 98)],
      SPY: FLAT_SPY,
    });
    const entry: JournalledEntry = {
      tradingDate: '2026-09-28',
      instrument: 'FFF',
      side: 'sell',
      limit: 100,
    };
    expect(excessByOffset([entry], barsFrom)[0]).toEqual([0, 1, 200]);
  });
});

describe('formatEntryOffsetReport', () => {
  it('prints fill share and mean excess per offset', () => {
    const text = formatEntryOffsetReport(
      {
        scored: 4,
        pending: 1,
        rows: [
          { offset: 0, filled: 3, meanExcessBps: 12.345 },
          { offset: 'open', filled: 4, meanExcessBps: -1.5 },
        ],
      },
      10,
    );
    expect(text).toBe(
      [
        'entries scored: 4, awaiting 10 bars: 1',
        'offset      filled   mean excess per entry (bps, a miss counts 0)',
        '0 bps        75.0%   12.35',
        'at the open 100.0%   -1.50',
      ].join('\n'),
    );
  });

  it('prints zero shares when nothing is scored', () => {
    const text = formatEntryOffsetReport(
      { scored: 0, pending: 2, rows: [{ offset: 50, filled: 0, meanExcessBps: 0 }] },
      10,
    );
    expect(text.split('\n')[2]).toBe('50 bps        0.0%   0.00');
  });
});
