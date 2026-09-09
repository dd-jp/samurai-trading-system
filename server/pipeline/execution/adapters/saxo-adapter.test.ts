/**
 * `SaxoBrokerAdapter` against a fake `SaxoOpenApiClient` (#1032 item 1).
 *
 * Every wire shape below is a recorded SIM-gateway response from 2026-09-05
 * (doc 43) with the account/client keys stripped — no credential appears here.
 */
import type { MarketDataService } from '../../../providers/market-data-service/index.js';
import { LSE_ETP_POOL } from '../../../providers/universe-pool/index.js';
import type { OpenPosition } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import type { CostModel } from '../../../tools/backtest/index.js';
import { InMemoryBrokerStateStore } from '../broker-state-store.js';
import type {
  DormantLegsUnresolvedAlert,
  DormantLegsUnresolvedAlertChannel,
} from '../dormant-legs-unresolved-alert.js';
import { ExecutionImpl } from '../execute.js';
import { FilledZeroSizeThrottle } from '../filled-zero-size-throttle.js';
import type {
  LegResizeUnverifiedAlert,
  LegResizeUnverifiedAlertChannel,
} from '../leg-resize-unverified-alert.js';
import { openTestExecutionStore, type TestExecutionStore } from '../sqlite-store-harness.js';
import type { ExecutionInput, NativeBracketRequest } from '../types.js';
import {
  DORMANT_DEFER_ALERT_AFTER,
  DORMANT_DEFER_ALERT_REPEAT_EVERY,
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

const RESOLVER: SaxoInstrumentResolver = {
  resolve: (lseTicker) =>
    lseTicker === '3USL' ? { uic: 3347273, asset_type: 'Etn', currency: 'USD' } : undefined,
  lseTickerFor: (uic) => (uic === 3347273 ? '3USL' : undefined),
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
    Uic: 3347273,
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

/**
 * A related order read as never activated by a master's fill — `Status`
 * `NotWorking` is UNVERIFIED as that meaning (#1215 round 1, see
 * `SaxoOpenOrderStatus`). `OrderRelation` is left unset rather than
 * asserting a value: `Oco` is documented for an ACTIVATED pair only
 * (saxo-client.ts), which this fixture is not.
 */
function dormantLeg(overrides: Partial<SaxoOpenOrder> = {}): SaxoOpenOrder {
  return {
    OrderId: '5040047178',
    ExternalReference: 'key-3usl-0930:stop',
    Status: 'NotWorking',
    OpenOrderType: 'StopIfTraded',
    Price: 9,
    Amount: 3,
    BuySell: 'Sell',
    Uic: 3347273,
    AssetType: 'Etn',
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
    Uic: 3347273,
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

function makeLegResizeAlerts(): LegResizeUnverifiedAlertChannel & {
  alerts: LegResizeUnverifiedAlert[];
} {
  const alerts: LegResizeUnverifiedAlert[] = [];
  return {
    alerts,
    async postLegResizeUnverifiedAlert(alert) {
      alerts.push(alert);
    },
  };
}

function makeDormantLegsAlerts(): DormantLegsUnresolvedAlertChannel & {
  alerts: DormantLegsUnresolvedAlert[];
} {
  const alerts: DormantLegsUnresolvedAlert[] = [];
  return {
    alerts,
    async postDormantLegsUnresolvedAlert(alert) {
      alerts.push(alert);
    },
  };
}

function makeAdapter(client: SaxoOpenApiClient, state = new InMemoryBrokerStateStore()) {
  const logger = recordingLogger();
  const legResizeAlerts = makeLegResizeAlerts();
  const dormantLegsAlerts = makeDormantLegsAlerts();
  const adapter = new SaxoBrokerAdapter({
    client,
    instruments: RESOLVER,
    state,
    clock: { now: () => new Date('2026-09-05T09:00:00Z') },
    legResizeAlerts,
    dormantLegsAlerts,
    logger,
  });
  return { adapter, logger, state, legResizeAlerts, dormantLegsAlerts };
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
      Uic: 3347273,
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

  // The empty `listOrderActivities` default is realistic on THIS path,
  // unlike the 30-day `getOrder` lookback (#1215 round 2, finding 6): this
  // is `placeIdempotently`'s own `PLACEMENT_LOOKBACK_MS` window (60 s), and
  // a genuinely fresh placement attempt has no audit row for this reference
  // yet — the deliberate placement-vs-reconcile asymmetry `PLACEMENT_
  // LOOKBACK_MS`'s own doc explains.
  it('places fresh rather than adopting a phantom fill when only dormant legs rest under the reference (#1215)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        dormantLeg(),
        dormantLeg({
          OrderId: '5040047179',
          ExternalReference: 'key-3usl-0930:target',
          OpenOrderType: 'Limit',
          Price: 12,
          BuySell: 'Sell',
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitBracket(makeBracket());

    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(ack.order_state).toBe('submitted');
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

  it('does not adopt or cancel dormant legs found only after a duplicate-request refusal (#1215 round 1)', async () => {
    const listOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        dormantLeg(),
        dormantLeg({
          OrderId: '5040047179',
          ExternalReference: 'key-3usl-0930:target',
          OpenOrderType: 'Limit',
          Price: 12,
          BuySell: 'Sell',
        }),
      ]);
    const client = makeClient({
      listOpenOrders,
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.submitBracket(makeBracket())).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'submitBracket',
    });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('looks back only a few duplicate windows on the audit trail before placing', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    await adapter.submitBracket(makeBracket());

    // clock is 09:00:00Z; 4 x 15 s window = 60 s.
    expect(client.listOrderActivities).toHaveBeenCalledTimes(1);
    expect(client.listOrderActivities).toHaveBeenCalledWith(new Date('2026-09-05T08:59:00Z'));
  });

  it('acks an adopted order in its own state, not as submitted', async () => {
    const client = makeClient({
      listOrderActivities: vi
        .fn()
        .mockResolvedValue([activity({ Status: 'Filled', FillAmount: 3, AveragePrice: 10 })]),
    });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitBracket(makeBracket());

    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(ack.order_state).toBe('filled');
  });

  it.each([
    ['rejected', activity({ SubStatus: 'Rejected' })],
    ['cancelled', activity({ Status: 'Cancelled' })],
    ['expired', activity({ Status: 'Expired' })],
  ])('refuses to adopt or re-place over a %s prior order', async (_state, prior) => {
    const client = makeClient({ listOrderActivities: vi.fn().mockResolvedValue([prior]) });
    const { adapter, state: journal } = makeAdapter(client);

    await expect(adapter.submitBracket(makeBracket())).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'submitBracket',
      venueCode: 'DeadOrderUnderReference',
      venueMessage: expect.stringContaining(`state '${_state}'`),
    });
    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(journal.loadBrackets('saxo')).toEqual([]);
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

  it('cancels dormant legs and tolerates one the venue already reaped, when the audit trail carries no row at all — defensive branch, not the shape doc 43 measures for a placed master (#1215 round 2)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        dormantLeg(),
        dormantLeg({
          OrderId: '5040047179',
          ExternalReference: 'key-3usl-0930:target',
          OpenOrderType: 'Limit',
          Price: 12,
          BuySell: 'Sell',
        }),
      ]),
      cancelOrder: vi
        .fn()
        .mockRejectedValueOnce(
          new SaxoBrokerProviderError('Saxo API error: 404', 404, 'OrderNotFound', 'not found'),
        )
        .mockResolvedValueOnce(undefined),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toBeNull();
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
    expect(client.cancelOrder).toHaveBeenCalledTimes(2);
  });

  it('attempts every dormant leg even when an earlier one fails, rather than stopping cancellation short (#1215 round 2)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        dormantLeg(),
        dormantLeg({
          OrderId: '5040047179',
          ExternalReference: 'key-3usl-0930:target',
          OpenOrderType: 'Limit',
          Price: 12,
          BuySell: 'Sell',
        }),
      ]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Expired' })]),
      cancelOrder: vi
        .fn()
        .mockRejectedValueOnce(
          new SaxoBrokerProviderError('Saxo API error: 500', 500, 'InternalServerError', 'boom'),
        )
        .mockResolvedValueOnce(undefined),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.getOrder('key-3usl-0930', '3USL')).rejects.toThrow();

    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
    expect(client.cancelOrder).toHaveBeenCalledTimes(2);
  });

  it("adopts a fill the master's own audit row confirms, using the dormant legs' real ids (#1215 round 1)", async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        dormantLeg(),
        dormantLeg({
          OrderId: '5040047179',
          ExternalReference: 'key-3usl-0930:target',
          OpenOrderType: 'Limit',
          Price: 12,
          BuySell: 'Sell',
        }),
      ]),
      listOrderActivities: vi
        .fn()
        .mockResolvedValue([activity({ Status: 'Filled', FillAmount: 3, AveragePrice: 10 })]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({
      client_order_id: 'key-3usl-0930',
      broker_order_ids: ['5040047178', '5040047179'],
      order_state: 'filled',
      filled_qty: 3,
    });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('cancels dormant legs and reports the terminal state the audit trail confirms, not null (#1215 round 1)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Expired' })]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order?.order_state).toBe('expired');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
  });

  it('does not cancel dormant legs while the audit trail has not settled the master yet (#1215 round 1)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order?.order_state).toBe('submitted');
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('does not alert before DORMANT_DEFER_ALERT_AFTER consecutive deferred polls (#1215 round 2)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    for (let i = 0; i < DORMANT_DEFER_ALERT_AFTER - 1; i++) {
      const order = await adapter.getOrder('key-3usl-0930', '3USL');
      expect(order?.order_state).toBe('submitted');
    }

    expect(dormantLegsAlerts.alerts).toHaveLength(0);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('alerts once the audit trail stays unsettled for DORMANT_DEFER_ALERT_AFTER consecutive polls, without cancelling (#1215 round 2)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    for (let i = 0; i < DORMANT_DEFER_ALERT_AFTER; i++) {
      await adapter.getOrder('key-3usl-0930', '3USL');
    }

    expect(dormantLegsAlerts.alerts).toHaveLength(1);
    expect(dormantLegsAlerts.alerts[0]).toMatchObject({
      client_order_id: 'key-3usl-0930',
      instrument: '3USL',
    });
    expect(dormantLegsAlerts.alerts[0]?.stuck_ms).toBeGreaterThanOrEqual(0);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('does not re-alert every poll while still stuck, before the repeat interval elapses (#1215 round 2)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    const pollsBeforeSecondAlert = DORMANT_DEFER_ALERT_AFTER + DORMANT_DEFER_ALERT_REPEAT_EVERY;
    for (let i = 0; i < pollsBeforeSecondAlert - 1; i++) {
      await adapter.getOrder('key-3usl-0930', '3USL');
    }

    expect(dormantLegsAlerts.alerts).toHaveLength(1);
  });

  it('repeats the alert once DORMANT_DEFER_ALERT_REPEAT_EVERY further polls elapse while still stuck (#1215 round 2, ruling c)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    const pollsForSecondAlert = DORMANT_DEFER_ALERT_AFTER + DORMANT_DEFER_ALERT_REPEAT_EVERY;
    for (let i = 0; i < pollsForSecondAlert; i++) {
      await adapter.getOrder('key-3usl-0930', '3USL');
    }

    expect(dormantLegsAlerts.alerts).toHaveLength(2);
  });

  it('clears the deferred count once the audit trail settles, so a later dormant episode starts its own bound fresh (#1215 round 2)', async () => {
    const listOpenOrders = vi.fn().mockResolvedValue([dormantLeg()]);
    const listOrderActivities = vi.fn().mockResolvedValue([activity()]);
    const client = makeClient({ listOpenOrders, listOrderActivities });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    for (let i = 0; i < DORMANT_DEFER_ALERT_AFTER; i++) {
      await adapter.getOrder('key-3usl-0930', '3USL');
    }
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    // The master finally settles: audit trail reports Expired, legs are
    // cancelled, and the deferred count for this reference is cleared.
    listOrderActivities.mockResolvedValue([activity({ Status: 'Expired' })]);
    await adapter.getOrder('key-3usl-0930', '3USL');
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    // A brand-new dormant episode under the SAME reference (a fresh bracket
    // re-using the id, or the venue re-exposing dormant legs) must not
    // inherit the earlier episode's count — it should take
    // DORMANT_DEFER_ALERT_AFTER polls of its own before alerting again.
    listOpenOrders.mockResolvedValue([dormantLeg()]);
    listOrderActivities.mockResolvedValue([activity()]);
    for (let i = 0; i < DORMANT_DEFER_ALERT_AFTER - 1; i++) {
      await adapter.getOrder('key-3usl-0930', '3USL');
    }
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    await adapter.getOrder('key-3usl-0930', '3USL');
    expect(dormantLegsAlerts.alerts).toHaveLength(2);
  });

  it('reads a mixed Working/NotWorking leg pair as filled, same as before (#1215 round 1)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        dormantLeg({ Status: 'Working' }),
        dormantLeg({
          OrderId: '5040047179',
          ExternalReference: 'key-3usl-0930:target',
          OpenOrderType: 'Limit',
          Price: 12,
          BuySell: 'Sell',
          Status: 'NotWorking',
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
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

  it('reads the audit trail 30 days back — a restart may be long after the order', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    await adapter.getOrder('key-3usl-0930', '3USL');

    expect(client.listOrderActivities).toHaveBeenCalledWith(new Date('2026-08-06T09:00:00Z'));
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

  it('adopts an instantly-filled flatten off the audit trail when the 409 retry finds nothing open (#1217)', async () => {
    const listOrderActivities = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        activity({
          OrderId: '777',
          ExternalReference: 'flat-1',
          Status: 'Filled',
          BuySell: 'Sell',
          FillAmount: 3,
          AveragePrice: 10,
        }),
      ]);
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([]),
      listOrderActivities,
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitFlatten('3USL', 'sell', 3, 'flat-1');

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(listOrderActivities).toHaveBeenCalledTimes(2);
    expect(ack).toEqual({
      client_order_id: 'flat-1',
      broker_order_ids: ['777'],
      order_state: 'filled',
    });
  });

  it('reports a dead prior flatten as DeadOrderUnderReference rather than rethrowing the 409 (#1217)', async () => {
    const listOrderActivities = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        activity({
          OrderId: '777',
          ExternalReference: 'flat-1',
          Status: 'Cancelled',
          BuySell: 'Sell',
        }),
      ]);
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([]),
      listOrderActivities,
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.submitFlatten('3USL', 'sell', 3, 'flat-1')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'submitFlatten',
      venueCode: 'DeadOrderUnderReference',
    });
  });

  it('still reports the 409 as a failure when neither the open list nor the audit trail knows the flatten (#1217)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([]),
      listOrderActivities: vi.fn().mockResolvedValue([]),
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    const err = await adapter.submitFlatten('3USL', 'sell', 3, 'flat-1').catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'BrokerError', operation: 'submitFlatten', statusCode: 409 });
    expect((err as { venueCode?: string }).venueCode).toBeUndefined();
  });

  it('adopts the audit-trail row matching this reference on 409 retry, not another order under a different reference (#1217)', async () => {
    const listOrderActivities = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        activity({
          OrderId: '777',
          ExternalReference: 'flat-1',
          Status: 'Cancelled',
          ActivityTime: '2026-09-05T08:59:00.000000Z',
        }),
        activity({
          OrderId: '999',
          ExternalReference: 'unrelated-flat',
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 10,
          ActivityTime: '2026-09-05T08:59:30.000000Z',
        }),
      ]);
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([]),
      listOrderActivities,
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    // Without the ExternalReference filter, `unrelated-flat`'s later,
    // Filled row would win the "latest" pick and this would resolve as a
    // fill off an unrelated order instead of pinning the dead row under
    // 'flat-1'.
    await expect(adapter.submitFlatten('3USL', 'sell', 3, 'flat-1')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'submitFlatten',
      venueCode: 'DeadOrderUnderReference',
    });
  });

  it("computes the 409 retry's audit-trail read from PLACEMENT_LOOKBACK_MS (#1217)", async () => {
    // clock is 09:00:00Z; 4 x 15s duplicate window = 60s. Unlike the other
    // tests' fixed stubs, this one mimics a server-side `from` filter — it
    // only serves the Filled row on the exact expected window, and stays
    // empty (as on the pre-POST lookup() miss too) for any other `from`, so
    // a wrong window on the retry call surfaces as the 409 being rethrown.
    const expectedFrom = new Date('2026-09-05T08:59:00.000Z').getTime();
    const listOrderActivities = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve([]))
      .mockImplementation((from: Date) =>
        Promise.resolve(
          from.getTime() === expectedFrom
            ? [
                activity({
                  OrderId: '777',
                  ExternalReference: 'flat-1',
                  Status: 'Filled',
                  FillAmount: 3,
                  AveragePrice: 10,
                }),
              ]
            : [],
        ),
      );
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([]),
      listOrderActivities,
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitFlatten('3USL', 'sell', 3, 'flat-1');

    expect(ack).toEqual({
      client_order_id: 'flat-1',
      broker_order_ids: ['777'],
      order_state: 'filled',
    });
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

  it('resizeProtectiveLegs is a silent no-op when the whole bracket filled', async () => {
    const client = makeClient();
    const { adapter, legResizeAlerts } = makeAdapter(client);
    await adapter.submitBracket(makeBracket({ size: 3 }));

    await adapter.resizeProtectiveLegs('key-3usl-0930', 3);

    expect(legResizeAlerts.alerts).toEqual([]);
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('resizeProtectiveLegs alerts, and does not throw, on a partial fill', async () => {
    const client = makeClient();
    const { adapter, legResizeAlerts } = makeAdapter(client);
    await adapter.submitBracket(makeBracket({ size: 3 }));

    await adapter.resizeProtectiveLegs('key-3usl-0930', 2);

    expect(legResizeAlerts.alerts).toEqual([
      {
        client_order_id: 'key-3usl-0930',
        instrument: '3USL',
        requested_qty: 3,
        filled_qty: 2,
        observed_at: new Date('2026-09-05T09:00:00Z'),
      },
    ]);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('resizeProtectiveLegs alerts with an unknown size when the journal holds only order ids', async () => {
    const state = new InMemoryBrokerStateStore();
    state.recordBracketOrderIds('saxo', 'key-3usl-0930', {
      entry_order_id: '5040047177',
      stop_order_id: null,
      target_order_id: null,
    });
    const { adapter, legResizeAlerts } = makeAdapter(makeClient(), state);

    await adapter.resizeProtectiveLegs('key-3usl-0930', 3);

    expect(legResizeAlerts.alerts).toMatchObject([{ requested_qty: null, filled_qty: 3 }]);
  });
});

/**
 * The regression the round-2 review named: `ingestFills` calls
 * `resizeProtectiveLegs` on EVERY new entry fill, above `applyLotAdvance`, so
 * an adapter that throws there wedges the fill un-persisted forever. Driven
 * through the real `ExecutionImpl` against the Saxo adapter, not a stub.
 */
describe('ExecutionImpl.ingestFills through SaxoBrokerAdapter', () => {
  const NOW = new Date('2026-09-05T09:00:00Z');
  const OPENED_AT = new Date('2026-09-05T08:00:00Z');

  async function seedPosition(store: TestExecutionStore, size: number): Promise<OpenPosition> {
    const position: OpenPosition = {
      idempotency_key: 'key-3usl-0930',
      debate_id: 'debate-1',
      instrument: '3USL',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: size,
      filled_size: 0,
      avg_entry_price: 0,
      stop: 9,
      target: 12,
      order_state: 'submitted',
      broker_order_ids: ['5040047177', '5040047178', '5040047179'],
      opened_at: OPENED_AT,
      decision_timestamp: OPENED_AT,
      conviction: 0.7,
      converged: true,
    };
    await store.writeAheadPosition(position);
    return position;
  }

  function entryFill(fillAmount: number): SaxoOrderActivity {
    return activity({
      LogId: 'log-fill',
      Status: 'Filled',
      FillAmount: fillAmount,
      AveragePrice: 10.02,
      ActivityTime: '2026-09-05T08:31:00Z',
    });
  }

  async function ingest(fillAmount: number, size: number) {
    const { store } = openTestExecutionStore();
    await seedPosition(store, size);
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([entryFill(fillAmount)]),
    });
    const { adapter, legResizeAlerts } = makeAdapter(client);
    await adapter.submitBracket(makeBracket({ size }));

    const input: ExecutionInput = {
      trace_id: 'trace-1',
      clock: { now: () => NOW },
      broker: adapter,
      store,
      costModel: {} as CostModel,
      marketData: {} as MarketDataService,
      config: {
        simulated: {
          volatility_indicator: {
            indicator: 'atr',
            params: { period: 14 },
            timeframe: '1h',
            lookback: 15,
          },
          adv_window: { timeframe: '1d', lookback: 20 },
        },
      },
      mode: 'paper',
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      logger: recordingLogger(),
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    };
    await new ExecutionImpl(input).ingestFills();
    return { position: await store.getPosition('key-3usl-0930'), legResizeAlerts };
  }

  it('books a full entry fill: filled_size persists and no alert is posted', async () => {
    const { position, legResizeAlerts } = await ingest(3, 3);

    expect(position?.filled_size).toBe(3);
    expect(position?.order_state).toBe('filled');
    expect(legResizeAlerts.alerts).toEqual([]);
  });

  it('books a partial entry fill and posts the leg-resize alert instead of wedging the lot', async () => {
    const { position, legResizeAlerts } = await ingest(2, 3);

    expect(position?.filled_size).toBe(2);
    expect(position?.order_state).toBe('partially_filled');
    expect(legResizeAlerts.alerts).toMatchObject([{ requested_qty: 3, filled_qty: 2 }]);
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
        fee_currency: 'USD',
        timestamp: new Date('2026-09-05T08:31:00Z'),
      },
      {
        client_order_id: 'key-3usl-0930',
        broker_fill_id: 'log-stop',
        leg: 'stop',
        price: 8.98,
        qty: 3,
        fee: expect.closeTo(0.021552, 6),
        fee_currency: 'USD',
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

  it('leaves fee_currency unset for one fill whose Uic resolves to no pool line, and logs it', async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({
          LogId: 'log-fill',
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 10.02,
          Uic: 999999,
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
      ]),
    });
    const { adapter, logger } = makeAdapter(client);
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(since);

    expect(fills.map((fill) => [fill.broker_fill_id, fill.fee_currency])).toEqual([
      ['log-fill', undefined],
      ['log-stop', 'USD'],
    ]);
    expect(fills[0]).not.toHaveProperty('fee_currency');
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('fee_currency left unset'),
        payload: expect.objectContaining({ uic: 999999, log_id: 'log-fill' }),
      }),
    );
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
        NetPositionId: '3347273__Etn',
        NetPositionBase: { Amount: -3, Uic: 3347273, AssetType: 'Etn' },
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
          NetPositionBase: { Amount: 0, Uic: 3347273, AssetType: 'Etn' },
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
