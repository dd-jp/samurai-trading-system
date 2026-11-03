import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  type DividendsRead,
  EodhdRequestError,
  type SplitsWindow,
  SqliteDividendReads,
} from './data/index.js';
import {
  dividendSymbol,
  historyDividendFeed,
  journalledDividendFeed,
  liveDividendFeed,
} from './dividend-feed.js';

const CLOCK = { now: () => new Date('2026-06-05T06:30:00.000Z') };
const REQUEST = {
  instrument: 'VOD_XLON',
  exchange: 'LSE' as const,
  after: '2026-06-02',
  through: '2026-06-04',
};
const WINDOW = { after: REQUEST.after, through: REQUEST.through };

const GBP_LINE = [{ exDate: '2026-06-04', perShare: 0.02, currency: 'GBP' }];

function eodhd(
  asked: [string, SplitsWindow][],
  failure?: Error,
  dividends: DividendsRead['dividends'] = GBP_LINE,
) {
  return {
    dividends: (symbol: string, window: SplitsWindow): Promise<DividendsRead> => {
      asked.push([symbol, window]);
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({
        symbol,
        ...window,
        asOf: '2026-06-05',
        dividends,
      });
    },
  };
}

describe('dividendSymbol', () => {
  it('keys a UK stock by its TIDM and anything else by its own symbol', () => {
    expect(dividendSymbol('VOD_XLON', 'LSE')).toBe('VOD.LSE');
    expect(dividendSymbol('BRK.B', 'US')).toBe('BRK-B.US');
  });
});

describe('liveDividendFeed', () => {
  it('fetches the window after the last marked bar through the day before the cycle, once', async () => {
    const reads = new SqliteDividendReads(migratedMemoryStore());
    const asked: [string, SplitsWindow][] = [];
    const feed = liveDividendFeed({ eodhd: eodhd(asked), reads, clock: CLOCK }, '2026-06-05');
    await feed.refresh([REQUEST]);
    await feed.refresh([REQUEST]);
    expect(asked).toEqual([['VOD.LSE', { from: '2026-06-03', to: '2026-06-04' }]]);
    expect(feed.across('VOD_XLON', 'LSE', WINDOW)).toEqual({
      kind: 'covered',
      dividends: [{ exDate: '2026-06-04', perShare: 0.02, currency: 'GBP' }],
    });
  });

  it('journals a failed read so the day replays without the feed answering', async () => {
    const reads = new SqliteDividendReads(migratedMemoryStore());
    const failure = new EodhdRequestError('http_429');
    const feed = liveDividendFeed({ eodhd: eodhd([], failure), reads, clock: CLOCK }, '2026-06-05');
    await feed.refresh([REQUEST]);
    expect(reads.anyCycleReadOn('2026-06-05')).toBe(true);
    expect(feed.across('VOD_XLON', 'LSE', WINDOW)).toEqual({
      kind: 'uncovered',
      from: '2026-06-03',
    });
  });

  it('journals an unexpected failure under a reason that carries nothing from the error', async () => {
    const db = migratedMemoryStore();
    const reads = new SqliteDividendReads(db);
    const feed = liveDividendFeed(
      { eodhd: eodhd([], new Error('api_token=secret')), reads, clock: CLOCK },
      '2026-06-05',
    );
    await feed.refresh([REQUEST]);
    expect(db.prepare('SELECT status, reason FROM v2_dividend_reads').all()).toEqual([
      { status: 'error', reason: 'unexpected_error' },
    ]);
  });
});

describe('journalledDividendFeed', () => {
  it('answers from the cycle reads of that day, each line in its declared currency, and is absent on a day with none', async () => {
    const reads = new SqliteDividendReads(migratedMemoryStore());
    const lines = [
      { exDate: '2026-06-03', perShare: 0.5, currency: 'USD' },
      { exDate: '2026-06-04', perShare: 0.4, currency: 'EUR' },
    ];
    const live = eodhd([], undefined, lines);
    await liveDividendFeed({ eodhd: live, reads, clock: CLOCK }, '2026-06-05').refresh([REQUEST]);
    expect(journalledDividendFeed(reads, '2026-06-06')).toBeUndefined();
    const replayed = journalledDividendFeed(reads, '2026-06-05');
    await replayed?.refresh([REQUEST]);
    expect(replayed?.across('VOD_XLON', 'LSE', WINDOW)).toEqual({
      kind: 'covered',
      dividends: lines,
    });
  });
});

describe('historyDividendFeed', () => {
  it('answers from the stored history reads and refuses a window they do not cover', () => {
    const reads = new SqliteDividendReads(migratedMemoryStore());
    reads.recordRead(
      'history',
      '2026-06-05',
      {
        symbol: 'VOD.LSE',
        from: '2026-01-01',
        to: '2026-06-03',
        asOf: '2026-06-05',
        dividends: [{ exDate: '2026-02-05', perShare: 0.04, currency: 'GBP' }],
      },
      CLOCK.now(),
    );
    const feed = historyDividendFeed(reads);
    expect(feed.across('VOD_XLON', 'LSE', { after: '2026-02-01', through: '2026-03-01' })).toEqual({
      kind: 'covered',
      dividends: [{ exDate: '2026-02-05', perShare: 0.04, currency: 'GBP' }],
    });
    expect(feed.across('VOD_XLON', 'LSE', WINDOW)).toEqual({
      kind: 'uncovered',
      from: '2026-06-04',
    });
    expect(feed.across('AAPL', 'US', WINDOW)).toEqual({ kind: 'uncovered', from: '2026-06-03' });
  });
});
