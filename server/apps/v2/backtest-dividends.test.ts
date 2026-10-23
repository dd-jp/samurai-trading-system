import { assertDividendHistoryCovers } from './backtest-dividends.js';
import type { EodhdExchange } from './data/index.js';
import type { CfdDividendFeed } from './dividend-feed.js';

describe('assertDividendHistoryCovers', () => {
  const asked: string[] = [];
  const feed: CfdDividendFeed = {
    refresh: () => Promise.resolve(),
    across: (instrument, exchange, window) => {
      asked.push(`${instrument} ${exchange} ${window.after}..${window.through}`);
      if (instrument === 'GAP') return { kind: 'uncovered', from: '2024-06-03' };
      if (instrument === 'ODD') return { kind: 'conflict', date: '2024-07-01' };
      return { kind: 'covered', dividends: [] };
    },
  };
  const input = (names: readonly (readonly [string, EodhdExchange])[]) => ({
    market: {
      lastBarBefore: (instrument: string) =>
        instrument === 'NEW' ? undefined : ({ date: '2023-12-29' } as never),
    },
    from: '2024-01-02',
    to: '2024-12-31',
    dividends: { feed, names: new Map(names) },
  });

  it('checks each name from the bar before the window opens through its end', () => {
    asked.length = 0;
    assertDividendHistoryCovers(
      input([
        ['AAPL', 'US'],
        ['NEW', 'US'],
      ]),
    );
    expect(asked).toEqual(['AAPL US 2023-12-29..2024-12-31', 'NEW US 2024-01-01..2024-12-31']);
  });

  it('names every uncovered or conflicting name in one refusal', () => {
    expect(() =>
      assertDividendHistoryCovers(
        input([
          ['AAPL', 'US'],
          ['GAP', 'US'],
          ['ODD', 'US'],
        ]),
      ),
    ).toThrow(
      'backtest: the stored CFD dividend history does not cover 2024-01-02 to 2024-12-31 for GAP from 2024-06-03, ODD disagrees on 2024-07-01; fill it before a counted run (#2143)',
    );
  });
});
