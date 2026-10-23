import type { Sleeve } from '../../../contracts/index.js';
import { assertDividendHistoryCovers, cfdNamesInUniverse } from './backtest-dividends.js';
import type { CfdDividendFeed } from './dividend-feed.js';

function sleeve(byDate: Record<string, readonly string[]>, seen: string[]): Sleeve {
  return {
    id: 'arm2',
    spec: {} as Sleeve['spec'],
    universe: (context) => {
      seen.push(context.tradingDate);
      return { instruments: byDate[context.tradingDate] ?? [], refusals: [] };
    },
    decide: () => Promise.resolve({ decisions: [], refusals: [] }),
  };
}

describe('cfdNamesInUniverse', () => {
  it('collects every name with a CFD line any sleeve can enter on any session', () => {
    const seen: string[] = [];
    const today = { current: '2024-01-01' };
    const fenced: string[] = [];
    const names = cfdNamesInUniverse(
      [
        sleeve({ '2024-01-02': ['AAPL', 'CSP1'], '2024-01-03': ['VOD_XLON'] }, seen),
        {
          ...sleeve({ '2024-01-03': ['MSFT'] }, seen),
          universe: (context) => {
            fenced.push(today.current);
            return {
              instruments: context.tradingDate === '2024-01-03' ? ['MSFT'] : [],
              refusals: [],
            };
          },
        },
      ],
      ['2024-01-02', '2024-01-03'],
      today,
      (instrument) =>
        instrument === 'CSP1' ? undefined : instrument.endsWith('_XLON') ? 'LSE' : 'US',
    );
    expect([...names]).toEqual([
      ['AAPL', 'US'],
      ['VOD_XLON', 'LSE'],
      ['MSFT', 'US'],
    ]);
    expect(seen).toEqual(['2024-01-02', '2024-01-03']);
    expect(fenced).toEqual(['2024-01-02', '2024-01-03']);
    expect(today.current).toBe('2024-01-01');
  });
});

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
  const input = {
    market: {
      lastBarBefore: (instrument: string) =>
        instrument === 'NEW' ? undefined : ({ date: '2023-12-29' } as never),
    },
    from: '2024-01-02',
    to: '2024-12-31',
    dividends: { feed, cfdExchangeOf: () => 'US' as const },
  };

  it('checks each name from the bar before the window opens through its end', () => {
    asked.length = 0;
    assertDividendHistoryCovers(
      input,
      new Map([
        ['AAPL', 'US'],
        ['NEW', 'US'],
      ]),
    );
    expect(asked).toEqual(['AAPL US 2023-12-29..2024-12-31', 'NEW US 2024-01-01..2024-12-31']);
  });

  it('names every uncovered or conflicting name in one refusal', () => {
    expect(() =>
      assertDividendHistoryCovers(
        input,
        new Map([
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
