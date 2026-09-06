/**
 * `SaxoBrokerAdapter` against a fake `SaxoOpenApiClient` (#1032 item 1).
 *
 * Every wire shape below is a recorded SIM-gateway response from 2026-09-05
 * (doc 43) with the account/client keys stripped — no credential appears here.
 */
import { describe, expect, it, vi } from 'vitest';
import { LSE_ETP_POOL } from '../../../providers/universe-pool/index.js';
import { TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { InMemoryBrokerStateStore } from '../broker-state-store.js';
import type { NativeBracketRequest } from '../types.js';
import {
  SAXO_DUPLICATE_WINDOW_MS,
  SaxoBrokerAdapter,
  type SaxoInstrumentResolver,
  saxoInstrumentResolverFromPool,
} from './saxo-adapter.js';
import { SaxoBrokerProviderError } from './saxo-broker-errors.js';
import type {
  SaxoNetPosition,
  SaxoOpenApiClient,
  SaxoOpenOrder,
  SaxoOrderActivity,
  SaxoOrderPlacement,
} from './saxo-client.js';

function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

const RESOLVER: SaxoInstrumentResolver = {
  resolve: (lseTicker) =>
    lseTicker === '3USL' ? { uic: 16268043, asset_type: 'Etn', currency: 'GBP' } : undefined,
  lseTickerFor: (uic) => (uic === 16268043 ? '3USL' : undefined),
};

function makeBracket(overrides: Partial<NativeBracketRequest> = {}): NativeBracketRequest {
  return {
    client_order_id: 'key-3usl-0930',
    instrument: '3USL',
    asset_class: 'stocks',
    side: 'buy',
    size: 3,
    entry: 10,
    stop: 9,
    target: 12,
    time_in_force: 'day',
    ...overrides,
  };
}

function placement(overrides: Partial<SaxoOrderPlacement> = {}): SaxoOrderPlacement {
  return {
    ExternalReference: 'key-3usl-0930',
    OrderId: '5040047177',
    Orders: [
      { ExternalReference: 'key-3usl-0930:target', OrderId: '5040047179' },
      { ExternalReference: 'key-3usl-0930:stop', OrderId: '5040047178' },
    ],
    ...overrides,
  };
}

function workingMaster(overrides: Partial<SaxoOpenOrder> = {}): SaxoOpenOrder {
  return {
    OrderId: '5040047177',
    ExternalReference: 'key-3usl-0930',
    Status: 'Working',
    OpenOrderType: 'Limit',
    OrderRelation: 'IfDoneMaster',
    Price: 10,
    Amount: 3,
    BuySell: 'Buy',
    Uic: 16268043,
    AssetType: 'Etn',
    RelatedOpenOrders: [
      {
        OrderId: '5040047179',
        OpenOrderType: 'Limit',
        OrderPrice: 12,
        Amount: 3,
        Status: 'NotWorking',
      },
      {
        OrderId: '5040047178',
        OpenOrderType: 'StopIfTraded',
        OrderPrice: 9,
        Amount: 3,
        Status: 'NotWorking',
      },
    ],
    ...overrides,
  };
}

function activity(overrides: Partial<SaxoOrderActivity> = {}): SaxoOrderActivity {
  return {
    ActivityTime: '2026-09-05T08:30:00.000000Z',
    LogId: 'log-1',
    OrderId: '5040047177',
    ExternalReference: 'key-3usl-0930',
    Status: 'Placed',
    Amount: 3,
    BuySell: 'Buy',
    Uic: 16268043,
    AssetType: 'Etn',
    Price: 10,
    ...overrides,
  };
}

function makeClient(overrides: Partial<SaxoOpenApiClient> = {}): SaxoOpenApiClient {
  return {
    placeOrder: vi.fn().mockResolvedValue(placement()),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    listOpenOrders: vi.fn().mockResolvedValue([]),
    listOrderActivities: vi.fn().mockResolvedValue([]),
    listNetPositions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeAdapter(client: SaxoOpenApiClient, state = new InMemoryBrokerStateStore()) {
  const logger = recordingLogger();
  const adapter = new SaxoBrokerAdapter({
    client,
    instruments: RESOLVER,
    rateLimiter: permissiveLimiter(),
    state,
    clock: { now: () => new Date('2026-09-05T09:00:00Z') },
    logger,
  });
  return { adapter, logger, state };
}

describe('SaxoBrokerAdapter.submitBracket', () => {
  it('places an IfDone master with StopIfTraded + Limit legs, x-request-id = client_order_id', async () => {
    const client = makeClient();
    const { adapter, state } = makeAdapter(client);

    const ack = await adapter.submitBracket(makeBracket());

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    const [request, requestId] = vi.mocked(client.placeOrder).mock.calls[0] ?? [];
    expect(requestId).toBe('key-3usl-0930');
    expect(request).toMatchObject({
      Uic: 16268043,
      AssetType: 'Etn',
      BuySell: 'Buy',
      Amount: 3,
      OrderType: 'Limit',
      OrderPrice: 10,
      OrderDuration: { DurationType: 'DayOrder' },
      ManualOrder: false,
      ExternalReference: 'key-3usl-0930',
    });
    expect(request?.Orders).toEqual([
      expect.objectContaining({
        OrderType: 'StopIfTraded',
        OrderPrice: 9,
        BuySell: 'Sell',
        Amount: 3,
        OrderDuration: { DurationType: 'GoodTillCancel' },
        ExternalReference: 'key-3usl-0930:stop',
      }),
      expect.objectContaining({
        OrderType: 'Limit',
        OrderPrice: 12,
        BuySell: 'Sell',
        ExternalReference: 'key-3usl-0930:target',
      }),
    ]);
    expect(ack).toEqual({
      client_order_id: 'key-3usl-0930',
      broker_order_ids: ['5040047177', '5040047178', '5040047179'],
      order_state: 'submitted',
    });
    expect(state.loadBrackets('saxo')).toEqual([
      expect.objectContaining({
        venue: 'saxo',
        client_order_id: 'key-3usl-0930',
        phase: 'armed',
        entry_order_id: '5040047177',
        stop_order_id: '5040047178',
        target_order_id: '5040047179',
      }),
    ]);
  });

  it('adopts an open order already carrying the ExternalReference instead of placing again', async () => {
    const client = makeClient({ listOpenOrders: vi.fn().mockResolvedValue([workingMaster()]) });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitBracket(makeBracket());

    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(ack.broker_order_ids).toEqual(['5040047177', '5040047178', '5040047179']);
  });

  it('adopts through the venue 409 duplicate window (doc 43) when the first POST was accepted but its reply was lost', async () => {
    const listOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([workingMaster()]);
    const client = makeClient({
      listOpenOrders,
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitBracket(makeBracket());

    expect(ack.broker_order_ids[0]).toBe('5040047177');
    expect(listOpenOrders).toHaveBeenCalledTimes(2);
  });

  it('refuses a fractional size — every pool line reports MinimumLotSize 1 with odd lots disallowed', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    await expect(adapter.submitBracket(makeBracket({ size: 2.5 }))).rejects.toThrow(/whole units/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it('refuses an instrument the resolver cannot map to a Uic', async () => {
    const { adapter } = makeAdapter(makeClient());

    await expect(adapter.submitBracket(makeBracket({ instrument: '3SPY' }))).rejects.toThrow(
      /no Saxo Uic/,
    );
  });

  it('sanitises a venue rejection into a BrokerError carrying the ErrorCode', async () => {
    const client = makeClient({
      placeOrder: vi
        .fn()
        .mockRejectedValue(
          new SaxoBrokerProviderError(
            'Saxo API error: 400',
            400,
            'OrderTypeNotSupported',
            'Order type not supported',
          ),
        ),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.submitBracket(makeBracket())).rejects.toMatchObject({
      name: 'BrokerError',
      venue: 'saxo',
      operation: 'submitBracket',
      statusCode: 400,
      venueCode: 'OrderTypeNotSupported',
    });
  });
});

describe('SaxoBrokerAdapter.getOrder', () => {
  it('reads a working master from the open-orders list and re-journals its ids', async () => {
    const client = makeClient({ listOpenOrders: vi.fn().mockResolvedValue([workingMaster()]) });
    const { adapter, state } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toEqual({
      client_order_id: 'key-3usl-0930',
      broker_order_ids: ['5040047177', '5040047178', '5040047179'],
      order_state: 'submitted',
      filled_qty: 0,
    });
    expect(state.loadBrackets('saxo')[0]?.entry_order_id).toBe('5040047177');
  });

  it("reports 'filled' once only the protective legs are still working", async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        workingMaster({
          OrderId: '5040047178',
          ExternalReference: 'key-3usl-0930:stop',
          OpenOrderType: 'StopIfTraded',
          OrderRelation: 'Oco',
          RelatedOpenOrders: [],
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order?.order_state).toBe('filled');
    expect(order?.filled_qty).toBe(3);
  });

  it('falls back to the audit trail for an order no longer open', async () => {
    const client = makeClient({
      listOrderActivities: vi
        .fn()
        .mockResolvedValue([
          activity(),
          activity({ LogId: 'log-2', Status: 'Cancelled', ActivityTime: '2026-09-05T08:40:00Z' }),
        ]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order?.order_state).toBe('cancelled');
  });

  it("maps a Placed/Rejected audit row to 'rejected'", async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([activity({ SubStatus: 'Rejected' })]),
    });
    const { adapter } = makeAdapter(client);

    expect((await adapter.getOrder('key-3usl-0930', '3USL'))?.order_state).toBe('rejected');
  });

  it('returns null only when both the open list and the audit trail answered without the id', async () => {
    const { adapter } = makeAdapter(makeClient());

    expect(await adapter.getOrder('key-3usl-0930', '3USL')).toBeNull();
  });

  it('throws rather than answering null when a lookup fails', async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockRejectedValue(new Error('gateway down')),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.getOrder('key-3usl-0930', '3USL')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'getOrder',
    });
  });
});

describe('SaxoBrokerAdapter flatten', () => {
  it('submits a DayOrder market order keyed by the flatten id and adopts on retry', async () => {
    const listOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        workingMaster({
          OrderId: '777',
          ExternalReference: 'flat-1',
          OpenOrderType: 'Market',
          OrderRelation: 'StandAlone',
          BuySell: 'Sell',
          RelatedOpenOrders: [],
        }),
      ]);
    const client = makeClient({
      listOpenOrders,
      placeOrder: vi.fn().mockResolvedValue({ OrderId: '777', ExternalReference: 'flat-1' }),
    });
    const { adapter } = makeAdapter(client);

    const first = await adapter.submitFlatten('3USL', 'sell', 3, 'flat-1');
    const second = await adapter.submitFlatten('3USL', 'sell', 3, 'flat-1');

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.placeOrder).mock.calls[0]?.[0]).toMatchObject({
      OrderType: 'Market',
      BuySell: 'Sell',
      Amount: 3,
      OrderDuration: { DurationType: 'DayOrder' },
      ExternalReference: 'flat-1',
    });
    expect(first.broker_order_ids).toEqual(['777']);
    expect(second.broker_order_ids).toEqual(['777']);
  });

  it('resumeFlatten answers null only when the venue knows no such order', async () => {
    const { adapter } = makeAdapter(makeClient());

    expect(await adapter.resumeFlatten('flat-1', '3USL')).toBeNull();
  });
});

