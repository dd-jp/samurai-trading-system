import { describe, expect, it, vi } from 'vitest';
import type { AlpacaBrokerClient } from './alpaca/alpaca-client.js';
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

const HELD_AAPL = [{ symbol: 'AAPL', qty: '3', side: 'long' }];

function stopOrder(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    client_order_id: 's',
    symbol: 'AAPL',
    side: 'sell',
    type: 'stop',
    qty: '3',
    filled_qty: '0',
    stop_price: '9',
    ...overrides,
  };
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
          {
            client_order_id: 'aapl-stop',
            symbol: 'AAPL',
            side: 'sell',
            type: 'stop',
            qty: '10',
            filled_qty: '3.5',
            stop_price: '181.25',
          },
          {
            client_order_id: 'msft-stop',
            symbol: 'MSFT',
            side: 'buy',
            type: 'stop_limit',
            qty: '3',
            filled_qty: '0',
            stop_price: '402.1',
          },
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
        {
          clientOrderId: 'entry-1',
          instrument: 'AAPL',
          protects: null,
          qty: null,
          stopPrice: null,
        },
        {
          clientOrderId: 'aapl-stop',
          instrument: 'AAPL',
          protects: 'long',
          qty: 6.5,
          stopPrice: 181.25,
        },
        {
          clientOrderId: 'msft-stop',
          instrument: 'MSFT',
          protects: 'short',
          qty: 3,
          stopPrice: 402.1,
        },
        {
          clientOrderId: 'nvda-tp',
          instrument: 'NVDA',
          protects: null,
          qty: null,
          stopPrice: null,
        },
        {
          clientOrderId: 'untyped',
          instrument: 'NVDA',
          protects: null,
          qty: null,
          stopPrice: null,
        },
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
    [
      'stop quantity',
      { positions: HELD_AAPL, orders: [stopOrder({ qty: undefined })] },
      'Alpaca AAPL stop s qty "" is not a number',
    ],
    [
      'stop filled quantity',
      { positions: HELD_AAPL, orders: [stopOrder({ filled_qty: 'x' })] },
      'Alpaca AAPL stop s filled qty "x" is not a number',
    ],
    [
      'stop price',
      { positions: HELD_AAPL, orders: [stopOrder({ stop_price: null })] },
      'Alpaca AAPL stop s stop price "" is not a number',
    ],
  ])('refuses a %s that is not a number', async (_what, overrides, message) => {
    await expect(new AlpacaBrokerBooks(client(overrides)).read('alpaca')).rejects.toThrow(message);
  });

  it.each([
    ['qty', { qty: undefined }],
    ['stop price', { stop_price: null }],
  ])(
    'classes a stop with no %s on a name the account does not hold as an unknown order',
    async (_what, broken) => {
      const books = new AlpacaBrokerBooks(
        client({ positions: HELD_AAPL, orders: [stopOrder({ ...broken, symbol: 'TSLA' })] }),
      );
      expect((await books.read('alpaca')).openOrders).toEqual([
        { clientOrderId: 's', instrument: 'TSLA', protects: null, qty: null, stopPrice: null },
      ]);
    },
  );

  it('a flat position does not make a malformed stop on its name fail the read', async () => {
    const books = new AlpacaBrokerBooks(
      client({
        positions: [{ symbol: 'AAPL', qty: '0', side: 'long' }],
        orders: [stopOrder({ qty: undefined })],
      }),
    );
    expect((await books.read('alpaca')).openOrders).toMatchObject([{ protects: null }]);
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
