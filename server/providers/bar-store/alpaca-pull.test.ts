import { describe, expect, it } from 'vitest';
import type { RawDailyBar } from './index.js';
import {
  AlpacaBarsApi,
  alpacaSymbolCandidates,
  barDate,
  joinAdjustedAndRaw,
  pullSymbol,
} from './index.js';

describe('alpaca pull helpers', () => {
  const rawBar = (t: string, c: number): RawDailyBar => ({ t, o: c, h: c, l: c, c, v: 1 });

  it('joins adjusted OHLCV with the raw close by date', () => {
    const joined = joinAdjustedAndRaw(
      'X',
      [rawBar('2016-01-04T05:00:00Z', 10)],
      [rawBar('2016-01-04T05:00:00Z', 40)],
    );
    expect(joined).toEqual([
      { date: '2016-01-04', open: 10, high: 10, low: 10, close: 10, volume: 1, rawClose: 40 },
    ]);
    expect(() => joinAdjustedAndRaw('X', [rawBar('2016-01-04T05:00:00Z', 10)], [])).toThrow(
      /no raw counterpart/,
    );
    expect(barDate('2016-01-04T05:00:00Z')).toBe('2016-01-04');
  });

  it('tries the dotted ticker then the dot-stripped Alpaca symbol', async () => {
    expect(alpacaSymbolCandidates('BRK.B')).toEqual(['BRK.B', 'BRKB']);
    expect(alpacaSymbolCandidates('AAPL')).toEqual(['AAPL']);
    const requested: string[] = [];
    const api = new AlpacaBarsApi(
      { apiKey: 'k', apiSecret: 's' },
      async (url) => {
        const symbol = new URL(url).searchParams.get('symbols') as string;
        requested.push(symbol);
        return {
          status: 200,
          body: { bars: symbol === 'BRKB' ? { BRKB: [rawBar('2016-01-04T05:00:00Z', 1)] } : {} },
        };
      },
      async () => {},
      0,
    );
    const pulled = await pullSymbol(api, 'BRK.B', '2016-01-04', '2016-01-05');
    expect(pulled?.alpacaSymbol).toBe('BRKB');
    expect(requested).toEqual(['BRK.B', 'BRKB', 'BRKB']);
    expect(await pullSymbol(api, 'NONE', '2016-01-04', '2016-01-05')).toBeUndefined();
  });
});
