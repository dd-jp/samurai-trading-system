import type { MarketData } from '../../../contracts/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { EodhdRequestError, type SplitsWindow, SqliteDividendReads } from './data/index.js';
import { type DividendsReader, historyDividendFeed } from './dividend-feed.js';
import { fillDividendHistory } from './dividend-history.js';

const NOW = new Date('2026-10-23T06:30:00.000Z');
const WINDOW = { from: '2024-01-02', to: '2024-12-31' };
const MARKET: Pick<MarketData, 'lastBarBefore'> = {
  lastBarBefore: (instrument) =>
    instrument === 'NEW' ? undefined : ({ date: '2023-12-29' } as never),
};

function reader(asked: [string, SplitsWindow][]): DividendsReader {
  return {
    dividends: (symbol, window) => {
      asked.push([symbol, window]);
      if (symbol === 'LIMIT.US') return Promise.reject(new EodhdRequestError('http_429'));
      if (symbol === 'BOOM.US') return Promise.reject(new Error('socket hang up'));
      return Promise.resolve({
        symbol,
        ...window,
        asOf: '2026-10-23',
        dividends: [{ exDate: '2024-05-10', perShare: 0.25 }],
      });
    },
  };
}

describe('fillDividendHistory', () => {
  const names = new Map([
    ['VOD_XLON', 'LSE'],
    ['AAPL', 'US'],
    ['NEW', 'US'],
    ['LIMIT', 'US'],
    ['BOOM', 'US'],
  ] as const);

  it('fetches each uncovered name from the bar before the window through yesterday, once', async () => {
    const db = migratedMemoryStore();
    const reads = new SqliteDividendReads(db);
    reads.recordRead(
      'history',
      '2026-10-01',
      {
        symbol: 'VOD.LSE',
        from: '2023-01-01',
        to: '2025-01-01',
        asOf: '2025-01-02',
        dividends: [],
      },
      NOW,
    );
    const asked: [string, SplitsWindow][] = [];
    const deps = { eodhd: reader(asked), reads, clock: { now: () => NOW }, market: MARKET };
    const report = await fillDividendHistory(deps, names, WINDOW);
    expect(asked).toEqual([
      ['AAPL.US', { from: '2023-12-30', to: '2026-10-22' }],
      ['NEW.US', { from: '2024-01-02', to: '2026-10-22' }],
      ['LIMIT.US', { from: '2023-12-30', to: '2026-10-22' }],
      ['BOOM.US', { from: '2023-12-30', to: '2026-10-22' }],
    ]);
    expect(report).toEqual({
      fetched: ['AAPL.US', 'NEW.US'],
      held: ['VOD.LSE'],
      failed: [
        { symbol: 'LIMIT.US', reason: 'http_429' },
        { symbol: 'BOOM.US', reason: 'unexpected_error' },
      ],
    });
    expect(
      historyDividendFeed(reads).across('AAPL', 'US', { after: '2023-12-29', through: WINDOW.to }),
    ).toEqual({ kind: 'covered', dividends: [{ exDate: '2024-05-10', perShare: 0.25 }] });
    expect(
      db
        .prepare(
          "SELECT symbol, purpose, trading_date, reason FROM v2_dividend_reads WHERE status = 'error'",
        )
        .all(),
    ).toEqual([
      { symbol: 'LIMIT.US', purpose: 'history', trading_date: '2026-10-23', reason: 'http_429' },
      {
        symbol: 'BOOM.US',
        purpose: 'history',
        trading_date: '2026-10-23',
        reason: 'unexpected_error',
      },
    ]);

    asked.length = 0;
    const again = await fillDividendHistory(deps, names, WINDOW);
    expect(asked.map(([symbol]) => symbol)).toEqual(['LIMIT.US', 'BOOM.US']);
    expect(again.held).toEqual(['VOD.LSE', 'AAPL.US', 'NEW.US']);
  });
});
