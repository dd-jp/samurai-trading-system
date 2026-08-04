import { TokenBucket } from '../shared/index.js';
import { BrokerError } from './broker-error.js';
import { IbkrBrokerAdapter, type IbkrBrokerClient, type IbkrExecution } from './ibkr-adapter.js';
import type { NativeBracketRequest } from './types.js';

const FILL_TIME = '2026-07-15T14:00:00.000Z';

const REQUEST: NativeBracketRequest = {
  client_order_id: 'idem-1',
  instrument: 'AAPL',
  asset_class: 'stocks',
  side: 'buy',
  size: 10,
  entry: 100,
  stop: 90,
  target: 120,
  time_in_force: 'GTC',
};

const IDS = { parentOrderId: 'p1', stopOrderId: 's1', takeProfitOrderId: 't1' };

/**
 * These tests are about native-bracket placement and fill normalization, not
 * pacing — a permissive bucket keeps them off the wall clock however many
 * calls a case makes. Pacing is asserted in its own describe below and in
 * `shared/http/token-bucket.test.ts`.
 */
function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

function makeClient(executions: IbkrExecution[] = []) {
  const placeBracketOrder = vi.fn<IbkrBrokerClient['placeBracketOrder']>(async () => IDS);
  const fetchExecutions = vi.fn<IbkrBrokerClient['fetchExecutions']>(async () => executions);
  const fetchOrderStatus = vi.fn<IbkrBrokerClient['fetchOrderStatus']>(async (clientOrderId) => ({
    clientOrderId,
    parentOrderId: IDS.parentOrderId,
    stopOrderId: IDS.stopOrderId,
    takeProfitOrderId: IDS.takeProfitOrderId,
    status: 'Submitted',
    filledQuantity: 0,
  }));
  return {
    client: { placeBracketOrder, fetchExecutions, fetchOrderStatus },
    placeBracketOrder,
    fetchExecutions,
    fetchOrderStatus,
  };
}

function execution(overrides: Partial<IbkrExecution> = {}): IbkrExecution {
  return {
    execId: 'e1',
    orderId: 'p1',
    price: 99.5,
    shares: 10,
    commission: 1,
    time: FILL_TIME,
    ...overrides,
  };
}

describe('IbkrBrokerAdapter', () => {
  describe('submitBracket', () => {
    it('places entry, stop and target as ONE native bracket in an OCA group', async () => {
      const { client, placeBracketOrder } = makeClient();
      const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());

      const ack = await adapter.submitBracket(REQUEST);

      // The whole point of the native path: one call, and the venue owns the
      // one-cancels-other. No Execution-side arming or cancelling.
      expect(placeBracketOrder).toHaveBeenCalledTimes(1);
      expect(placeBracketOrder).toHaveBeenCalledWith({
        clientOrderId: 'idem-1',
        symbol: 'AAPL',
        action: 'BUY',
        totalQuantity: 10,
        limitPrice: 100,
        stopPrice: 90,
        takeProfitPrice: 120,
        tif: 'GTC',
        ocaGroup: 'idem-1',
      });
      expect(ack).toEqual({
        client_order_id: 'idem-1',
        broker_order_ids: ['p1', 's1', 't1'],
        order_state: 'submitted',
      });
    });

    it('maps a sell entry to the SELL action', async () => {
      const { client, placeBracketOrder } = makeClient();
      const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());

      await adapter.submitBracket({ ...REQUEST, side: 'sell' });

      expect(placeBracketOrder.mock.calls[0]?.[0].action).toBe('SELL');
    });

    it('treats a duplicate client order id as a venue-side no-op', async () => {
      const { client, placeBracketOrder } = makeClient();
      const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());

      await adapter.submitBracket(REQUEST);
      const ack = await adapter.submitBracket(REQUEST);

      expect(placeBracketOrder).toHaveBeenCalledTimes(1);
      expect(ack.broker_order_ids).toEqual(['p1', 's1', 't1']);
    });
  });

  describe('fetchNewFills', () => {
    it('normalizes each leg into the shared NormalizedFill shape', async () => {
      const { client } = makeClient([
        execution({ execId: 'e1', orderId: 'p1', price: 99.5, shares: 10, commission: 1 }),
        execution({ execId: 'e2', orderId: 's1', price: 90, shares: 10, commission: 0.9 }),
      ]);
      const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());
      await adapter.submitBracket(REQUEST);

      const fills = await adapter.fetchNewFills(new Date(0));

      expect(fills).toEqual([
        {
          client_order_id: 'idem-1',
          broker_fill_id: 'e1',
          leg: 'entry',
          price: 99.5,
          qty: 10,
          fee: 1,
          timestamp: new Date(FILL_TIME),
        },
        {
          client_order_id: 'idem-1',
          broker_fill_id: 'e2',
          leg: 'stop',
          price: 90,
          qty: 10,
          fee: 0.9,
          timestamp: new Date(FILL_TIME),
        },
      ]);
      // A real venue fill carries no modeled cost breakdown.
      expect(fills[0]).not.toHaveProperty('cost_breakdown');
    });

    it('maps the take-profit order to the target leg', async () => {
      const { client } = makeClient([execution({ orderId: 't1' })]);
      const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());
      await adapter.submitBracket(REQUEST);

      expect((await adapter.fetchNewFills(new Date(0)))[0]?.leg).toBe('target');
    });

    it('ignores executions from orders this adapter did not place', async () => {
      // A manual TWS trade or another session's order shares the account's
      // execution feed; it belongs to no bracket here and has no leg to claim.
      const { client } = makeClient([execution({ orderId: 'someone-elses' })]);
      const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());
      await adapter.submitBracket(REQUEST);

      expect(await adapter.fetchNewFills(new Date(0))).toEqual([]);
    });

    it('never returns a fill dated before `since`', async () => {
      const { client, fetchExecutions } = makeClient([execution()]);
      const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());
      await adapter.submitBracket(REQUEST);

      const since = new Date(Date.parse(FILL_TIME) + 1);
      expect(await adapter.fetchNewFills(since)).toEqual([]);
      expect(fetchExecutions).toHaveBeenCalledWith(since);
    });
  });
});

describe('IbkrBrokerAdapter outbound call discipline', () => {
  it('paces every outbound call through the rate limiter', async () => {
    const { client } = makeClient();
    const limiter = permissiveLimiter();
    const acquire = vi.spyOn(limiter, 'acquire');
    const adapter = new IbkrBrokerAdapter(client, limiter);

    await adapter.submitBracket(REQUEST);
    await adapter.fetchNewFills(new Date(0));

    // placeBracketOrder + fetchExecutions — an unpaced call would show up here
    // as a client call the limiter never saw.
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('never lets a venue error carry its connection context out of the adapter', async () => {
    const secret = 'tws-session-token-7719';
    const { client } = makeClient();
    client.placeBracketOrder = vi.fn(async () => {
      throw Object.assign(new Error(`TWS rejected: auth=${secret}`), { code: 1100 });
    }) as typeof client.placeBracketOrder;
    const adapter = new IbkrBrokerAdapter(client, permissiveLimiter());

    const error = await adapter.submitBracket(REQUEST).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).message).toBe(
      'ibkr submitBracket failed (status unknown, code 1100)',
    );
    expect((error as BrokerError).message).not.toContain(secret);
    expect('cause' in (error as BrokerError)).toBe(false);
  });
});
