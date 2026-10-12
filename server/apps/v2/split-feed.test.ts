import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../shared/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import {
  AlpacaSplitsError,
  EodhdRequestError,
  type EodhdSplit,
  type SplitsWindow,
  SqliteSplitReads,
} from './data/index.js';
import { SqliteSplitChecks } from './split-checks.js';
import {
  journalledSplitFeed,
  liveSplitFeed,
  mergedWindows,
  type SplitsReader,
} from './split-feed.js';

const DATE = '2026-10-05';
const SPLIT: readonly EodhdSplit[] = [{ date: '2026-10-02', ratio: 2 }];

function reader(
  result: readonly EodhdSplit[] | Error,
  calls: [string, SplitsWindow][] = [],
): SplitsReader {
  return {
    splits: (symbol, window) => {
      calls.push([symbol, window]);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ symbol, ...window, asOf: window.to, splits: [...result] });
    },
  };
}

function rows(db: ReturnType<typeof migratedMemoryStore>) {
  return db
    .prepare(
      'SELECT trading_date, source, symbol, from_date, to_date, as_of, status, reason, splits, fetched_at FROM v2_split_reads ORDER BY read_id',
    )
    .all();
}

function feedWith(eodhd: SplitsReader, alpaca: SplitsReader | undefined) {
  const db = migratedMemoryStore();
  const clock = new SimulatedClock(new Date(`${DATE}T07:00:00.000Z`));
  const reads = new SqliteSplitReads(db);
  const checks = new SqliteSplitChecks(db, clock);
  return { db, reads, checks, feed: liveSplitFeed({ eodhd, alpaca, reads, checks, clock }) };
}

describe('mergedWindows', () => {
  it('reads each line once from its earliest window start through the trading date', () => {
    expect(
      mergedWindows(
        [
          { instrument: 'AAPL', exchange: 'US', after: '2026-09-30' },
          { instrument: 'AAPL', exchange: 'US', after: '2026-09-28' },
          { instrument: 'AAPL', exchange: 'US', after: '2026-09-29' },
          { instrument: 'AAPL', exchange: 'LSE', after: '2026-10-01' },
          { instrument: 'NEW', exchange: 'US', after: DATE },
          { instrument: 'EDGE', exchange: 'US', after: '2026-10-04' },
        ],
        DATE,
      ),
    ).toEqual([
      { instrument: 'AAPL', exchange: 'US', from: '2026-09-29', to: DATE },
      { instrument: 'AAPL', exchange: 'LSE', from: '2026-10-02', to: DATE },
      { instrument: 'EDGE', exchange: 'US', from: DATE, to: DATE },
    ]);
  });
});

describe('liveSplitFeed', () => {
  it('journals an EODHD read per line and an Alpaca read for US lines only', async () => {
    const eodhdCalls: [string, SplitsWindow][] = [];
    const alpacaCalls: [string, SplitsWindow][] = [];
    const { db, feed } = feedWith(reader(SPLIT, eodhdCalls), reader(SPLIT, alpacaCalls));
    await feed.refresh(
      [
        { instrument: 'AAPL', exchange: 'US', after: '2026-09-30' },
        { instrument: 'BP', exchange: 'LSE', after: '2026-09-30' },
      ],
      DATE,
    );
    const window = { from: '2026-10-01', to: DATE };
    expect(eodhdCalls).toEqual([
      ['AAPL.US', window],
      ['BP.LSE', window],
    ]);
    expect(alpacaCalls).toEqual([['AAPL', window]]);
    expect(rows(db)).toEqual([
      {
        trading_date: DATE,
        source: 'eodhd',
        symbol: 'AAPL.US',
        from_date: '2026-10-01',
        to_date: DATE,
        as_of: DATE,
        status: 'ok',
        reason: '',
        splits: JSON.stringify(SPLIT),
        fetched_at: `${DATE}T07:00:00.000Z`,
      },
      expect.objectContaining({ source: 'alpaca', symbol: 'AAPL', status: 'ok' }),
      expect.objectContaining({ source: 'eodhd', symbol: 'BP.LSE', status: 'ok' }),
    ]);
    expect(feed.sources('AAPL', 'US', DATE)).toEqual({
      eodhd: [{ symbol: 'AAPL.US', from: '2026-10-01', to: DATE, asOf: DATE, splits: SPLIT }],
      alpaca: [{ symbol: 'AAPL', from: '2026-10-01', to: DATE, asOf: DATE, splits: SPLIT }],
    });
    expect(feed.sources('BP', 'LSE', DATE).alpaca).toBeUndefined();
  });

  it('skips a read the day already holds from as early a start, and re-reads one that starts later', async () => {
    const calls: [string, SplitsWindow][] = [];
    const { feed } = feedWith(reader(SPLIT, calls), undefined);
    const line = (after: string) => [{ instrument: 'BP', exchange: 'LSE' as const, after }];
    await feed.refresh(line('2026-09-30'), DATE);
    await feed.refresh(line('2026-09-30'), DATE);
    await feed.refresh(line('2026-10-01'), DATE);
    expect(calls).toHaveLength(1);
    await feed.refresh(line('2026-09-29'), DATE);
    expect(calls).toHaveLength(2);
  });

  it('journals a failed read with its reason, and a missing Alpaca key as one', async () => {
    const cases: [Error, string][] = [
      [new EodhdRequestError('http_429'), 'http_429'],
      [new AlpacaSplitsError('timeout'), 'timeout'],
      [new Error('boom'), 'unexpected_error'],
    ];
    for (const [error, reason] of cases) {
      const { db, feed } = feedWith(reader(error), undefined);
      await feed.refresh([{ instrument: 'AAPL', exchange: 'US', after: '2026-09-30' }], DATE);
      expect(rows(db)).toEqual([
        expect.objectContaining({
          source: 'eodhd',
          status: 'error',
          reason,
          as_of: null,
          splits: '[]',
        }),
        expect.objectContaining({ source: 'alpaca', status: 'error', reason: 'no_alpaca_key' }),
      ]);
      expect(feed.sources('AAPL', 'US', DATE)).toEqual({ eodhd: [], alpaca: [] });
    }
  });
});

describe('journalledSplitFeed', () => {
  it('answers from the journal on a day that read, never fetching, and is absent otherwise', async () => {
    const { reads, checks, feed } = feedWith(reader(SPLIT), reader(SPLIT));
    await feed.refresh([{ instrument: 'AAPL', exchange: 'US', after: '2026-09-30' }], DATE);
    expect(journalledSplitFeed(reads, checks, '2026-10-06')).toBeUndefined();
    const replayed = journalledSplitFeed(reads, checks, DATE);
    expect(replayed?.checks).toBe(checks);
    await replayed?.refresh([{ instrument: 'MSFT', exchange: 'US', after: '2026-09-01' }], DATE);
    expect(replayed?.sources('AAPL', 'US', DATE)).toEqual(feed.sources('AAPL', 'US', DATE));
    expect(replayed?.sources('MSFT', 'US', DATE)).toEqual({ eodhd: [], alpaca: [] });
  });
});
