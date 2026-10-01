import { describe, expect, it } from 'vitest';
import { isFiniteNumber } from './is-finite-number.js';
import { isString, readOhlcvBar } from './ohlcv-bar.js';

describe('readOhlcvBar', () => {
  it('reads a bar whose time passes the guard and whose prices and volume are finite', () => {
    expect(readOhlcvBar({ t: 'x', o: 1, h: 2, l: 0.5, c: 1.5, v: 10, n: 3 }, isString)).toEqual({
      t: 'x',
      o: 1,
      h: 2,
      l: 0.5,
      c: 1.5,
      v: 10,
    });
  });

  it.each([
    ['a non-object', 'bar'],
    ['null', null],
    ['a time the guard refuses', { t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
    ['a non-finite price', { t: 'x', o: Number.NaN, h: 1, l: 1, c: 1, v: 1 }],
    ['a missing volume', { t: 'x', o: 1, h: 1, l: 1, c: 1 }],
  ])('refuses %s', (_label, raw) => {
    expect(readOhlcvBar(raw, isString)).toBeUndefined();
  });

  it('takes any time guard', () => {
    expect(readOhlcvBar({ t: 5, o: 1, h: 1, l: 1, c: 1, v: 1 }, isFiniteNumber)?.t).toBe(5);
  });
});