describe('SaxoBrokerAdapter.cancel', () => {
  it('cancels every open order the bracket owns and resolves on OrderNotFound', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([workingMaster()]),
      cancelOrder: vi
        .fn()
        .mockRejectedValue(
          new SaxoBrokerProviderError('Saxo API error: 404', 404, 'OrderNotFound', 'not found'),
        ),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).resolves.toBeUndefined();
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047177');
  });

  it('resolves without a venue call when nothing is open under the id', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('throws on a transport failure instead of pretending the cancel landed', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([workingMaster()]),
      cancelOrder: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'cancel',
    });
  });
});

describe('SaxoBrokerAdapter protective legs', () => {
  it('rearmProtectiveLegs throws: the pool lines report IsOcoOrderSupported false', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    await expect(
      adapter.rearmProtectiveLegs('key-3usl-0930', '3USL', 'buy', 3, 9, 12),
    ).rejects.toThrow(/IsOcoOrderSupported/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it('resizeProtectiveLegs is a no-op on the native IfDone bracket', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    await adapter.resizeProtectiveLegs('key-3usl-0930', 2);

    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('SaxoBrokerAdapter.fetchNewFills', () => {
  const since = new Date('2026-09-05T08:00:00Z');

  it('books a fill activity against the journalled bracket leg it references', async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([
        activity(),
        activity({
          LogId: 'log-fill',
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 10.02,
          ActivityTime: '2026-09-05T08:31:00Z',
        }),
        activity({
          LogId: 'log-stop',
          OrderId: '5040047178',
          ExternalReference: 'key-3usl-0930:stop',
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 8.98,
          ActivityTime: '2026-09-05T10:00:00Z',
        }),
        activity({
          LogId: 'log-other',
          ExternalReference: 'someone-else',
          Status: 'Filled',
          FillAmount: 1,
          AveragePrice: 1,
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(since);

    expect(client.listOrderActivities).toHaveBeenCalledWith(since);
    expect(fills).toEqual([
      {
        client_order_id: 'key-3usl-0930',
        broker_fill_id: 'log-fill',
        leg: 'entry',
        price: 10.02,
        qty: 3,
        fee: expect.closeTo(0.024048, 6),
        timestamp: new Date('2026-09-05T08:31:00Z'),
      },
      {
        client_order_id: 'key-3usl-0930',
        broker_fill_id: 'log-stop',
        leg: 'stop',
        price: 8.98,
        qty: 3,
        fee: expect.closeTo(0.021552, 6),
        timestamp: new Date('2026-09-05T10:00:00Z'),
      },
    ]);
  });

  it("books a flatten's fill as an 'exit' leg", async () => {
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue({ OrderId: '777', ExternalReference: 'flat-1' }),
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({
          LogId: 'log-flat',
          OrderId: '777',
          ExternalReference: 'flat-1',
          Status: 'Filled',
          BuySell: 'Sell',
          FillAmount: 3,
          AveragePrice: 10.5,
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);
    await adapter.submitFlatten('3USL', 'sell', 3, 'flat-1');

    const fills = await adapter.fetchNewFills(since);

    expect(fills).toEqual([
      expect.objectContaining({ client_order_id: 'flat-1', leg: 'exit', qty: 3 }),
    ]);
  });

  it('never dates a fill before `since`', async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({
          LogId: 'log-fill',
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 10,
          ActivityTime: '2026-09-05T07:00:00Z',
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);
    await adapter.submitBracket(makeBracket());

    const [fill] = await adapter.fetchNewFills(since);

    expect(fill?.timestamp).toEqual(since);
  });

  it('throws on a Filled activity that carries no fill amount or price rather than dropping it', async () => {
    const client = makeClient({
      listOrderActivities: vi
        .fn()
        .mockResolvedValue([activity({ LogId: 'log-fill', Status: 'Filled' })]),
    });
    const { adapter } = makeAdapter(client);
    await adapter.submitBracket(makeBracket());

    await expect(adapter.fetchNewFills(since)).rejects.toThrow(/log-fill/);
  });

  it('sweeps brackets journalled before a restart', async () => {
    const state = new InMemoryBrokerStateStore();
    state.saveBracket({
      venue: 'saxo',
      client_order_id: 'key-old',
      phase: 'armed',
      entry_order_id: '1',
      stop_order_id: '2',
      target_order_id: '3',
      request: null,
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({
          LogId: 'log-old',
          OrderId: '3',
          ExternalReference: 'key-old:target',
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 12,
        }),
      ]),
    });
    const { adapter } = makeAdapter(client, state);

    const fills = await adapter.fetchNewFills(since);

    expect(fills).toEqual([expect.objectContaining({ client_order_id: 'key-old', leg: 'target' })]);
  });
});

describe('SaxoBrokerAdapter.getOpenPositions', () => {
  it('maps net positions back to LSE tickers with a signed quantity', async () => {
    const positions: SaxoNetPosition[] = [
      {
        NetPositionId: '16268043__Etn',
        NetPositionBase: { Amount: -3, Uic: 16268043, AssetType: 'Etn' },
        NetPositionView: { AverageOpenPrice: 10.02 },
      },
      {
        NetPositionId: '999__Etf',
        NetPositionBase: { Amount: 2, Uic: 999, AssetType: 'Etf' },
        NetPositionView: {},
        DisplayAndFormat: { Symbol: 'XYZ:xlon' },
      },
    ];
    const client = makeClient({ listNetPositions: vi.fn().mockResolvedValue(positions) });
    const { adapter } = makeAdapter(client);

    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: '3USL', qty: -3, side: 'sell', avg_entry_price: 10.02 },
      { instrument: 'XYZ:xlon', qty: 2, side: 'buy', avg_entry_price: null },
    ]);
  });

  it('omits flat net positions', async () => {
    const client = makeClient({
      listNetPositions: vi.fn().mockResolvedValue([
        {
          NetPositionId: 'x',
          NetPositionBase: { Amount: 0, Uic: 16268043, AssetType: 'Etn' },
          NetPositionView: {},
        },
      ]),
    });
    const { adapter } = makeAdapter(client);

    expect(await adapter.getOpenPositions()).toEqual([]);
  });
});

describe('saxoInstrumentResolverFromPool', () => {
  it('maps every checked-in pool row with its own Saxo line, and only those', () => {
    const resolver = saxoInstrumentResolverFromPool(LSE_ETP_POOL);
    const own = LSE_ETP_POOL.filter((row) => row.provenance.saxo.line !== null);
    const siblingOnly = LSE_ETP_POOL.filter(
      (row) => row.provenance.saxo.line === null && row.provenance.saxo.sibling_line !== undefined,
    );

    expect(own.length).toBe(13);
    for (const row of own) {
      const line = row.provenance.saxo.line;
      if (line === null) throw new Error('unreachable');
      expect(resolver.resolve(row.lse_ticker)).toEqual({
        uic: line.uic,
        asset_type: line.asset_type,
        currency: line.currency,
      });
      expect(resolver.lseTickerFor(line.uic)).toBe(row.lse_ticker);
    }
    expect(resolver.resolve('3SPY')).toBeUndefined();
    expect(siblingOnly.length).toBeGreaterThan(0);
    for (const row of siblingOnly) {
      expect(resolver.resolve(row.lse_ticker)).toBeUndefined();
      const sibling = row.provenance.saxo.sibling_line;
      if (sibling !== undefined) expect(resolver.lseTickerFor(sibling.uic)).toBeUndefined();
    }
  });
});

describe('SAXO_DUPLICATE_WINDOW_MS', () => {
  it('is the 15 s rolling window measured on SIM (doc 43)', () => {
    expect(SAXO_DUPLICATE_WINDOW_MS).toBe(15_000);
  });
});
