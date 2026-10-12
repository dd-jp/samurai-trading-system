import { describe, expect, it } from 'vitest';
import type { EodhdSplit, SplitsRead } from './data/index.js';
import { splitRatioAcross } from './split.js';
import { crossCheckSplits, exchangeOf, sameSplits } from './split-crosscheck.js';

const WINDOW = { after: '2026-09-25', through: '2026-09-29' };
const NO_STEP = { ratio: 1, steps: [], rejected: [] };

function read(
  symbol: string,
  splits: readonly EodhdSplit[],
  overrides: Partial<SplitsRead> = {},
): SplitsRead {
  return { symbol, from: '2026-09-26', to: '2026-09-30', asOf: '2026-09-30', splits, ...overrides };
}

const SPLIT: readonly EodhdSplit[] = [{ date: '2026-09-28', ratio: 1.2 }];

describe('exchangeOf', () => {
  it('maps each venue to the exchange its splits are read on', () => {
    expect(exchangeOf('alpaca')).toBe('US');
    expect(exchangeOf('saxo_cfd_usd')).toBe('US');
    expect(exchangeOf('saxo')).toBe('LSE');
    expect(exchangeOf('saxo_cfd_gbp')).toBe('LSE');
  });
});

describe('sameSplits', () => {
  it('matches date by date within a part in a million', () => {
    expect(sameSplits([], [])).toBe(true);
    expect(sameSplits(SPLIT, [{ date: '2026-09-28', ratio: 1.2 * (1 + 9e-7) }])).toBe(true);
    expect(sameSplits(SPLIT, [{ date: '2026-09-28', ratio: 1.2 * (1 + 2e-6) }])).toBe(false);
    expect(sameSplits(SPLIT, [{ date: '2026-09-29', ratio: 1.2 }])).toBe(false);
    expect(sameSplits(SPLIT, [])).toBe(false);
    expect(sameSplits([], SPLIT)).toBe(false);
  });
});

describe('crossCheckSplits', () => {
  it('agrees on the EODHD reading when Alpaca lists the same splits', () => {
    expect(
      crossCheckSplits(
        { eodhd: [read('AAPL.US', SPLIT)], alpaca: [read('AAPL', SPLIT)] },
        WINDOW,
        NO_STEP,
      ),
    ).toEqual({
      kind: 'agree',
      reading: { ratio: 1.2, steps: [{ date: '2026-09-28', ratio: 1.2 }], rejected: [] },
      unconfirmed: [],
    });
  });

  it('multiplies two listed splits and checks an LSE line on EODHD alone', () => {
    const two: EodhdSplit[] = [
      { date: '2026-09-26', ratio: 2 },
      { date: '2026-09-29', ratio: 1 / 200 },
    ];
    const verdict = crossCheckSplits(
      { eodhd: [read('BP.LSE', two)], alpaca: undefined },
      WINDOW,
      NO_STEP,
    );
    expect(verdict).toMatchObject({ kind: 'agree', reading: { ratio: 0.01, steps: two } });
  });

  it('flags a bar step EODHD does not list, and accepts one within 1% of a listed ratio', () => {
    const detected = {
      ratio: 10 * 1.2,
      steps: [
        { date: '2026-09-27', ratio: 10 },
        { date: '2026-09-28', ratio: 1.2 * 1.0099 },
      ],
      rejected: [],
    };
    expect(
      crossCheckSplits({ eodhd: [read('AAPL.US', SPLIT)], alpaca: undefined }, WINDOW, detected),
    ).toMatchObject({ kind: 'agree', unconfirmed: [{ date: '2026-09-27', ratio: 10 }] });
    const off = { ...detected, steps: [{ date: '2026-09-28', ratio: 1.2 * 1.0101 }] };
    expect(
      crossCheckSplits({ eodhd: [read('AAPL.US', SPLIT)], alpaca: undefined }, WINDOW, off),
    ).toMatchObject({ unconfirmed: off.steps });
  });

  it('blocks when either source leaves the window uncovered or conflicts', () => {
    expect(crossCheckSplits({ eodhd: [], alpaca: [read('AAPL', SPLIT)] }, WINDOW, NO_STEP)).toEqual(
      {
        kind: 'block',
        reason: 'eodhd_uncovered',
        detail: 'eodhd reads do not cover 2026-09-26 onward',
      },
    );
    const conflicting = [read('AAPL.US', SPLIT), read('AAPL.US', [])];
    expect(crossCheckSplits({ eodhd: conflicting, alpaca: undefined }, WINDOW, NO_STEP)).toEqual({
      kind: 'block',
      reason: 'eodhd_conflict',
      detail: 'eodhd reads disagree on 2026-09-28',
    });
    expect(
      crossCheckSplits(
        { eodhd: [read('AAPL.US', SPLIT)], alpaca: [read('AAPL', SPLIT, { asOf: '2026-09-29' })] },
        WINDOW,
        NO_STEP,
      ),
    ).toEqual({
      kind: 'block',
      reason: 'alpaca_uncovered',
      detail: 'alpaca reads do not cover 2026-09-29 onward',
    });
    expect(
      crossCheckSplits(
        { eodhd: [read('AAPL.US', SPLIT)], alpaca: [read('AAPL', SPLIT), read('AAPL', [])] },
        WINDOW,
        NO_STEP,
      ),
    ).toMatchObject({ kind: 'block', reason: 'alpaca_conflict' });
    expect(
      crossCheckSplits({ eodhd: [read('AAPL.US', SPLIT)], alpaca: [] }, WINDOW, NO_STEP),
    ).toMatchObject({ kind: 'block', reason: 'alpaca_uncovered' });
  });

  it('blocks and names both lists when the sources disagree', () => {
    expect(
      crossCheckSplits(
        {
          eodhd: [read('AAPL.US', SPLIT)],
          alpaca: [read('AAPL', [{ date: '2026-09-28', ratio: 1.5 }])],
        },
        WINDOW,
        NO_STEP,
      ),
    ).toEqual({
      kind: 'block',
      reason: 'sources_disagree',
      detail: 'EODHD lists x1.2 on 2026-09-28, Alpaca x1.5 on 2026-09-28',
    });
    expect(
      crossCheckSplits(
        { eodhd: [read('AAPL.US', [])], alpaca: [read('AAPL', SPLIT)] },
        WINDOW,
        NO_STEP,
      ),
    ).toMatchObject({ detail: 'EODHD lists no split, Alpaca x1.2 on 2026-09-28' });
    const two: EodhdSplit[] = [...SPLIT, { date: '2026-09-29', ratio: 2 }];
    expect(
      crossCheckSplits(
        { eodhd: [read('AAPL.US', two)], alpaca: [read('AAPL', SPLIT)] },
        WINDOW,
        NO_STEP,
      ),
    ).toMatchObject({
      detail: 'EODHD lists x1.2 on 2026-09-28, x2 on 2026-09-29, Alpaca x1.2 on 2026-09-28',
    });
  });

  it('reads a real bar step through splitRatioAcross', () => {
    const bars = [
      { date: '2026-09-25', open: 10, high: 10, low: 10, close: 10, volume: 1, rawClose: 20 },
      { date: '2026-09-28', open: 10, high: 10, low: 10, close: 10, volume: 1, rawClose: 10 },
    ];
    expect(
      crossCheckSplits(
        { eodhd: [read('AAPL.US', [])], alpaca: undefined },
        WINDOW,
        splitRatioAcross(bars),
      ),
    ).toMatchObject({
      kind: 'agree',
      reading: { ratio: 1 },
      unconfirmed: [{ date: '2026-09-28', ratio: 2 }],
    });
  });
});
