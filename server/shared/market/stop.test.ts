import type { DailyBar } from './bars.js';
import {
  ATR_WINDOW,
  averageTrueRange,
  neverMovedUp,
  restingStopLevel,
  STOP_ATR_MULTIPLE,
  stopFillPrice,
  stopTriggered,
  trueRange,
} from './stop.js';

function bar(
  open: number,
  high: number,
  low: number,
  close: number,
  date = '2024-01-01',
): DailyBar {
  return { date, open, high, low, close, volume: 0, rawClose: close };
}

describe('trueRange', () => {
  it('is the widest of the bar range and the gaps from the previous close', () => {
    expect(trueRange(bar(10, 12, 9, 11), 11)).toBe(3);
    expect(trueRange(bar(10, 12, 9, 11), 15)).toBe(6);
    expect(trueRange(bar(10, 12, 9, 11), 5)).toBe(7);
  });
});

describe('averageTrueRange', () => {
  const bars = [bar(10, 11, 9, 10), bar(10, 12, 9, 11), bar(11, 13, 10, 12), bar(12, 14, 11, 13)];

  it('averages the true range over the window ending at the index', () => {
    expect(averageTrueRange(bars, 3, 2)).toBeCloseTo((3 + 3) / 2);
    expect(averageTrueRange(bars, 3, 3)).toBeCloseTo((3 + 3 + 3) / 3);
  });

  it('is undefined without a full window plus the prior close', () => {
    expect(averageTrueRange(bars, 3, 4)).toBeUndefined();
    expect(averageTrueRange(bars, 1, 1)).toBeCloseTo(3);
    expect(averageTrueRange(bars, 0, 1)).toBeUndefined();
    expect(averageTrueRange(bars, 4, 1)).toBeUndefined();
  });

  it('defaults to the 20-day window and rejects a window under one', () => {
    expect(ATR_WINDOW).toBe(20);
    expect(averageTrueRange(bars, 3)).toBeUndefined();
    expect(() => averageTrueRange(bars, 3, 0)).toThrow(/window/);
  });
});

describe('restingStopLevel', () => {
  it('sits the configured ATR multiple below entry', () => {
    expect(STOP_ATR_MULTIPLE).toBe(2);
    expect(restingStopLevel(100, 3)).toBe(94);
    expect(restingStopLevel(100, 3, 1)).toBe(97);
  });

  it('accepts a zero ATR', () => {
    expect(restingStopLevel(100, 0)).toBe(100);
  });

  it('rejects a non-positive entry or multiple and a negative ATR', () => {
    expect(() => restingStopLevel(0, 1)).toThrow(/bad inputs/);
    expect(() => restingStopLevel(100, -1)).toThrow(/bad inputs/);
    expect(() => restingStopLevel(100, 1, 0)).toThrow(/bad inputs/);
  });
});

describe('neverMovedUp', () => {
  it('keeps the lower of the existing stop and the candidate', () => {
    expect(neverMovedUp(undefined, 95)).toBe(95);
    expect(neverMovedUp(90, 95)).toBe(90);
    expect(neverMovedUp(95, 90)).toBe(90);
  });
});

describe('stopTriggered and stopFillPrice', () => {
  it('triggers when the low touches the stop', () => {
    expect(stopTriggered(bar(100, 101, 94, 97), 94)).toBe(true);
    expect(stopTriggered(bar(100, 101, 94.01, 97), 94)).toBe(false);
  });

  it('fills at the stop when the open equals the stop', () => {
    expect(stopFillPrice(bar(94, 95, 90, 92), 94, 0)).toBe(94);
  });

  it('fills at the stop less half spread, or at the open when the open gaps below', () => {
    expect(stopFillPrice(bar(100, 101, 90, 95), 94, 0.001)).toBeCloseTo(94 * 0.999);
    expect(stopFillPrice(bar(88, 91, 85, 90), 94, 0.001)).toBeCloseTo(88 * 0.999);
  });
});
