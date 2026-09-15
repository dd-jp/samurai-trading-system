import { describe, expect, it } from 'vitest';
import { makePosition } from '../test-fixtures.ts';
import { deployedNotional, openRiskRow } from './glance.ts';

describe('openRiskRow', () => {
  it('measures a long’s stop distance downward and its progress toward the target', () => {
    const row = openRiskRow(
      makePosition({ side: 'buy', mark_price: 100, stop: 95, target: 110, filled_size: 3 }),
    );
    expect(row.stopDistance).toBeCloseTo(0.05);
    expect(row.progress).toBeCloseTo(5 / 15);
    expect(row.notional).toBe(300);
  });

  it('measures a short’s stop distance upward', () => {
    const row = openRiskRow(
      makePosition({ side: 'sell', mark_price: 100, stop: 104, target: 90, filled_size: 1 }),
    );
    expect(row.stopDistance).toBeCloseTo(0.04);
    expect(row.progress).toBeCloseTo((100 - 104) / (90 - 104));
  });

  it('reports a mark through the stop as a negative distance, and clamps progress', () => {
    const row = openRiskRow(makePosition({ side: 'buy', mark_price: 90, stop: 95, target: 110 }));
    expect(row.stopDistance).toBeLessThan(0);
    expect(row.progress).toBe(0);
  });

  it('refuses to draw a bracket with no width', () => {
    const row = openRiskRow(makePosition({ stop: 100, target: 100, mark_price: 100 }));
    expect(row.progress).toBeNull();
  });
});

describe('deployedNotional', () => {
  it('sums size × mark over the open positions', () => {
    expect(
      deployedNotional([
        makePosition({ filled_size: 2, mark_price: 10 }),
        makePosition({ filled_size: 1, mark_price: 5 }),
      ]),
    ).toBe(25);
  });
});
