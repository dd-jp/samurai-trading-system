import { describe, expect, it } from 'vitest';
import type { V2Bar } from '../../../contracts/index.js';
import { type LimitEntry, simulateLimitEntry, simulateMarketExit } from './simulated-entry.js';

function bar(date: string, overrides: Partial<V2Bar> = {}): V2Bar {
  return {
    date,
    open: 20,
    high: 20.5,
    low: 19.5,
    close: 20,
    volume: 1,
    rawClose: 20,
    ...overrides,
  };
}

const BUY: LimitEntry = { side: 'buy', limit: 20, stop: 19.2 };
const SELL: LimitEntry = { side: 'sell', limit: 20, stop: 20.8 };

describe('simulateLimitEntry', () => {
  it('waits while no bar has come in', () => {
    expect(simulateLimitEntry(BUY, [])).toEqual({ kind: 'pending' });
  });

  it('cancels when no bar reaches the limit', () => {
    const above = [bar('d1', { open: 20.2, low: 20.01 }), bar('d2', { open: 21, low: 20.5 })];
    expect(simulateLimitEntry(BUY, above)).toEqual({ kind: 'cancelled' });
    const below = [bar('d1', { open: 19.8, high: 19.99 })];
    expect(simulateLimitEntry(SELL, below)).toEqual({ kind: 'cancelled' });
  });

  it('fills a buy passively at the limit when the bar opens at or above it and trades down to it', () => {
    for (const open of [20, 20.3]) {
      const touched = bar('d1', { open, low: 20 });
      expect(simulateLimitEntry(BUY, [touched])).toEqual({
        kind: 'filled',
        bar: touched,
        price: 20,
        crossesSpread: false,
        stoppedAt: undefined,
      });
    }
  });

  it('fills a buy at the open across the spread when the bar opens below the limit', () => {
    const gap = bar('d1', { open: 19.6, low: 19.4 });
    expect(simulateLimitEntry(BUY, [gap])).toMatchObject({ price: 19.6, crossesSpread: true });
  });

  it('fills a short sale passively at the limit, or at a higher open across the spread', () => {
    for (const open of [19.9, 20]) {
      expect(simulateLimitEntry(SELL, [bar('d1', { open, high: 20 })])).toMatchObject({
        price: 20,
        crossesSpread: false,
      });
    }
    expect(simulateLimitEntry(SELL, [bar('d1', { open: 20.4, high: 20.6 })])).toMatchObject({
      price: 20.4,
      crossesSpread: true,
    });
  });

  it('fills on the first bar that reaches the limit', () => {
    const first = bar('d2', { low: 19.9 });
    const bars = [bar('d1', { open: 20.3, low: 20.1 }), first, bar('d3', { low: 18 })];
    expect(simulateLimitEntry(BUY, bars)).toMatchObject({ bar: first, price: 20 });
  });

  it('checks the bar in quoted prices: adjusted bars are rescaled by raw over adjusted close', () => {
    const adjusted = bar('d1', { open: 10.15, high: 10.3, low: 10.05, close: 10, rawClose: 20 });
    expect(simulateLimitEntry(BUY, [adjusted])).toEqual({ kind: 'cancelled' });
    expect(simulateLimitEntry(BUY, [{ ...adjusted, low: 9.95, open: 9.9 }])).toMatchObject({
      price: expect.closeTo(19.8, 9),
      crossesSpread: true,
    });
    const short = bar('d1', { open: 9.9, high: 10.05, low: 9.8, close: 10, rawClose: 20 });
    expect(simulateLimitEntry(SELL, [short])).toMatchObject({ price: 20, crossesSpread: false });
    expect(simulateLimitEntry(SELL, [{ ...short, high: 9.99 }])).toEqual({ kind: 'cancelled' });
  });

  it('exits on the fill bar when it also reaches the stop, at the worse of stop and fill', () => {
    const cases: readonly [LimitEntry, Partial<V2Bar>, number, number | undefined][] = [
      [BUY, { low: 19.2 }, 20, 19.2],
      [BUY, { low: 19.21 }, 20, undefined],
      [BUY, { open: 19, low: 18.9 }, 19, 19],
      [SELL, { high: 20.8 }, 20, 20.8],
      [SELL, { high: 20.79 }, 20, undefined],
      [SELL, { open: 21, high: 21.2 }, 21, 21],
      [BUY, { open: 10, high: 10.25, low: 9.6, close: 10, rawClose: 20 }, 20, 19.2],
      [{ ...BUY, stop: undefined }, { low: 1 }, 20, undefined],
      [{ ...SELL, stop: undefined }, { high: 99 }, 20, undefined],
    ];
    for (const [entry, override, price, stoppedAt] of cases) {
      expect(simulateLimitEntry(entry, [bar('d1', override)])).toMatchObject({
        kind: 'filled',
        price,
        stoppedAt,
      });
    }
  });
});

