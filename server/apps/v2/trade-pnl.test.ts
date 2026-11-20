import { describe, expect, it } from 'vitest';
import { profitFactor } from './trade-pnl.js';

describe('profitFactor', () => {
  it('divides gross wins by gross losses', () => {
    expect(profitFactor([30, -10, 15, -5, 0])).toBe(45 / 15);
  });

  it('has no value with no losing trade, never Infinity', () => {
    expect(profitFactor([12, 3])).toBeNull();
    expect(profitFactor([])).toBeNull();
    expect(profitFactor([0])).toBeNull();
  });

  it('is 0 when every trade lost', () => {
    expect(profitFactor([-4, -6])).toBe(0);
  });

  it('reads a single losing trade as 0 and a single winner as no value', () => {
    expect(profitFactor([-2.5])).toBe(0);
    expect(profitFactor([2.5])).toBeNull();
  });
});
