import { describe, expect, it, vi } from 'vitest';
import { CcxtBrokerAdapter, type CcxtBrokerClient, type CcxtOrder } from './ccxt-adapter.js';
import type { NativeBracketRequest } from './types.js';

const FILL_TS = new Date('2026-07-15T14:00:00Z').getTime();

const REQUEST: NativeBracketRequest = {
  client_order_id: 'idem-1',
  instrument: 'BTC/USD',
  asset_class: 'crypto',
  side: 'buy',
  size: 2,
  entry: 100,
  stop: 90,
  target: 120,
  time_in_force: 'GTC',
};

const ENTRY_ID = 'venue-idem-1';
const STOP_ID = 'venue-idem-1:stop';
const TARGET_ID = 'venue-idem-1:target';

function makeOrder(overrides: Partial<CcxtOrder> = {}): CcxtOrder {
  return {
    id: 'venue-idem-1',
    status: 'open',
    filled: 0,
    average: undefined,
    timestamp: FILL_TS,
    fee: undefined,
    ...overrides,
  };
}

/** A filled leg as the venue reports it once the trigger has traded through. */
function filledOrder(id: string, qty: number, price: number, fee = 0.26): CcxtOrder {
  return makeOrder({ id, status: 'closed', filled: qty, average: price, fee: { cost: fee } });
}

function makeClient() {
  const orders = new Map<string, CcxtOrder>();

  const createOrder = vi.fn<CcxtBrokerClient['createOrder']>(
    async (_symbol, _type, _side, _amount, _price, params) => {
      // Ids are derived from the client order id so the tests can address a
      // specific leg without depending on call ordering.
      const id = `venue-${String(params?.clientOrderId)}`;
      const order = makeOrder({ id });
      orders.set(id, order);
      return order;
    },
  );
  const cancelOrder = vi.fn<CcxtBrokerClient['cancelOrder']>(async () => undefined);
  const fetchOrder = vi.fn<CcxtBrokerClient['fetchOrder']>(async (id) => {
    const order = orders.get(id);
    if (order === undefined) throw new Error(`test fake has no order ${id}`);
    return order;
  });

  return {
    client: { createOrder, cancelOrder, fetchOrder },
    orders,
    createOrder,
    cancelOrder,
    fetchOrder,
  };
}

/** Params of the `createOrder` call that placed `clientOrderId`. */
function createCallFor(
  createOrder: ReturnType<typeof makeClient>['createOrder'],
  clientOrderId: string,
) {
  return createOrder.mock.calls.find((call) => call[5]?.clientOrderId === clientOrderId);
}

