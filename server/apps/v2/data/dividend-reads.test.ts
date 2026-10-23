import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import { SqliteDividendReads } from './dividend-reads.js';

const AT = new Date('2026-06-09T06:30:00.000Z');
const READ = {
  symbol: 'VOD.LSE',
  from: '2026-06-01',
  to: '2026-06-08',
  asOf: '2026-06-09',
  dividends: [{ exDate: '2026-06-04', perShare: 0.02 }],
};

describe('SqliteDividendReads', () => {
  it('answers cycle reads by symbol and date and history reads by symbol, ok reads only', () => {
    const reads = new SqliteDividendReads(migratedMemoryStore());
    reads.recordRead('cycle', '2026-06-09', READ, AT);
    reads.recordFailure('cycle', '2026-06-09', { ...READ, reason: 'http_429' }, AT);
    reads.recordRead('cycle', '2026-06-10', { ...READ, symbol: 'BP.LSE' }, AT);
    reads.recordRead('history', '2026-06-09', { ...READ, to: '2026-06-07' }, AT);
    expect(reads.cycleReads('VOD.LSE', '2026-06-09')).toEqual([READ]);
    expect(reads.cycleReads('VOD.LSE', '2026-06-10')).toEqual([]);
    expect(reads.historyReads('VOD.LSE')).toEqual([{ ...READ, to: '2026-06-07' }]);
    expect(reads.historyReads('BP.LSE')).toEqual([]);
  });

  it('says whether any cycle read, failed or not, was made on a date', () => {
    const reads = new SqliteDividendReads(migratedMemoryStore());
    reads.recordFailure('cycle', '2026-06-09', { ...READ, reason: 'network' }, AT);
    reads.recordRead('history', '2026-06-10', READ, AT);
    expect(reads.anyCycleReadOn('2026-06-09')).toBe(true);
    expect(reads.anyCycleReadOn('2026-06-10')).toBe(false);
  });
});
