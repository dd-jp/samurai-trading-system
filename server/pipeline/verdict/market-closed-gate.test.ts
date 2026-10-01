import { describe, expect, it } from 'vitest';
import type { OrderIntent } from '../../shared/index.js';
import { isMarketClosedFor } from './index.js';

const NOW = new Date('2026-07-15T22:00:00Z');

function intent(asset_class: string, mandatory_flatten?: boolean): OrderIntent {
  return { asset_class, metadata: { mandatory_flatten } } as unknown as OrderIntent;
}

function calendar(open: boolean): { isOpen: (at: Date) => boolean; calls: Date[] } {
  const calls: Date[] = [];
  return {
    calls,
    isOpen: (at) => {
      calls.push(at);
      return open;
    },
  };
}

describe('isMarketClosedFor', () => {
  it('closes a stock entry outside regular hours', () => {
    expect(
      isMarketClosedFor(intent('stocks'), { allow_extended_hours: false }, calendar(false), NOW),
    ).toBe(true);
  });

  it.each([
    ['the market is open', intent('stocks'), false, calendar(true)],
    ['extended hours are allowed', intent('stocks'), true, calendar(false)],
    ['the order is a mandatory flatten', intent('stocks', true), false, calendar(false)],
    ['the asset is not a stock', intent('crypto'), false, calendar(false)],
  ])('lets the order through when %s', (_label, order, allow_extended_hours, cal) => {
    expect(isMarketClosedFor(order, { allow_extended_hours }, cal, NOW)).toBe(false);
  });

  it('never reads the calendar for a non-stock or when extended hours are allowed', () => {
    const cal = calendar(false);
    isMarketClosedFor(intent('crypto'), { allow_extended_hours: false }, cal, NOW);
    isMarketClosedFor(intent('stocks'), { allow_extended_hours: true }, cal, NOW);
    expect(cal.calls).toEqual([]);
  });
});
