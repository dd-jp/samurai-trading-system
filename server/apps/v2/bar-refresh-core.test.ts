import { describe, expect, it } from 'vitest';
import { type BarRefresh, type BarRefreshReport, inSequence } from './bar-refresh-core.js';

const report = (symbol: string, failed: readonly string[] = []): BarRefreshReport => ({
  attempted: 2,
  updated: [{ symbol, bars: 3, unitBreaks: 0 }],
  noNewBars: [`${symbol}-quiet`],
  failed: failed.map((name) => ({ symbol: name, reason: 'x' })),
});

describe('inSequence', () => {
  it('runs each refresh in order and merges the reports', async () => {
    const order: string[] = [];
    const step = (symbol: string, failed?: readonly string[]): BarRefresh => ({
      run: async () => {
        order.push(symbol);
        return report(symbol, failed);
      },
    });
    const merged = await inSequence([step('A'), step('B', ['Z'])]).run();
    expect(order).toEqual(['A', 'B']);
    expect(merged).toEqual({
      attempted: 4,
      updated: [
        { symbol: 'A', bars: 3, unitBreaks: 0 },
        { symbol: 'B', bars: 3, unitBreaks: 0 },
      ],
      noNewBars: ['A-quiet', 'B-quiet'],
      failed: [{ symbol: 'Z', reason: 'x' }],
    });
  });

  it('stops at the first refresh that throws and never starts the next', async () => {
    let secondRan = false;
    const refresh = inSequence([
      { run: () => Promise.reject(new Error('SPY stale')) },
      {
        run: () => {
          secondRan = true;
          return Promise.resolve(report('B'));
        },
      },
    ]);
    await expect(refresh.run()).rejects.toThrow('SPY stale');
    expect(secondRan).toBe(false);
  });

  it('merges nothing into an empty report', async () => {
    await expect(inSequence([]).run()).resolves.toEqual({
      attempted: 0,
      updated: [],
      noNewBars: [],
      failed: [],
    });
  });
});
