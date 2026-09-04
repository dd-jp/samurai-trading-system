import { describe, expect, it } from 'vitest';
import { makeClosedTrade, makePosition } from '../test-fixtures.ts';
import { deployedNotional, openRiskRow, pnlToday } from './glance.ts';

const AS_OF = '2026-08-07T12:00:00.000Z';

describe('pnlToday', () => {
  it('counts only the closes on the snapshot’s UTC date, never the browser’s', () => {
    const today = makeClosedTrade({ idempotency_key: 'a', realized_pnl_net: 10, fees_total: 1 });
    const lateToday = makeClosedTrade({
      idempotency_key: 'b',
      closed_at: '2026-08-07T23:59:59.000Z',
      realized_pnl_net: -4,
      fees_total: 0.5,
    });
    const yesterday = makeClosedTrade({
      idempotency_key: 'c',
      closed_at: '2026-08-06T23:59:59.000Z',
      realized_pnl_net: 100,
    });
    const pnl = pnlToday([], [today, lateToday, yesterday], AS_OF);
    expect(pnl.realized).toBe(6);
    expect(pnl.costs).toBe(1.5);
    expect(pnl.closedCount).toBe(2);
  });

  it('adds every open position’s unrealized figure to the total', () => {
    const pnl = pnlToday(
      [makePosition({ unrealized_pnl: 5 }), makePosition({ unrealized_pnl: -2 })],
      [makeClosedTrade({ realized_pnl_net: 3 })],
      AS_OF,
    );
    expect(pnl.unrealized).toBe(3);
    expect(pnl.total).toBe(6);
    expect(pnl.openCount).toBe(2);
  });

  it('treats an unparseable as_of as a day with no closes rather than every close', () => {
    const pnl = pnlToday([], [makeClosedTrade()], 'not a date');
    expect(pnl.realized).toBe(0);
    expect(pnl.closedCount).toBe(0);
  });
});

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
