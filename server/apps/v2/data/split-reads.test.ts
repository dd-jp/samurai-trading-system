import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { SqliteSplitReads } from './split-reads.js';

const AT = new Date('2026-10-05T07:00:00.000Z');
const READ = {
  symbol: 'AAPL.US',
  from: '2026-10-01',
  to: '2026-10-05',
  asOf: '2026-10-05',
  splits: [{ date: '2026-10-02', ratio: 1.2 }],
};

describe('SqliteSplitReads', () => {
  it('returns the day’s ok reads for one source and symbol, in order', () => {
    const reads = new SqliteSplitReads(migratedMemoryStore());
    reads.recordRead('2026-10-05', 'eodhd', READ, AT);
    reads.recordRead('2026-10-05', 'eodhd', { ...READ, from: '2026-09-01', splits: [] }, AT);
    reads.recordRead('2026-10-05', 'alpaca', { ...READ, symbol: 'AAPL' }, AT);
    reads.recordRead('2026-10-04', 'eodhd', READ, AT);
    reads.recordRead('2026-10-05', 'eodhd', { ...READ, symbol: 'MSFT.US' }, AT);
    reads.recordFailure(
      '2026-10-05',
      'eodhd',
      { symbol: 'AAPL.US', from: '2026-01-01', to: '2026-10-05', reason: 'http_500' },
      AT,
    );
    expect(reads.reads('eodhd', 'AAPL.US', '2026-10-05')).toEqual([
      READ,
      { ...READ, from: '2026-09-01', splits: [] },
    ]);
    expect(reads.reads('alpaca', 'AAPL.US', '2026-10-05')).toEqual([]);
    expect(reads.reads('eodhd', 'AAPL.US', '2026-10-06')).toEqual([]);
  });

  it('counts only an ok read starting no later than asked as covered', () => {
    const reads = new SqliteSplitReads(migratedMemoryStore());
    reads.recordFailure(
      '2026-10-05',
      'eodhd',
      { symbol: 'AAPL.US', from: '2026-09-01', to: '2026-10-05', reason: 'x' },
      AT,
    );
    expect(reads.covered('eodhd', 'AAPL.US', '2026-10-05', '2026-10-01')).toBe(false);
    reads.recordRead('2026-10-05', 'eodhd', READ, AT);
    expect(reads.covered('eodhd', 'AAPL.US', '2026-10-05', '2026-10-01')).toBe(true);
    expect(reads.covered('eodhd', 'AAPL.US', '2026-10-05', '2026-10-02')).toBe(true);
    expect(reads.covered('eodhd', 'AAPL.US', '2026-10-05', '2026-09-30')).toBe(false);
    expect(reads.covered('alpaca', 'AAPL.US', '2026-10-05', '2026-10-01')).toBe(false);
    expect(reads.covered('eodhd', 'MSFT.US', '2026-10-05', '2026-10-01')).toBe(false);
    expect(reads.covered('eodhd', 'AAPL.US', '2026-10-06', '2026-10-01')).toBe(false);
  });

  it('marks a day with any read, failed or not', () => {
    const reads = new SqliteSplitReads(migratedMemoryStore());
    expect(reads.anyOn('2026-10-05')).toBe(false);
    reads.recordFailure(
      '2026-10-05',
      'alpaca',
      { symbol: 'AAPL', from: '2026-10-01', to: '2026-10-05', reason: 'no_alpaca_key' },
      AT,
    );
    expect(reads.anyOn('2026-10-05')).toBe(true);
    expect(reads.anyOn('2026-10-06')).toBe(false);
  });
});
