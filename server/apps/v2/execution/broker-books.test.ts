import { describe, expect, it, vi } from 'vitest';
import type { AlpacaBrokerClient } from '../../../pipeline/execution/index.js';
import { AlpacaBrokerBooks, NO_BROKER_BOOKS } from './broker-books.js';

function client(overrides: {
  positions?: unknown[];
  orders?: unknown[];
  cash?: string;
}): AlpacaBrokerClient {
  return {
    getPositions: vi.fn(async () => overrides.positions ?? []),
    listOpenOrders: vi.fn(async () => overrides.orders ?? []),
    getAccount: vi.fn(async () => ({ cash: overrides.cash ?? '1000.50', equity: '1000.50' })),
  } as unknown as AlpacaBrokerClient;
}

describe('AlpacaBrokerBooks', () => {
  it('reads positions signed by side, open orders by client id with the side a stop protects, and cash in USD', async () => {
    const books = new AlpacaBrokerBooks(
      client({
        positions: [
          { symbol: 'AAPL', qty: '6.5', side: 'long' },
          { symbol: 'MSFT', qty: '3', side: 'short' },
          { symbol: 'NVDA', qty: '-2', side: 'short' },
        ],
        orders: [
          { client_order_id: 'entry-1', symbol: 'AAPL', side: 'buy', type: 'limit' },
          { client_order_id: 'aapl-stop', symbol: 'AAPL', side: 'sell', type: 'stop' },
          { client_order_id: 'msft-stop', symbol: 'MSFT', side: 'buy', type: 'stop_limit' },
          { client_order_id: 'nvda-tp', symbol: 'NVDA', side: 'buy', type: 'limit' },
          { client_order_id: 'untyped', symbol: 'NVDA', side: 'buy' },
        ],
      }),
    );
    expect(await books.read('alpaca')).toEqual({
      positions: [
        { instrument: 'AAPL', qty: 6.5 },
        { instrument: 'MSFT', qty: -3 },
        { instrument: 'NVDA', qty: -2 },
      ],
      openOrders: [
        { clientOrderId: 'entry-1', instrument: 'AAPL', protects: null },
        { clientOrderId: 'aapl-stop', instrument: 'AAPL', protects: 'long' },
        { clientOrderId: 'msft-stop', instrument: 'MSFT', protects: 'short' },
        { clientOrderId: 'nvda-tp', instrument: 'NVDA', protects: null },
        { clientOrderId: 'untyped', instrument: 'NVDA', protects: null },
      ],
      cashQuote: 1000.5,
    });
  });

  it.each([
    ['cash', { cash: 'NaN' }, 'Alpaca cash "NaN" is not a number'],
    ['blank cash', { cash: ' ' }, 'Alpaca cash " " is not a number'],
    [
      'quantity',
      { positions: [{ symbol: 'AAPL', qty: 'x', side: 'long' }] },
      'Alpaca AAPL qty "x" is not a number',
    ],
  ])('refuses a %s that is not a number', async (_what, overrides, message) => {
    await expect(new AlpacaBrokerBooks(client(overrides)).read('alpaca')).rejects.toThrow(message);
  });

  it('has no reader for a venue other than Alpaca and calls nothing', async () => {
    const fake = client({});
    await expect(new AlpacaBrokerBooks(fake).read('saxo')).rejects.toThrow(
      'no broker book reader for saxo',
    );
    expect(fake.getAccount).not.toHaveBeenCalled();
  });
});

describe('NO_BROKER_BOOKS', () => {
  it('rejects every read', async () => {
    await expect(NO_BROKER_BOOKS.read('alpaca')).rejects.toThrow(
      'no broker book reader for alpaca: every route is simulated',
    );
  });
});
