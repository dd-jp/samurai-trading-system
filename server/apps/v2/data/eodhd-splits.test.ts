import type { EodhdSplit, SplitsRead } from './eodhd-client.js';
import { coverageEnd, splitsAcross } from './eodhd-splits.js';

function read(
  from: string,
  to: string,
  asOf: string,
  splits: readonly EodhdSplit[] = [],
  symbol = 'XYZ.US',
): SplitsRead {
  return { symbol, from, to, asOf, splits };
}

const SIX_FIVE = { date: '2025-06-16', ratio: 1.2 };
const REVERSE = { date: '2026-03-02', ratio: 0.005 };

describe('coverageEnd', () => {
  it('stops the day before the UTC date the read was made', () => {
    expect(coverageEnd(read('2026-01-01', '2026-12-31', '2026-10-09'))).toBe('2026-10-08');
    expect(coverageEnd(read('2026-01-01', '2026-10-08', '2026-10-09'))).toBe('2026-10-08');
    expect(coverageEnd(read('2026-01-01', '2026-10-07', '2026-10-09'))).toBe('2026-10-07');
  });
});

describe('splitsAcross', () => {
  it('multiplies the splits strictly after the start through the end', () => {
    const history = read('2020-01-01', '2026-10-09', '2026-10-10', [SIX_FIVE, REVERSE]);
    expect(splitsAcross([history], '2025-01-02', '2026-10-09')).toEqual({
      kind: 'covered',
      ratio: 1.2 * 0.005,
      splits: [SIX_FIVE, REVERSE],
    });
    expect(splitsAcross([history], '2025-06-16', '2026-03-02')).toEqual({
      kind: 'covered',
      ratio: 0.005,
      splits: [REVERSE],
    });
    expect(splitsAcross([history], '2025-06-15', '2026-03-01')).toEqual({
      kind: 'covered',
      ratio: 1.2,
      splits: [SIX_FIVE],
    });
  });

  it('is covered with ratio 1 when the window holds no split', () => {
    const history = read('2020-01-01', '2026-10-09', '2026-10-10');
    expect(splitsAcross([history], '2026-01-01', '2026-10-09')).toEqual({
      kind: 'covered',
      ratio: 1,
      splits: [],
    });
    expect(splitsAcross([], '2026-10-09', '2026-10-09')).toEqual({
      kind: 'covered',
      ratio: 1,
      splits: [],
    });
  });

  it('chains contiguous and overlapping reads in any order', () => {
    const reads = [
      read('2026-03-01', '2026-10-09', '2026-10-10', [REVERSE]),
      read('2025-01-01', '2025-12-31', '2026-01-03', [SIX_FIVE]),
      read('2025-12-01', '2026-02-28', '2026-03-02'),
    ];
    expect(splitsAcross(reads, '2024-12-31', '2026-10-09')).toEqual({
      kind: 'covered',
      ratio: 1.2 * 0.005,
      splits: [SIX_FIVE, REVERSE],
    });
  });

  it('refuses at the first day no read covers', () => {
    const reads = [
      read('2025-01-01', '2025-12-31', '2026-01-03', [SIX_FIVE]),
      read('2026-01-02', '2026-10-09', '2026-10-10', [REVERSE]),
    ];
    expect(splitsAcross(reads, '2024-12-31', '2026-10-09')).toEqual({
      kind: 'uncovered',
      from: '2026-01-01',
    });
    expect(splitsAcross(reads, '2024-12-30', '2025-06-30')).toEqual({
      kind: 'uncovered',
      from: '2024-12-31',
    });
    expect(splitsAcross([], '2026-10-08', '2026-10-09')).toEqual({
      kind: 'uncovered',
      from: '2026-10-09',
    });
  });

  it('does not let a read vouch for days after it was made', () => {
    const early = read('2026-01-01', '2026-12-31', '2026-10-02');
    expect(splitsAcross([early], '2025-12-31', '2026-10-01').kind).toBe('covered');
    expect(splitsAcross([early], '2025-12-31', '2026-10-09')).toEqual({
      kind: 'uncovered',
      from: '2026-10-02',
    });
    const before = read('2026-10-05', '2026-10-09', '2026-10-02');
    expect(splitsAcross([before], '2026-10-04', '2026-10-09')).toEqual({
      kind: 'uncovered',
      from: '2026-10-05',
    });
  });

  it('drops an announced split a later covering read no longer lists', () => {
    const announced = { date: '2026-10-07', ratio: 2 };
    const reads = [
      read('2026-10-01', '2026-10-31', '2026-10-02', [announced]),
      read('2026-10-02', '2026-10-09', '2026-10-10'),
    ];
    expect(splitsAcross(reads, '2026-09-30', '2026-10-09')).toEqual({
      kind: 'covered',
      ratio: 1,
      splits: [],
    });
  });

  it('refuses when overlapping reads disagree on a split', () => {
    const omitted = [
      read('2025-01-01', '2025-12-31', '2026-01-03', [SIX_FIVE]),
      read('2025-06-01', '2026-10-09', '2026-10-10'),
    ];
    expect(splitsAcross(omitted, '2024-12-31', '2026-10-09')).toEqual({
      kind: 'conflict',
      date: SIX_FIVE.date,
    });
    const differing = [
      read('2025-01-01', '2025-12-31', '2026-01-03', [SIX_FIVE]),
      read('2025-06-01', '2026-10-09', '2026-10-10', [{ date: SIX_FIVE.date, ratio: 1.25 }]),
    ];
    expect(splitsAcross(differing, '2024-12-31', '2026-10-09')).toEqual({
      kind: 'conflict',
      date: SIX_FIVE.date,
    });
    expect(splitsAcross(omitted, '2025-06-16', '2026-10-09').kind).toBe('covered');
  });

  it('does not let a read vouch for the UTC day it was made', () => {
    const preSession = read('2026-10-01', '2026-10-09', '2026-10-09');
    expect(splitsAcross([preSession], '2026-09-30', '2026-10-08').kind).toBe('covered');
    expect(splitsAcross([preSession], '2026-09-30', '2026-10-09')).toEqual({
      kind: 'uncovered',
      from: '2026-10-09',
    });
  });

  it('refuses a window that ends before it starts', () => {
    const history = read('2020-01-01', '2026-10-09', '2026-10-10');
    expect(() => splitsAcross([history], '2026-10-09', '2026-10-08')).toThrow(/ends before/);
  });

  it('refuses reads for more than one symbol', () => {
    const reads = [
      read('2026-01-01', '2026-10-09', '2026-10-10'),
      read('2026-01-01', '2026-10-09', '2026-10-10', [], 'XYZ.LSE'),
    ];
    expect(() => splitsAcross(reads, '2025-12-31', '2026-10-09')).toThrow(/more than one symbol/);
  });
});
