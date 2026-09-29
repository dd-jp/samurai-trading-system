import type { V2Bar } from '../../../../contracts/index.js';
import { atrInRawTerms, shapeValid, simpleMovingAverage } from './bar-quality.js';

function bar(overrides: Partial<V2Bar> = {}): V2Bar {
  return {
    date: '2026-01-01',
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    rawClose: 100,
    volume: 1000,
    ...overrides,
  };
}

describe('shapeValid', () => {
  it('accepts a bar whose open/close sit within its own high/low', () => {
    expect(shapeValid(bar())).toBe(true);
  });

  it('rejects a bar whose open or close falls outside its high/low', () => {
    expect(shapeValid(bar({ open: 102 }))).toBe(false);
    expect(shapeValid(bar({ close: 98 }))).toBe(false);
  });
});

describe('simpleMovingAverage', () => {
  it('averages the trailing window only', () => {
    const bars = [bar({ close: 1 }), bar({ close: 2 }), bar({ close: 3 }), bar({ close: 4 })];
    expect(simpleMovingAverage(bars, 2)).toBe(3.5);
  });

  it('returns undefined when there is not enough history', () => {
    expect(simpleMovingAverage([bar()], 2)).toBeUndefined();
  });
});

describe('atrInRawTerms', () => {
  it('rescales ATR by the last bar’s own rawClose/close ratio', () => {
    expect(atrInRawTerms(2, bar({ close: 100, rawClose: 1000 }))).toBe(20);
  });

  it('passes undefined through unchanged', () => {
    expect(atrInRawTerms(undefined, bar())).toBeUndefined();
  });
});
