import { describe, expect, it } from 'vitest';
import {
  type BarRefresh,
  type BarRefreshReport,
  inSequence,
  withinTimeLimit,
} from './bar-refresh-core.js';

describe('withinTimeLimit', () => {
  it('returns the work result inside the limit and leaves its signal unaborted', async () => {
    let seen: AbortSignal | undefined;
    const result = await withinTimeLimit(
      1_000,
      async (signal) => {
        seen = signal;
        return 'done';
      },
      () => 'expired',
    );
    expect(result).toBe('done');
    expect(seen?.aborted).toBe(false);
  });

  it('returns the expiry result at the limit, aborts the work and absorbs its later rejection', async () => {
    let seen: AbortSignal | undefined;
    let reject: (error: Error) => void = () => undefined;
    const result = await withinTimeLimit(
      10,
      (signal) => {
        seen = signal;
        return new Promise<string>((_resolve, rejectWork) => {
          reject = rejectWork;
        });
      },
      () => 'expired',
    );
    expect(result).toBe('expired');
    expect(seen?.aborted).toBe(true);
    reject(new Error('late'));
  });

  it('passes a rejection inside the limit through', async () => {
    await expect(
      withinTimeLimit(
        1_000,
        () => Promise.reject(new Error('boom')),
        () => 'expired',
      ),
    ).rejects.toThrow('boom');
  });
});

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
