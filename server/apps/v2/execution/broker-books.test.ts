import { describe, expect, it, vi } from 'vitest';
import type { AlpacaBrokerClient } from './alpaca/alpaca-client.js';
import { ALPACA_ORDER_HISTORY_LIMIT } from './alpaca/alpaca-http-client.js';
import { AlpacaBrokerBooks, NO_BROKER_BOOKS } from './broker-books.js';

function client(overrides: {
  positions?: unknown[];
  orders?: unknown[];
  history?: unknown[];
  cash?: string;
}): AlpacaBrokerClient {
  return {
    getPositions: vi.fn(async () => overrides.positions ?? []),
    listOpenOrders: vi.fn(async () => overrides.orders ?? []),
    listOrderHistory: vi.fn(async () => overrides.history ?? []),
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

// The wire shape Alpaca paper returned for CRL on 2026-10-07 (#2086)
function crlLeg(type: 'limit' | 'stop', overrides: Record<string, unknown> = {}) {
  return {
    id: type === 'stop' ? 'leg-4df6' : 'leg-5639',
    client_order_id: type === 'stop' ? 'stop-4df6' : 'tp-5639',
    symbol: 'CRL',
    side: 'sell',
    type,
    order_class: 'bracket',
    qty: '1',
    filled_qty: '0',
    filled_avg_price: null,
    filled_at: null,
    status: type === 'stop' ? 'held' : 'new',
    stop_price: type === 'stop' ? '290.65' : null,
    limit_price: type === 'stop' ? null : '340.96',
    ...overrides,
  };
}

function crlBracket(
  overrides: Record<string, unknown> = {},
  legs = [crlLeg('limit'), crlLeg('stop')],
) {
  return {
    id: 'entry-051d',
    client_order_id: 'v2-debate-primary-2026-10-06-CRL',
    symbol: 'CRL',
    side: 'buy',
    type: 'limit',
    order_class: 'bracket',
    qty: '1',
    filled_qty: '1',
    filled_avg_price: '310.77',
    filled_at: '2026-10-06T14:20:02.108Z',
    status: 'filled',
    limit_price: '310.77',
    legs,
    ...overrides,
  };
}

const HELD_CRL = [{ symbol: 'CRL', qty: '1', side: 'long' }];
const CRL_TP_OPEN = { ...crlLeg('limit'), legs: [] };
const CRL_STOP = {
  clientOrderId: 'stop-4df6',
  instrument: 'CRL',
  protects: 'long',
  qty: 1,
  stopPrice: 290.65,
};

describe('AlpacaBrokerBooks held stop legs (#2086)', () => {
  it('reads the held stop leg of a filled bracket, which the open listing leaves out', async () => {
    const fake = client({ positions: HELD_CRL, orders: [CRL_TP_OPEN], history: [crlBracket()] });
    const book = await new AlpacaBrokerBooks(fake).read('alpaca');
    expect(book.openOrders).toEqual([
      { clientOrderId: 'tp-5639', instrument: 'CRL', protects: null, qty: null, stopPrice: null },
      CRL_STOP,
    ]);
    expect(fake.listOrderHistory).toHaveBeenCalledWith(['CRL']);
  });

  it('reads the held stop leg of a resting OCO re-arm', async () => {
    const oco = crlBracket(
      { side: 'sell', type: 'limit', order_class: 'oco', status: 'new', filled_qty: '0' },
      [crlLeg('stop')],
    );
    const book = await new AlpacaBrokerBooks(client({ positions: HELD_CRL, history: [oco] })).read(
      'alpaca',
    );
    expect(book.openOrders).toEqual([CRL_STOP]);
  });

  it.each([
    ['still working', { status: 'new', filled_qty: '0' }],
    ['part filled', { status: 'partially_filled', filled_qty: '0.5' }],
    ['cancelled', { status: 'canceled', filled_qty: '0' }],
  ])('a held stop leg of a bracket parent %s guards nothing', async (_what, parent) => {
    const book = await new AlpacaBrokerBooks(
      client({ positions: HELD_CRL, history: [crlBracket(parent)] }),
    ).read('alpaca');
    expect(book.openOrders).toEqual([]);
  });

  it('skips legs that are not held stops and a leg the open listing already returned', async () => {
    const history = [
      crlBracket({}, [crlLeg('limit', { status: 'held' }), crlLeg('stop', { status: 'canceled' })]),
      crlBracket({ id: 'entry-2' }, [crlLeg('stop', { id: 'listed' })]),
    ];
    const listed = { ...crlLeg('stop', { id: 'listed', status: 'new' }), legs: [] };
    const book = await new AlpacaBrokerBooks(
      client({ positions: HELD_CRL, orders: [listed], history }),
    ).read('alpaca');
    expect(book.openOrders).toEqual([CRL_STOP]);
  });

  it('asks for no order history when the account holds nothing', async () => {
    const fake = client({ positions: [{ symbol: 'CRL', qty: '0', side: 'long' }] });
    await new AlpacaBrokerBooks(fake).read('alpaca');
    expect(fake.listOrderHistory).not.toHaveBeenCalled();
  });

  it('fails the read when the history fills its page, since a held stop past it would go unread', async () => {
    const history = Array.from({ length: ALPACA_ORDER_HISTORY_LIMIT }, () => crlBracket({}, []));
    await expect(
      new AlpacaBrokerBooks(client({ positions: HELD_CRL, history })).read('alpaca'),
    ).rejects.toThrow(
      `Alpaca order history for CRL filled its ${ALPACA_ORDER_HISTORY_LIMIT}-order page`,
    );
  });

  it.each([
    [Math.floor(ALPACA_ORDER_HISTORY_LIMIT / 3), 'reads'],
    [Math.ceil(ALPACA_ORDER_HISTORY_LIMIT / 3), 'fails the read'],
  ])(
    'counts each bracket leg against the page: %i brackets of three orders %s',
    async (brackets, outcome) => {
      const history = Array.from({ length: brackets }, () => crlBracket());
      const read = new AlpacaBrokerBooks(client({ positions: HELD_CRL, history })).read('alpaca');
      if (outcome === 'reads') await expect(read).resolves.toBeDefined();
      else await expect(read).rejects.toThrow('filled its');
    },
  );

  it.each([
    [
      'no side',
      { side: undefined },
      'Alpaca CRL held stop leg-4df6 side undefined is not buy or sell',
    ],
    ['no qty', { qty: undefined }, 'Alpaca CRL stop stop-4df6 qty "" is not a number'],
  ])('refuses a held stop leg with %s on a held name', async (_what, broken, message) => {
    const history = [crlBracket({}, [crlLeg('stop', broken)])];
    await expect(
      new AlpacaBrokerBooks(client({ positions: HELD_CRL, history })).read('alpaca'),
    ).rejects.toThrow(message);
  });

  it('names a held stop leg with no client order id by its venue id', async () => {
    const history = [crlBracket({}, [crlLeg('stop', { client_order_id: undefined })])];
    const book = await new AlpacaBrokerBooks(client({ positions: HELD_CRL, history })).read(
      'alpaca',
    );
    expect(book.openOrders).toEqual([{ ...CRL_STOP, clientOrderId: 'leg-4df6' }]);
  });
});

describe('NO_BROKER_BOOKS', () => {
  it('rejects every read', async () => {
    await expect(NO_BROKER_BOOKS.read('alpaca')).rejects.toThrow(
      'no broker book reader for alpaca: every route is simulated',
    );
  });
});
