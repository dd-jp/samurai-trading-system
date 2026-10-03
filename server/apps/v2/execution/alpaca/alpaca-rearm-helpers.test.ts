import { describe, expect, it } from 'vitest';
import { adoptableRearm, classifyPriorRearm } from './alpaca-adapter.js';
import type { AlpacaOrder } from './alpaca-client.js';

function oco(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'oco-1',
    client_order_id: 'lot-1-rearm-0',
    symbol: 'AAPL',
    side: 'sell',
    qty: '5',
    order_class: 'oco',
    status: 'new',
    filled_qty: '0',
    filled_avg_price: null,
    filled_at: null,
    limit_price: '110',
    legs: [
      {
        id: 'stop-1',
        type: 'stop',
        status: 'held',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        stop_price: '95',
      },
    ],
    ...overrides,
  };
}

describe('classifyPriorRearm', () => {
  it.each([
    ['filled', 'settled'],
    ['partially_filled', 'live'],
    ['new', 'live'],
    ['accepted', 'live'],
    ['pending_new', 'live'],
    ['accepted_for_bidding', 'live'],
    ['canceled', 'terminal'],
    ['rejected', 'terminal'],
    ['expired', 'terminal'],
    ['held', 'stale'],
    ['pending_cancel', 'stale'],
  ] as const)('reads a matching %s order as %s', (status, kind) => {
    expect(classifyPriorRearm(oco({ status }), 5, 95, 110)).toBe(kind);
  });

  it.each([
    ['size', 6, 95, 110],
    ['stop', 5, 94, 110],
    ['target', 5, 95, 111],
  ])('reads a resting order with a different %s as stale', (_field, qty, stop, target) => {
    expect(classifyPriorRearm(oco(), qty, stop, target)).toBe('stale');
  });

  it('keeps a partially filled order live even when it no longer matches', () => {
    expect(classifyPriorRearm(oco({ status: 'partially_filled' }), 6, 94, 111)).toBe('live');
  });
});

describe('adoptableRearm', () => {
  const live = oco({ id: 'live' });
  const settled = oco({ id: 'settled', status: 'filled', filled_qty: '5' });

  it('prefers a live order over a settled one', () => {
    expect(adoptableRearm({ live, settled }, 99)).toBe(live);
  });

  it.each([
    [4, 'settled'],
    [5, 'settled'],
    [6, null],
  ])('adopts a settled order filled to 5 against an observed size of %s: %s', (size, id) => {
    expect(adoptableRearm({ live: null, settled }, size)?.id ?? null).toBe(id);
  });

  it('adopts nothing when the walk found neither', () => {
    expect(adoptableRearm({ live: null, settled: null }, 0)).toBeNull();
  });
});