describe('CcxtBrokerAdapter', () => {
  describe('submitBracket', () => {
    it('places only the entry leg — the protective legs are armed on entry fill', async () => {
      const { client, createOrder } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);

      const ack = await adapter.submitBracket(REQUEST);

      expect(createOrder).toHaveBeenCalledTimes(1);
      expect(createOrder).toHaveBeenCalledWith('BTC/USD', 'limit', 'buy', 2, 100, {
        clientOrderId: 'idem-1',
        timeInForce: 'GTC',
      });
      expect(ack).toEqual({
        client_order_id: 'idem-1',
        broker_order_ids: [ENTRY_ID],
        order_state: 'submitted',
      });
    });

    it('treats a duplicate client order id as a venue-side no-op', async () => {
      const { client, createOrder } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);

      await adapter.submitBracket(REQUEST);
      const ack = await adapter.submitBracket(REQUEST);

      expect(createOrder).toHaveBeenCalledTimes(1);
      expect(ack.broker_order_ids).toEqual([ENTRY_ID]);
    });
  });

  describe('syncBrackets', () => {
    it('leaves a working entry alone', async () => {
      const { client, createOrder } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket(REQUEST);

      await adapter.syncBrackets();

      // Still just the entry: nothing to protect until something fills.
      expect(createOrder).toHaveBeenCalledTimes(1);
    });

    it('arms stop and target sized to the FILLED quantity, not the requested size', async () => {
      const { client, orders, createOrder } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket(REQUEST);
      orders.set(ENTRY_ID, filledOrder(ENTRY_ID, 1.5, 99.5));

      await adapter.syncBrackets();

      // Requested 2, filled 1.5 — protective legs must cover 1.5 or the lot is
      // left over-protected against phantom quantity.
      expect(createCallFor(createOrder, 'idem-1:stop')).toEqual([
        'BTC/USD',
        'limit',
        'sell',
        1.5,
        90,
        { clientOrderId: 'idem-1:stop', stopLossPrice: 90, timeInForce: 'GTC' },
      ]);
      expect(createCallFor(createOrder, 'idem-1:target')).toEqual([
        'BTC/USD',
        'limit',
        'sell',
        1.5,
        120,
        { clientOrderId: 'idem-1:target', takeProfitPrice: 120, timeInForce: 'GTC' },
      ]);
    });

    it('arms exit legs on the opposite side of a sell entry', async () => {
      const { client, orders, createOrder } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket({ ...REQUEST, side: 'sell', stop: 120, target: 90 });
      orders.set(ENTRY_ID, filledOrder(ENTRY_ID, 2, 100));

      await adapter.syncBrackets();

      expect(createCallFor(createOrder, 'idem-1:stop')?.[2]).toBe('buy');
      expect(createCallFor(createOrder, 'idem-1:target')?.[2]).toBe('buy');
    });

    it('does not re-arm an already-armed bracket', async () => {
      const { client, orders, createOrder } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket(REQUEST);
      orders.set(ENTRY_ID, filledOrder(ENTRY_ID, 2, 100));

      await adapter.syncBrackets();
      await adapter.syncBrackets();

      // Entry + stop + target, placed once each.
      expect(createOrder).toHaveBeenCalledTimes(3);
    });

    it('resolves a bracket whose entry died without filling', async () => {
      const { client, orders, createOrder, cancelOrder } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket(REQUEST);
      orders.set(ENTRY_ID, makeOrder({ id: ENTRY_ID, status: 'canceled', filled: 0 }));

      await adapter.syncBrackets();

      // No lot exists, so there is nothing to arm and no sibling to cancel.
      expect(createOrder).toHaveBeenCalledTimes(1);
      expect(cancelOrder).not.toHaveBeenCalled();
      expect(await adapter.fetchNewFills(new Date(0))).toEqual([]);
    });
  });

  describe('OCO emulation', () => {
    async function armedBracket() {
      const fake = makeClient();
      const adapter = new CcxtBrokerAdapter(fake.client);
      await adapter.submitBracket(REQUEST);
      fake.orders.set(ENTRY_ID, filledOrder(ENTRY_ID, 2, 100));
      await adapter.syncBrackets();
      return { ...fake, adapter };
    }

    it('cancels the target exactly once when the stop fills', async () => {
      const { adapter, orders, cancelOrder } = await armedBracket();
      orders.set(STOP_ID, filledOrder(STOP_ID, 2, 90));

      // Polls overlap by design — fetchNewFills is `>= since`, so the same
      // fill is legitimately re-observed. The sibling must still die once.
      await adapter.syncBrackets();
      await adapter.syncBrackets();
      await adapter.syncBrackets();

      expect(cancelOrder).toHaveBeenCalledTimes(1);
      expect(cancelOrder).toHaveBeenCalledWith(TARGET_ID, 'BTC/USD');
    });

    it('cancels the stop exactly once when the target fills', async () => {
      const { adapter, orders, cancelOrder } = await armedBracket();
      orders.set(TARGET_ID, filledOrder(TARGET_ID, 2, 120));

      await adapter.syncBrackets();
      await adapter.syncBrackets();

      expect(cancelOrder).toHaveBeenCalledTimes(1);
      expect(cancelOrder).toHaveBeenCalledWith(STOP_ID, 'BTC/USD');
    });

    it('cancels the sibling exactly once under concurrent polls', async () => {
      const { adapter, orders, cancelOrder } = await armedBracket();
      orders.set(STOP_ID, filledOrder(STOP_ID, 2, 90));

      await Promise.all([adapter.syncBrackets(), adapter.syncBrackets()]);

      expect(cancelOrder).toHaveBeenCalledTimes(1);
    });

    it('leaves both legs alive while neither has filled', async () => {
      const { adapter, cancelOrder } = await armedBracket();

      await adapter.syncBrackets();

      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('does not resolve the bracket on an exit fill it cannot price', async () => {
      const { adapter, orders } = await armedBracket();
      orders.set(STOP_ID, makeOrder({ id: STOP_ID, status: 'closed', filled: 2 }));

      await expect(adapter.syncBrackets()).rejects.toThrow(/no average fill price/);

      // Resolving on the throw would strand the target: the lot's stop is gone
      // and nothing would ever cancel its sibling. The bracket must stay armed
      // so a later poll can still take the OCO edge.
      orders.set(STOP_ID, filledOrder(STOP_ID, 2, 90));
      await adapter.syncBrackets();
      expect(await adapter.fetchNewFills(new Date(0))).toHaveLength(2);
    });
  });

  describe('fetchNewFills', () => {
    it('normalizes entry and exit fills into the shared NormalizedFill shape', async () => {
      const { client, orders } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket(REQUEST);
      orders.set(ENTRY_ID, filledOrder(ENTRY_ID, 2, 99.5, 0.26));
      await adapter.syncBrackets();
      orders.set(STOP_ID, filledOrder(STOP_ID, 2, 90, 0.23));
      await adapter.syncBrackets();

      const fills = await adapter.fetchNewFills(new Date(0));

      expect(fills).toEqual([
        {
          client_order_id: 'idem-1',
          broker_fill_id: ENTRY_ID,
          leg: 'entry',
          price: 99.5,
          qty: 2,
          fee: 0.26,
          timestamp: new Date(FILL_TS),
        },
        {
          client_order_id: 'idem-1',
          broker_fill_id: STOP_ID,
          leg: 'stop',
          price: 90,
          qty: 2,
          fee: 0.23,
          timestamp: new Date(FILL_TS),
        },
      ]);
      // A real venue fill carries no modeled cost breakdown — that is the
      // Simulated adapter's alone.
      expect(fills[0]).not.toHaveProperty('cost_breakdown');
    });

    it('never returns a fill dated before `since`', async () => {
      const { client, orders } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket(REQUEST);
      orders.set(ENTRY_ID, filledOrder(ENTRY_ID, 2, 99.5));
      await adapter.syncBrackets();

      expect(await adapter.fetchNewFills(new Date(FILL_TS + 1))).toEqual([]);
      expect(await adapter.fetchNewFills(new Date(FILL_TS))).toHaveLength(1);
    });

    it('refuses to fabricate a fill price the venue did not report', async () => {
      const { client, orders } = makeClient();
      const adapter = new CcxtBrokerAdapter(client);
      await adapter.submitBracket(REQUEST);
      orders.set(
        ENTRY_ID,
        makeOrder({ id: ENTRY_ID, status: 'closed', filled: 2, average: undefined }),
      );

      await expect(adapter.syncBrackets()).rejects.toThrow(/no average fill price/);
    });
  });
});
