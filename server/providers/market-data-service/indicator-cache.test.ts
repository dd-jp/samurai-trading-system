import { describe, expect, it } from 'vitest';
import { IndicatorCache } from './indicator-cache.js';
import type { IndicatorValue } from './types.js';

function value(price: number): IndicatorValue {
  return { value: price, asOf: new Date('2026-01-01T00:00:00Z') } as unknown as IndicatorValue;
}

describe('IndicatorCache eviction', () => {
  it('round-trips within capacity', () => {
    const cache = new IndicatorCache(2);
    cache.set('a', value(1));
    expect(cache.get('a')?.value).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry once full', () => {
    const cache = new IndicatorCache(2);
    cache.set('a', value(1));
    cache.set('b', value(2));
    // Touch 'a' so 'b' is the coldest when 'c' arrives
    cache.get('a');
    cache.set('c', value(3));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.value).toBe(1);
    expect(cache.get('c')?.value).toBe(3);
  });

  it('overwriting an existing key does not evict', () => {
    const cache = new IndicatorCache(2);
    cache.set('a', value(1));
    cache.set('b', value(2));
    cache.set('a', value(10));

    expect(cache.get('a')?.value).toBe(10);
    expect(cache.get('b')?.value).toBe(2);
  });
});