describe('simulateLimitEntry with a trigger (a stop-limit entry, #1941)', () => {
  const BUY_STOP: LimitEntry = { side: 'buy', limit: 20.8, stop: 19.9, trigger: 20.5 };
  const SELL_STOP: LimitEntry = { side: 'sell', limit: 19.2, stop: 20.1, trigger: 19.5 };
  const fill = (entry: LimitEntry, overrides: Partial<V2Bar>) =>
    simulateLimitEntry(entry, [bar('d1', { low: 19.95, high: 20.05, ...overrides })]);

  it('does not fill a buy whose bar never reaches the trigger, though it trades below the limit', () => {
    expect(fill(BUY_STOP, { open: 20, high: 20.49 })).toEqual({ kind: 'cancelled' });
  });

  it('fills a buy at the trigger when the bar opens below it and trades up through it', () => {
    for (const high of [20.5, 21]) {
      expect(fill(BUY_STOP, { open: 20, high })).toMatchObject({
        kind: 'filled',
        price: 20.5,
        crossesSpread: true,
      });
    }
  });

  it('fills a buy at an open between the trigger and the limit', () => {
    for (const open of [20.6, 20.8]) {
      expect(fill(BUY_STOP, { open, high: 21, low: open })).toMatchObject({
        price: open,
        crossesSpread: true,
      });
    }
  });

  it('fills a buy that opens above the limit only if it trades back down to it, at the limit', () => {
    expect(fill(BUY_STOP, { open: 21, high: 21.2, low: 20.7 })).toMatchObject({
      price: 20.8,
      crossesSpread: false,
    });
    expect(fill(BUY_STOP, { open: 21, high: 21.2, low: 20.81 })).toEqual({ kind: 'cancelled' });
  });

  it('mirrors every case for a sell trigger below the limit', () => {
    expect(fill(SELL_STOP, { open: 20, low: 19.51 })).toEqual({ kind: 'cancelled' });
    for (const low of [19.5, 19]) {
      expect(fill(SELL_STOP, { open: 20, low })).toMatchObject({
        price: 19.5,
        crossesSpread: true,
      });
    }
    for (const open of [19.3, 19.2]) {
      expect(fill(SELL_STOP, { open, low: 19, high: open })).toMatchObject({
        price: open,
        crossesSpread: true,
      });
    }
    expect(fill(SELL_STOP, { open: 19, low: 18.9, high: 19.3 })).toMatchObject({
      price: 19.2,
      crossesSpread: false,
    });
    expect(fill(SELL_STOP, { open: 19, low: 18.9, high: 19.19 })).toEqual({ kind: 'cancelled' });
  });
});

describe('simulateMarketExit', () => {
  it('waits while no bar has come in', () => {
    expect(simulateMarketExit([])).toBeUndefined();
  });

  it('fills at the first bar open, rescaled to the quoted price', () => {
    const bars = [bar('d1', { open: 18, close: 19, rawClose: 38 }), bar('d2', { open: 5 })];
    expect(simulateMarketExit(bars)).toBe(36);
  });
});
