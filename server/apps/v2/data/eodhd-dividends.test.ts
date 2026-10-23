import type { DividendsRead } from './eodhd-client.js';
import { dividendsAcross } from './eodhd-dividends.js';

function read(from: string, to: string, asOf: string, dividends: DividendsRead['dividends'] = []) {
  return { symbol: 'VOD.LSE', from, to, asOf, dividends };
}

describe('dividendsAcross', () => {
  it('returns the dividends strictly after the start through the end', () => {
    const reads = [
      read('2026-01-01', '2026-10-08', '2026-10-09', [
        { exDate: '2026-06-04', perShare: 0.02 },
        { exDate: '2026-06-05', perShare: 0.03 },
        { exDate: '2026-06-08', perShare: 0.04 },
      ]),
    ];
    expect(dividendsAcross(reads, '2026-06-04', '2026-06-05')).toEqual({
      kind: 'covered',
      dividends: [{ exDate: '2026-06-05', perShare: 0.03 }],
    });
  });

  it('reports the first day no read vouches for, including a read made on that day', () => {
    expect(dividendsAcross([], '2026-06-01', '2026-06-05')).toEqual({
      kind: 'uncovered',
      from: '2026-06-02',
    });
    const sameDay = [read('2026-06-02', '2026-06-05', '2026-06-05')];
    expect(dividendsAcross(sameDay, '2026-06-01', '2026-06-05')).toEqual({
      kind: 'uncovered',
      from: '2026-06-05',
    });
  });

  it('refuses a date two covering reads list differently', () => {
    const reads = [
      read('2026-06-01', '2026-06-08', '2026-06-09', [{ exDate: '2026-06-04', perShare: 0.02 }]),
      read('2026-06-03', '2026-06-08', '2026-06-09'),
    ];
    expect(dividendsAcross(reads, '2026-06-01', '2026-06-05')).toEqual({
      kind: 'conflict',
      date: '2026-06-04',
    });
  });

  it('keeps both dividends on one ex-date when every covering read lists both', () => {
    const both = [
      { exDate: '2026-06-04', perShare: 0.02 },
      { exDate: '2026-06-04', perShare: 0.5 },
    ];
    const reads = [
      read('2026-06-01', '2026-06-08', '2026-06-09', both),
      read('2026-06-03', '2026-06-08', '2026-06-09', [...both].reverse()),
    ];
    expect(dividendsAcross(reads, '2026-06-01', '2026-06-05')).toEqual({
      kind: 'covered',
      dividends: both,
    });
  });

  it('refuses reads for two symbols or a backwards window', () => {
    const mixed = [
      read('2026-06-01', '2026-06-08', '2026-06-09'),
      { ...read('2026-06-01', '2026-06-08', '2026-06-09'), symbol: 'BP.LSE' },
    ];
    expect(() => dividendsAcross(mixed, '2026-06-01', '2026-06-05')).toThrow(
      'more than one symbol',
    );
    expect(() => dividendsAcross([], '2026-06-05', '2026-06-01')).toThrow('ends before');
  });
});
