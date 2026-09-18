import type {
  MarketDataService,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import { LSE_ETP_POOL } from '../../../providers/universe-pool/index.js';
import type { AssetClass, OpenPosition } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { type CostModel, SAXO_COMMISSION_RATE } from '../../../tools/backtest/index.js';
import { BrokerError } from '../broker-error.js';
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
import {
  isProtectiveRearmUnsupported,
  type ProtectiveRearmUnsupportedError,
} from '../protective-rearm-unsupported.js';
import { openTestExecutionStore, type TestExecutionStore } from '../sqlite-store-harness.js';
import type { ExecutionInput, NativeBracketRequest } from '../types.js';
import { UnrecordedVenuePositionThrottle } from '../unrecorded-venue-position-throttle.js';
import type {
  UnresolvedPriceUnitAlert,
  UnresolvedPriceUnitAlertChannel,
} from '../unresolved-price-unit-alert.js';
import {
  DORMANT_DEFER_ALERT_AFTER,
  DORMANT_DEFER_ALERT_REPEAT_EVERY_MS,
  PRICE_UNIT_ALERT_REPEAT_EVERY,
  SaxoBrokerAdapter,
  type SaxoInstrumentResolver,
  saxoExternalReference,
  saxoInstrumentResolverFromVenue,
} from './saxo-adapter.js';
import { SaxoBrokerProviderError } from './saxo-broker-errors.js';
import type {
  SaxoInstrumentDetails,
  SaxoNetPosition,
  SaxoOpenApiClient,
  SaxoOpenOrder,
  SaxoOrderActivity,
  SaxoOrderPlacement,
} from './saxo-client.js';
import { saxoCashPerShare } from './saxo-price-unit.js';

const FILL_POLL_INTERVAL_MS = 15_000;

const OPEN_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

const RESOLVER: SaxoInstrumentResolver = {
  resolve: (lseTicker) =>
    lseTicker === '3USL'
      ? {
          uic: 3347273,
          asset_type: 'Etn',
          currency: 'USD',
          price_currency: 'USD',
          price_to_contract_factor: 1,
        }
      : undefined,
  lseTickerFor: (uic) => (uic === 3347273 ? '3USL' : undefined),
};

const GBX_REF = {
  uic: 29391797,
  asset_type: 'Etn',
  currency: 'GBP',
  price_currency: 'GBX',
  price_to_contract_factor: 0.01,
} as const;

const GBX_RESOLVER: SaxoInstrumentResolver = {
  resolve: (lseTicker) => (lseTicker === 'LQQ3' ? GBX_REF : undefined),
  lseTickerFor: (uic) => (uic === GBX_REF.uic ? 'LQQ3' : undefined),
};

function detailsClient(
  perUic: ReadonlyMap<number, Partial<SaxoInstrumentDetails>> = new Map(),
): Pick<SaxoOpenApiClient, 'getInstrumentDetails'> {
  return {
    getInstrumentDetails: vi.fn(async (uic: number, assetType: string) => ({
      Uic: uic,
      AssetType: assetType,
      CurrencyCode: 'USD',
      PriceCurrency: 'USD',
      PriceToContractFactor: 1,
      ...perUic.get(uic),
    })),
  };
}

function wireRef(clientOrderId: string): string {
  return saxoExternalReference(clientOrderId);
}

function wireLegRef(clientOrderId: string, leg: 'stop' | 'target'): string {
  return `${wireRef(clientOrderId)}:${leg}`;
}

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
    ExternalReference: wireRef('key-3usl-0930'),
    OrderId: '5040047177',
    Orders: [
      { ExternalReference: wireLegRef('key-3usl-0930', 'target'), OrderId: '5040047179' },
      { ExternalReference: wireLegRef('key-3usl-0930', 'stop'), OrderId: '5040047178' },
    ],
    ...overrides,
  };
}

function workingMaster(overrides: Partial<SaxoOpenOrder> = {}): SaxoOpenOrder {
  return {
    OrderId: '5040047177',
    ExternalReference: wireRef('key-3usl-0930'),
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

function dormantLeg(overrides: Partial<SaxoOpenOrder> = {}): SaxoOpenOrder {
  return {
    OrderId: '5040047178',
    ExternalReference: wireLegRef('key-3usl-0930', 'stop'),
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

function targetLeg(overrides: Partial<SaxoOpenOrder> = {}): SaxoOpenOrder {
  return dormantLeg({
    OrderId: '5040047179',
    ExternalReference: wireLegRef('key-3usl-0930', 'target'),
    OpenOrderType: 'Limit',
    Price: 12,
    ...overrides,
  });
}

function activity(overrides: Partial<SaxoOrderActivity> = {}): SaxoOrderActivity {
  return {
    ActivityTime: '2026-09-05T08:30:00.000000Z',
    LogId: 'log-1',
    OrderId: '5040047177',
    ExternalReference: wireRef('key-3usl-0930'),
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
    getInstrumentDetails: vi.fn().mockRejectedValue(new Error('unexpected getInstrumentDetails')),
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

function makePriceUnitAlerts(): UnresolvedPriceUnitAlertChannel & {
  alerts: UnresolvedPriceUnitAlert[];
} {
  const alerts: UnresolvedPriceUnitAlert[] = [];
  return {
    alerts,
    async postUnresolvedPriceUnitAlert(alert) {
      alerts.push(alert);
    },
  };
}

function makeAdapter(
  client: SaxoOpenApiClient,
  state = new InMemoryBrokerStateStore(),
  instruments: SaxoInstrumentResolver = RESOLVER,
  clock: { now(): Date } = { now: () => new Date('2026-09-05T09:00:00Z') },
) {
  const logger = recordingLogger();
  const legResizeAlerts = makeLegResizeAlerts();
  const dormantLegsAlerts = makeDormantLegsAlerts();
  const priceUnitAlerts = makePriceUnitAlerts();
  const adapter = new SaxoBrokerAdapter({
    client,
    instruments,
    state,
    clock,
    legResizeAlerts,
    dormantLegsAlerts,
    priceUnitAlerts,
    logger,
  });
  return { adapter, logger, state, legResizeAlerts, dormantLegsAlerts, priceUnitAlerts };
}

function controllableClock(startAt = new Date('2026-09-05T09:00:00Z')) {
  let currentMs = startAt.getTime();
  return {
    now: () => new Date(currentMs),
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

async function primeDormantDeferAlert(
  adapter: SaxoBrokerAdapter,
  clock: ReturnType<typeof controllableClock>,
  clientOrderId = 'key-3usl-0930',
  instrument = '3USL',
): Promise<void> {
  for (let i = 0; i < DORMANT_DEFER_ALERT_AFTER; i++) {
    if (i > 0) clock.advance(FILL_POLL_INTERVAL_MS);
    await adapter.getOrder(clientOrderId, instrument);
  }
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
      ExternalReference: wireRef('key-3usl-0930'),
    });
    expect(request?.Orders).toEqual([
      expect.objectContaining({
        OrderType: 'StopIfTraded',
        OrderPrice: 9,
        BuySell: 'Sell',
        Amount: 3,
        OrderDuration: { DurationType: 'GoodTillCancel' },
        ExternalReference: wireLegRef('key-3usl-0930', 'stop'),
      }),
      expect.objectContaining({
        OrderType: 'Limit',
        OrderPrice: 12,
        BuySell: 'Sell',
        ExternalReference: wireLegRef('key-3usl-0930', 'target'),
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

  it('places fresh rather than adopting a phantom fill when only dormant legs rest under the reference (#1215)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        dormantLeg(),
        dormantLeg({
          OrderId: '5040047179',
          ExternalReference: wireLegRef('key-3usl-0930', 'target'),
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
          ExternalReference: wireLegRef('key-3usl-0930', 'target'),
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

  it('defers dormant legs found after a duplicate-request refusal even when the audit trail already has a Filled row for them (#1438)', async () => {
    const listOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dormantLeg(), targetLeg()]);
    const listOrderActivities = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([activity({ Status: 'Filled', FillAmount: 3, AveragePrice: 10 })]);
    const client = makeClient({
      listOpenOrders,
      listOrderActivities,
      placeOrder: vi
        .fn()
        .mockRejectedValue(new SaxoBrokerProviderError('Saxo API error: 409', 409, undefined)),
    });
    const { adapter } = makeAdapter(client);

    const err = await adapter.submitBracket(makeBracket()).catch((e: unknown) => e);

    expect(err).toMatchObject({ name: 'BrokerError', operation: 'submitBracket', statusCode: 409 });
    expect((err as { venueCode?: string }).venueCode).toBeUndefined();
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(listOrderActivities).toHaveBeenCalledTimes(1);
  });

  it('looks back only a few duplicate windows on the audit trail before placing', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    await adapter.submitBracket(makeBracket());

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
          ExternalReference: wireLegRef('key-3usl-0930', 'stop'),
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
          ExternalReference: wireLegRef('key-3usl-0930', 'target'),
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
          ExternalReference: wireLegRef('key-3usl-0930', 'target'),
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
          ExternalReference: wireLegRef('key-3usl-0930', 'target'),
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

  it('does not re-alert on the very next poll while still stuck, even though the grace threshold is already met (#1426)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const clock = controllableClock();
    const { adapter, dormantLegsAlerts } = makeAdapter(
      client,
      new InMemoryBrokerStateStore(),
      RESOLVER,
      clock,
    );

    await primeDormantDeferAlert(adapter, clock);
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    clock.advance(FILL_POLL_INTERVAL_MS);
    await adapter.getOrder('key-3usl-0930', '3USL');
    expect(dormantLegsAlerts.alerts).toHaveLength(1);
  });

  it('does not re-alert just short of DORMANT_DEFER_ALERT_REPEAT_EVERY_MS wall-clock time since the last alert (#1426)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const clock = controllableClock();
    const { adapter, dormantLegsAlerts } = makeAdapter(
      client,
      new InMemoryBrokerStateStore(),
      RESOLVER,
      clock,
    );

    await primeDormantDeferAlert(adapter, clock);
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    clock.advance(DORMANT_DEFER_ALERT_REPEAT_EVERY_MS - 1);
    await adapter.getOrder('key-3usl-0930', '3USL');
    expect(dormantLegsAlerts.alerts).toHaveLength(1);
  });

  it('repeats the alert once DORMANT_DEFER_ALERT_REPEAT_EVERY_MS wall-clock time elapses while still stuck (#1215 round 2 ruling c, re-derived #1426)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const clock = controllableClock();
    const { adapter, dormantLegsAlerts } = makeAdapter(
      client,
      new InMemoryBrokerStateStore(),
      RESOLVER,
      clock,
    );

    await primeDormantDeferAlert(adapter, clock);
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    clock.advance(DORMANT_DEFER_ALERT_REPEAT_EVERY_MS);
    await adapter.getOrder('key-3usl-0930', '3USL');
    expect(dormantLegsAlerts.alerts).toHaveLength(2);
  });

  it(
    'a wedge polled at the real fill-poll cadence does not flood — DORMANT_DEFER_ALERT_REPEAT_EVERY_MS / FILL_POLL_INTERVAL_MS polls apart, not ' +
      'every DORMANT_DEFER_ALERT_REPEAT_EVERY polls (#1426, the poll-count-riding-cadence shape #1383 measured as a flood for the deleted ALERT_REPEAT_EVERY_ZERO_SIZE)',
    async () => {
      const client = makeClient({
        listOpenOrders: vi.fn().mockResolvedValue([dormantLeg()]),
        listOrderActivities: vi.fn().mockResolvedValue([activity()]),
      });
      const clock = controllableClock();
      const { adapter, dormantLegsAlerts } = makeAdapter(
        client,
        new InMemoryBrokerStateStore(),
        RESOLVER,
        clock,
      );

      const twoHoursOfPolls = Math.floor((2 * 60 * 60_000) / FILL_POLL_INTERVAL_MS);
      for (let i = 0; i < twoHoursOfPolls; i++) {
        await adapter.getOrder('key-3usl-0930', '3USL');
        clock.advance(FILL_POLL_INTERVAL_MS);
      }

      const expectedRepeats = Math.floor(
        ((twoHoursOfPolls - DORMANT_DEFER_ALERT_AFTER) * FILL_POLL_INTERVAL_MS) /
          DORMANT_DEFER_ALERT_REPEAT_EVERY_MS,
      );
      expect(dormantLegsAlerts.alerts).toHaveLength(1 + expectedRepeats);
      expect(dormantLegsAlerts.alerts.length).toBeLessThan(10);
    },
  );

  it('clears the deferred count once the audit trail settles, so a later dormant episode starts its own bound fresh (#1215 round 2)', async () => {
    const listOpenOrders = vi.fn().mockResolvedValue([dormantLeg()]);
    const listOrderActivities = vi.fn().mockResolvedValue([activity()]);
    const client = makeClient({ listOpenOrders, listOrderActivities });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    for (let i = 0; i < DORMANT_DEFER_ALERT_AFTER; i++) {
      await adapter.getOrder('key-3usl-0930', '3USL');
    }
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    listOrderActivities.mockResolvedValue([activity({ Status: 'Expired' })]);
    await adapter.getOrder('key-3usl-0930', '3USL');
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

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
          ExternalReference: wireLegRef('key-3usl-0930', 'target'),
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

  it('downgrades an activated leg pair to the venue-confirmed terminal state when the master expired without filling (#1215/#1426)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Expired' })]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order?.order_state).toBe('expired');
    expect(client.cancelOrder).toHaveBeenCalledTimes(2);
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
  });

  it('keeps an activated leg pair filled when the audit trail carries no row at all — absence of evidence never downgrades a possibly live fill, unlike the dormant-legs check (#1215/#1426)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi.fn().mockResolvedValue([]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("keeps an activated leg pair filled while the master's audit row has not settled yet — deferring here would delay recognizing a live position (#1215/#1426)", async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("keeps an activated leg pair filled when the master's own audit row confirms Filled — the genuine-fill path is unchanged (#1215/#1426)", async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi
        .fn()
        .mockResolvedValue([activity({ Status: 'FinalFill', FillAmount: 3 })]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("keeps an activated leg pair filled when the master's terminal audit row carries a nonzero FillAmount, and reports that FillAmount rather than the leg's resting Amount (#1215/#1426, #1563)", async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi
        .fn()
        .mockResolvedValue([activity({ Status: 'Cancelled', FillAmount: 2 })]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 2 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("keeps an activated leg pair filled when a fill row is followed by a SEPARATE later terminal row for the same reference, reporting the fill row's own FillAmount rather than the leg's resting Amount — a partial-fill residual cancelled at close must not read as 'never filled' just because it is the latest row (#1215/#1426 round 3, #1563)", async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({ Status: 'FinalFill', FillAmount: 2, AveragePrice: 10 }),
        activity({
          LogId: 'log-2',
          Status: 'Cancelled',
          ActivityTime: '2026-09-05T16:30:00.000000Z',
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 2 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('sums FillAmount across every fill-evidencing row rather than the latest one, so a fill split across multiple activity rows is not under-reported (#1563)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({ Status: 'FinalFill', FillAmount: 1, AveragePrice: 10 }),
        activity({
          LogId: 'log-2',
          Status: 'FinalFill',
          FillAmount: 2,
          AveragePrice: 10,
          ActivityTime: '2026-09-05T08:31:00.000000Z',
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("falls back to the leg's resting Amount when the only fill-evidencing row carries no FillAmount — a summed 0 is 'no better evidence', not a genuine zero-fill (#1574)", async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'FinalFill' })]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('clamps the summed filled_qty at the order Amount — duplicate fill rows under one wire reference must not report a fill larger than the order itself (#1574)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({ Status: 'FinalFill', FillAmount: 3, AveragePrice: 10 }),
        activity({
          LogId: 'log-2',
          Status: 'FinalFill',
          FillAmount: 1,
          AveragePrice: 10,
          ActivityTime: '2026-09-05T08:31:00.000000Z',
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('cancels every leg row on an activated-legs expiry, not just one per role — a duplicate row under the same leg reference must not be left resting (#1215 round 3)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([
          dormantLeg({ Status: 'Working' }),
          dormantLeg({ OrderId: '5040047180', Status: 'Working' }),
          targetLeg({ Status: 'Working' }),
        ]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Expired' })]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order?.order_state).toBe('expired');
    expect(client.cancelOrder).toHaveBeenCalledTimes(3);
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047180');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
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

  it("maps the venue's own full-fill audit row — Status 'FinalFill', not 'Filled' (#1216, measured on SIM 2026-09-10) — to 'filled'", async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({
          LogId: '252169181',
          Status: 'FinalFill',
          SubStatus: 'Confirmed',
          ActivityTime: '2026-09-05T08:40:00.000000Z',
          FillAmount: 3,
          AveragePrice: 709.07,
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);

    const order = await adapter.getOrder('key-3usl-0930', '3USL');

    expect(order).toMatchObject({ order_state: 'filled', filled_qty: 3 });
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
          ExternalReference: wireRef('flat-1'),
          OpenOrderType: 'Market',
          OrderRelation: 'StandAlone',
          BuySell: 'Sell',
          RelatedOpenOrders: [],
        }),
      ]);
    const client = makeClient({
      listOpenOrders,
      placeOrder: vi
        .fn()
        .mockResolvedValue({ OrderId: '777', ExternalReference: wireRef('flat-1') }),
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
      ExternalReference: wireRef('flat-1'),
    });
    expect(first.broker_order_ids).toEqual(['777']);
    expect(second.broker_order_ids).toEqual(['777']);
  });

  it('resumeFlatten answers null only when the venue knows no such order', async () => {
    const { adapter } = makeAdapter(makeClient());

    expect(await adapter.resumeFlatten('flat-1', '3USL')).toBeNull();
  });

  it('cancels a flatten whose activity-trail lookup is failing — the two use different endpoints', async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockRejectedValue(new Error('activities endpoint 503')),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.resumeFlatten('flat-1', '3USL')).rejects.toThrow();
    await expect(adapter.cancel('flat-1', '3USL')).resolves.toBeUndefined();
    expect(client.listOpenOrders).toHaveBeenCalled();
  });

  it('adopts an instantly-filled flatten off the audit trail when the 409 retry finds nothing open (#1217)', async () => {
    const listOrderActivities = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        activity({
          OrderId: '777',
          ExternalReference: wireRef('flat-1'),
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
          ExternalReference: wireRef('flat-1'),
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
          ExternalReference: wireRef('flat-1'),
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

    await expect(adapter.submitFlatten('3USL', 'sell', 3, 'flat-1')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'submitFlatten',
      venueCode: 'DeadOrderUnderReference',
    });
  });

  it("computes the 409 retry's audit-trail read from PLACEMENT_LOOKBACK_MS (#1217)", async () => {
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
                  ExternalReference: wireRef('flat-1'),
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
  it('cancels the master alone and leaves the legs to the venue (doc 43:33), naming no leg from a snapshot the entry can fill out of (#1216)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([workingMaster(), dormantLeg(), targetLeg()]),
    });
    const { adapter } = makeAdapter(client);

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047177');
  });

  it('refuses without deleting a leg when the entry fills between the open-orders read and the master DELETE (#1216)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValueOnce([workingMaster(), dormantLeg(), targetLeg()])
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
      cancelOrder: vi.fn(async (orderId: string) => {
        if (orderId === '5040047177') {
          throw new SaxoBrokerProviderError('Saxo API error: 404', 404, 'OrderNotFound', 'gone');
        }
      }),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'cancel',
      venueCode: 'EntryFilledDuringCancel',
    });
    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047179');
  });

  it('refuses on a fill the audit trail confirms, even where the re-read still shows the legs NotWorking (#1216)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValueOnce([workingMaster(), dormantLeg(), targetLeg()])
        .mockResolvedValue([dormantLeg(), targetLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Filled' })]),
      cancelOrder: vi.fn(async (orderId: string) => {
        if (orderId === '5040047177') {
          throw new SaxoBrokerProviderError('Saxo API error: 404', 404, 'OrderNotFound', 'gone');
        }
      }),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'cancel',
      venueCode: 'EntryFilledDuringCancel',
    });
    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
  });

  it('cancels the legs when the master went while this call ran but the audit trail says it never filled (#1216)', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValueOnce([workingMaster(), dormantLeg(), targetLeg()])
        .mockResolvedValue([dormantLeg(), targetLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Expired' })]),
      cancelOrder: vi.fn(async (orderId: string) => {
        if (orderId === '5040047177') {
          throw new SaxoBrokerProviderError('Saxo API error: 404', 404, 'OrderNotFound', 'gone');
        }
      }),
    });
    const { adapter } = makeAdapter(client);

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
  });

  it('leaves the legs in place and pages when the master went inside this call and the audit trail answers nothing (#1216)', async () => {
    let reads = 0;
    const client = makeClient({
      listOpenOrders: vi.fn(async () =>
        reads++ % 2 === 0
          ? [workingMaster(), dormantLeg(), targetLeg()]
          : [dormantLeg(), targetLeg()],
      ),
      listOrderActivities: vi.fn().mockResolvedValue([]),
      cancelOrder: vi.fn(async (orderId: string) => {
        if (orderId === '5040047177') {
          throw new SaxoBrokerProviderError('Saxo API error: 404', 404, 'OrderNotFound', 'gone');
        }
      }),
    });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).resolves.toBeUndefined();

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047179');

    for (let poll = 1; poll < DORMANT_DEFER_ALERT_AFTER; poll++) {
      await adapter.cancel('key-3usl-0930', '3USL');
    }

    expect(dormantLegsAlerts.alerts).toHaveLength(1);
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047179');
  });

  it('refuses on a Filled audit row under dormant legs even with no master seen open (#1216)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg(), targetLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Filled' })]),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).rejects.toMatchObject({
      name: 'BrokerError',
      operation: 'cancel',
      venueCode: 'EntryFilledDuringCancel',
    });
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('keeps the legs and pages across the live cancel/reconcile/cancel sequence (#1216 round 2)', async () => {
    let reads = 0;
    const client = makeClient({
      listOpenOrders: vi.fn(async () =>
        reads++ === 0 ? [workingMaster(), dormantLeg(), targetLeg()] : [dormantLeg(), targetLeg()],
      ),
      listOrderActivities: vi.fn().mockResolvedValue([]),
      cancelOrder: vi.fn(async (orderId: string) => {
        if (orderId === '5040047177') {
          throw new SaxoBrokerProviderError('Saxo API error: 404', 404, 'OrderNotFound', 'gone');
        }
      }),
    });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).resolves.toBeUndefined();

    const reconcilePoll = await adapter.getOrder('key-3usl-0930', '3USL').then(
      (order) => order,
      (error: unknown) => error,
    );

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(reconcilePoll).toMatchObject({
      name: 'BrokerError',
      operation: 'getOrder',
      venueCode: 'DormantLegsUncorroborated',
    });
    expect(dormantLegsAlerts.alerts).toHaveLength(1);

    await expect(adapter.cancel('key-3usl-0930', '3USL')).resolves.toBeUndefined();

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047177');
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).not.toHaveBeenCalledWith('5040047179');
  });

  it('pages once a Filled-row refusal repeats on the same reference (#1216 round 2)', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg(), targetLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Filled' })]),
    });
    const { adapter, dormantLegsAlerts } = makeAdapter(client);

    for (let poll = 0; poll < DORMANT_DEFER_ALERT_AFTER; poll++) {
      await expect(adapter.cancel('key-3usl-0930', '3USL')).rejects.toMatchObject({
        venueCode: 'EntryFilledDuringCancel',
      });
    }

    expect(dormantLegsAlerts.alerts).toHaveLength(1);
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('resolves on OrderNotFound when the master is the only open row and the re-read finds nothing left', async () => {
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

  it('cancels activated legs when no master is open — the caller holds the lot and must clear them before flattening', async () => {
    const client = makeClient({
      listOpenOrders: vi
        .fn()
        .mockResolvedValue([dormantLeg({ Status: 'Working' }), targetLeg({ Status: 'Working' })]),
    });
    const { adapter } = makeAdapter(client);

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
    expect(client.listOrderActivities).not.toHaveBeenCalled();
  });

  it('does not cancel dormant legs the audit trail has not settled, on Status alone (#1215 ruling (a))', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg(), targetLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity()]),
    });
    const { adapter } = makeAdapter(client);

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('cancels dormant legs once the audit trail confirms the master died without filling', async () => {
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([dormantLeg(), targetLeg()]),
      listOrderActivities: vi.fn().mockResolvedValue([activity({ Status: 'Expired' })]),
    });
    const { adapter } = makeAdapter(client);

    await adapter.cancel('key-3usl-0930', '3USL');

    expect(client.cancelOrder).toHaveBeenCalledWith('5040047178');
    expect(client.cancelOrder).toHaveBeenCalledWith('5040047179');
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

  it('rearmProtectiveLegs refuses as a PERMANENT gap, outside the sanitizeBrokerError wrapper (#1214)', async () => {
    const client = makeClient();
    const { adapter } = makeAdapter(client);

    const error = await adapter.rearmProtectiveLegs('key-3usl-0930', '3USL', 'buy', 3, 9, 12).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(isProtectiveRearmUnsupported(error)).toBe(true);
    expect(error).not.toBeInstanceOf(BrokerError);
    expect((error as ProtectiveRearmUnsupportedError).venue).toBe('saxo');
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
      sessionCalendars: OPEN_SESSION_CALENDARS,
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
      unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
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
          ExternalReference: wireLegRef('key-3usl-0930', 'stop'),
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
        fx_rate_to_gbp_source: 'not_reported_by_venue',
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
        fx_rate_to_gbp_source: 'not_reported_by_venue',
        timestamp: new Date('2026-09-05T10:00:00Z'),
      },
    ]);
  });

  it("books a flatten's fill as an 'exit' leg", async () => {
    const client = makeClient({
      placeOrder: vi
        .fn()
        .mockResolvedValue({ OrderId: '777', ExternalReference: wireRef('flat-1') }),
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({
          LogId: 'log-flat',
          OrderId: '777',
          ExternalReference: wireRef('flat-1'),
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

  it('fails the sweep on a fill whose Uic resolves to no pool line, booking neither it nor its batch', async () => {
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
          ExternalReference: wireLegRef('key-3usl-0930', 'stop'),
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 8.98,
          ActivityTime: '2026-09-05T10:00:00Z',
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);
    await adapter.submitBracket(makeBracket());

    await expect(adapter.fetchNewFills(since)).rejects.toThrow(/log-fill/);
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

  it("throws on the venue's own FinalFill row carrying no fill amount or price — the shape a Filled-only guard would have dropped (#1216)", async () => {
    const client = makeClient({
      listOrderActivities: vi
        .fn()
        .mockResolvedValue([activity({ LogId: 'log-fill', Status: 'FinalFill' })]),
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
          ExternalReference: wireLegRef('key-old', 'target'),
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

describe('saxoInstrumentResolverFromVenue', () => {
  it('maps every checked-in pool row with its own Saxo line, and only those', async () => {
    const resolver = await saxoInstrumentResolverFromVenue(LSE_ETP_POOL, detailsClient());
    const own = LSE_ETP_POOL.filter((row) => row.provenance.saxo.line !== null);
    const siblingOnly = LSE_ETP_POOL.filter(
      (row) => row.provenance.saxo.line === null && row.provenance.saxo.sibling_line !== undefined,
    );

    expect(own.length).toBe(14);
    for (const row of own) {
      const line = row.provenance.saxo.line;
      if (line === null) throw new Error('unreachable');
      expect(resolver.resolve(row.lse_ticker)).toEqual({
        uic: line.uic,
        asset_type: line.asset_type,
        currency: 'USD',
        price_currency: 'USD',
        price_to_contract_factor: 1,
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

describe('SaxoBrokerAdapter GBX price unit (#1302)', () => {
  const GBX_BRACKET: NativeBracketRequest = {
    client_order_id: 'key-lqq3-0930',
    instrument: 'LQQ3',
    asset_class: 'stocks',
    side: 'buy',
    size: 1,
    entry: 311.51,
    stop: 305,
    target: 320.25,
    time_in_force: 'day',
  };

  function gbxPlacement(): SaxoOrderPlacement {
    return {
      ExternalReference: wireRef(GBX_BRACKET.client_order_id),
      OrderId: '5040047200',
      Orders: [
        {
          ExternalReference: wireLegRef(GBX_BRACKET.client_order_id, 'target'),
          OrderId: '5040047202',
        },
        {
          ExternalReference: wireLegRef(GBX_BRACKET.client_order_id, 'stop'),
          OrderId: '5040047201',
        },
      ],
    };
  }

  it('sends entry, stop and target to the venue in the quoted unit (pence), not in pounds', async () => {
    const client = makeClient({ placeOrder: vi.fn().mockResolvedValue(gbxPlacement()) });
    const { adapter } = makeAdapter(client, new InMemoryBrokerStateStore(), GBX_RESOLVER);

    await adapter.submitBracket(GBX_BRACKET);

    const request = vi.mocked(client.placeOrder).mock.calls[0]?.[0];
    expect(request?.OrderPrice).toBe(31151);
    const legs = Object.fromEntries(
      (request?.Orders ?? []).map((leg) => [leg.OrderType, leg.OrderPrice]),
    );
    expect(legs).toEqual({ StopIfTraded: 30500, Limit: 32025 });
  });

  it('books a fill at cash per share, with the fee on that figure in the settlement currency', async () => {
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue(gbxPlacement()),
      listOrderActivities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          activity({
            ExternalReference: wireRef(GBX_BRACKET.client_order_id),
            Uic: GBX_REF.uic,
            Status: 'Filled',
            Amount: 1,
            FillAmount: 1,
            AveragePrice: 31151,
          }),
        ]),
    });
    const { adapter } = makeAdapter(client, new InMemoryBrokerStateStore(), GBX_RESOLVER);
    await adapter.submitBracket(GBX_BRACKET);

    const [fill] = await adapter.fetchNewFills(new Date('2026-09-05T08:00:00Z'));

    expect(fill?.price).toBeCloseTo(311.51, 8);
    expect(fill?.fee).toBeCloseTo(311.51 * SAXO_COMMISSION_RATE, 8);
    expect(fill?.fee_currency).toBe('GBP');
    expect(fill?.fx_rate_to_gbp).toBeUndefined();
    expect(fill?.fx_rate_to_gbp_source).toBeUndefined();
  });

  it('reports an open position average price in cash', async () => {
    const client = makeClient({
      listNetPositions: vi.fn().mockResolvedValue([
        {
          NetPositionId: 'LQQ3-pos',
          NetPositionBase: { Amount: 4, Uic: GBX_REF.uic, AssetType: 'Etn' },
          NetPositionView: { AverageOpenPrice: 31151 },
        } satisfies SaxoNetPosition,
      ]),
    });
    const { adapter } = makeAdapter(client, new InMemoryBrokerStateStore(), GBX_RESOLVER);

    const [position] = await adapter.getOpenPositions();

    expect(position?.instrument).toBe('LQQ3');
    expect(position?.avg_entry_price).toBeCloseTo(311.51, 8);
  });

  it('reports a position under an unresolvable Uic with a null price rather than a venue-scale one', async () => {
    const client = makeClient({
      listNetPositions: vi.fn().mockResolvedValue([
        {
          NetPositionId: 'unknown-pos',
          NetPositionBase: { Amount: 4, Uic: 999999, AssetType: 'Etn' },
          NetPositionView: { AverageOpenPrice: 31151 },
        } satisfies SaxoNetPosition,
      ]),
    });
    const { adapter, logger } = makeAdapter(client, new InMemoryBrokerStateStore(), GBX_RESOLVER);

    const [position] = await adapter.getOpenPositions();

    expect(position?.avg_entry_price).toBeNull();
    expect(logger.entries.map((entry) => entry.event)).toContain(
      'saxo_position_price_unit_unresolved',
    );
  });

  it('refuses to book a fill whose Uic resolves to no line, rather than booking it unscaled', async () => {
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue(gbxPlacement()),
      listOrderActivities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          activity({
            ExternalReference: wireRef(GBX_BRACKET.client_order_id),
            Uic: 999999,
            Status: 'Filled',
            Amount: 1,
            FillAmount: 1,
            AveragePrice: 31151,
          }),
        ]),
    });
    const { adapter, priceUnitAlerts } = makeAdapter(
      client,
      new InMemoryBrokerStateStore(),
      GBX_RESOLVER,
    );
    await adapter.submitBracket(GBX_BRACKET);

    await expect(adapter.fetchNewFills(new Date('2026-09-05T08:00:00Z'))).rejects.toThrow(
      /resolves to no pool line/,
    );
    expect(priceUnitAlerts.alerts).toEqual([
      {
        client_order_id: GBX_BRACKET.client_order_id,
        broker_fill_id: 'log-1',
        uic: 999999,
        observed_at: new Date('2026-09-05T09:00:00Z'),
      },
    ]);
  });

  it('refuses every poll while paging on the throttle cadence for one unresolvable Uic', async () => {
    let row = 0;
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue(gbxPlacement()),
      listOrderActivities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementation(async () => {
          row += 1;
          return [
            activity({
              LogId: `log-${row}`,
              ExternalReference: wireRef(GBX_BRACKET.client_order_id),
              Uic: 999999,
              Status: 'Filled',
              Amount: 1,
              FillAmount: 1,
              AveragePrice: 31151,
            }),
          ];
        }),
    });
    const { adapter, priceUnitAlerts } = makeAdapter(
      client,
      new InMemoryBrokerStateStore(),
      GBX_RESOLVER,
    );
    await adapter.submitBracket(GBX_BRACKET);
    const since = new Date('2026-09-05T08:00:00Z');

    for (let poll = 0; poll < PRICE_UNIT_ALERT_REPEAT_EVERY; poll += 1) {
      await expect(adapter.fetchNewFills(since)).rejects.toThrow(/resolves to no pool line/);
    }

    expect(priceUnitAlerts.alerts.map((alert) => alert.broker_fill_id)).toEqual(['log-1']);

    await expect(adapter.fetchNewFills(since)).rejects.toThrow(/resolves to no pool line/);

    expect(priceUnitAlerts.alerts.map((alert) => alert.broker_fill_id)).toEqual([
      'log-1',
      `log-${PRICE_UNIT_ALERT_REPEAT_EVERY + 1}`,
    ]);
  });

  it('pages a different unresolvable Uic immediately', async () => {
    const filled = {
      ExternalReference: wireRef(GBX_BRACKET.client_order_id),
      Status: 'Filled' as const,
      Amount: 1,
      FillAmount: 1,
      AveragePrice: 31151,
    };
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue(gbxPlacement()),
      listOrderActivities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([activity({ ...filled, LogId: 'log-a', Uic: 999999 })])
        .mockResolvedValue([activity({ ...filled, LogId: 'log-b', Uic: 888888 })]),
    });
    const { adapter, priceUnitAlerts } = makeAdapter(
      client,
      new InMemoryBrokerStateStore(),
      GBX_RESOLVER,
    );
    await adapter.submitBracket(GBX_BRACKET);
    const since = new Date('2026-09-05T08:00:00Z');

    await expect(adapter.fetchNewFills(since)).rejects.toThrow(/resolves to no pool line/);
    await expect(adapter.fetchNewFills(since)).rejects.toThrow(/resolves to no pool line/);

    expect(priceUnitAlerts.alerts.map((alert) => alert.uic)).toEqual([999999, 888888]);
  });

  it('nulls the price every poll while logging the unresolvable position Uic on the cadence', async () => {
    const client = makeClient({
      listNetPositions: vi.fn().mockResolvedValue([
        {
          NetPositionId: 'unknown-pos',
          NetPositionBase: { Amount: 4, Uic: 999999, AssetType: 'Etn' },
          NetPositionView: { AverageOpenPrice: 31151 },
        } satisfies SaxoNetPosition,
      ]),
    });
    const { adapter, logger } = makeAdapter(client, new InMemoryBrokerStateStore(), GBX_RESOLVER);
    const logged = () =>
      logger.entries.filter((entry) => entry.event === 'saxo_position_price_unit_unresolved')
        .length;

    for (let poll = 0; poll < PRICE_UNIT_ALERT_REPEAT_EVERY; poll += 1) {
      const [position] = await adapter.getOpenPositions();
      expect(position?.avg_entry_price).toBeNull();
    }

    expect(logged()).toBe(1);

    await adapter.getOpenPositions();

    expect(logged()).toBe(2);
  });

  it('books a fill for one lot while an owned non-fill row under an unknown Uic sits in the sweep', async () => {
    const other: NativeBracketRequest = { ...GBX_BRACKET, client_order_id: 'key-lqq3-1000' };
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue(gbxPlacement()),
      listOrderActivities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          activity({
            LogId: 'log-stale',
            ExternalReference: wireRef(GBX_BRACKET.client_order_id),
            Uic: 999999,
            Status: 'Placed',
          }),
          activity({
            LogId: 'log-fill',
            ExternalReference: wireRef(other.client_order_id),
            Uic: GBX_REF.uic,
            Status: 'Filled',
            Amount: 1,
            FillAmount: 1,
            AveragePrice: 31151,
          }),
        ]),
    });
    const { adapter, priceUnitAlerts } = makeAdapter(
      client,
      new InMemoryBrokerStateStore(),
      GBX_RESOLVER,
    );
    await adapter.submitBracket(GBX_BRACKET);
    await adapter.submitBracket(other);

    const fills = await adapter.fetchNewFills(new Date('2026-09-05T08:00:00Z'));

    expect(fills.map((fill) => fill.broker_fill_id)).toEqual(['log-fill']);
    expect(fills[0]?.price).toBeCloseTo(311.51, 8);
    expect(priceUnitAlerts.alerts).toEqual([]);
  });

  it('leaves a USD line (factor 1.0) at the numbers it was given, both directions', async () => {
    const client = makeClient({
      listOrderActivities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([activity({ Status: 'Filled', FillAmount: 3, AveragePrice: 10.25 })]),
    });
    const { adapter } = makeAdapter(client);

    await adapter.submitBracket(makeBracket());
    const [fill] = await adapter.fetchNewFills(new Date('2026-09-05T08:00:00Z'));

    expect(vi.mocked(client.placeOrder).mock.calls[0]?.[0].OrderPrice).toBe(10);
    expect(fill?.price).toBe(10.25);
    expect(fill?.fee_currency).toBe('USD');
    expect(fill?.fx_rate_to_gbp).toBeUndefined();
    expect(fill?.fx_rate_to_gbp_source).toBe('not_reported_by_venue');
  });

  it('turns the D5 cash allowance into a non-zero quantity on a GBX line', () => {
    const D5_INDEX_CASH_GBP = 350;
    const quoted = 2435;

    expect(Math.floor(D5_INDEX_CASH_GBP / saxoCashPerShare(GBX_REF, quoted))).toBe(14);
  });
});

describe('saxoInstrumentResolverFromVenue quote units (#1302)', () => {
  const GBX_ROW = [
    {
      lse_ticker: 'LQQ3',
      provenance: { saxo: { line: { uic: 29391797, asset_type: 'Etn' as const } } },
    },
  ];

  it('carries the venue-published factor and settlement currency onto the resolved ref', async () => {
    const client = detailsClient(
      new Map([
        [29391797, { CurrencyCode: 'GBP', PriceCurrency: 'GBX', PriceToContractFactor: 0.01 }],
      ]),
    );

    const resolver = await saxoInstrumentResolverFromVenue(GBX_ROW, client);

    expect(resolver.resolve('LQQ3')).toEqual({
      uic: 29391797,
      asset_type: 'Etn',
      currency: 'GBP',
      price_currency: 'GBX',
      price_to_contract_factor: 0.01,
    });
    expect(client.getInstrumentDetails).toHaveBeenCalledWith(29391797, 'Etn');
  });

  it('refuses a line quoted in one currency, settled in another, with a factor of 1', async () => {
    const client = detailsClient(
      new Map([
        [29391797, { CurrencyCode: 'GBP', PriceCurrency: 'GBX', PriceToContractFactor: 1 }],
      ]),
    );

    await expect(saxoInstrumentResolverFromVenue(GBX_ROW, client)).rejects.toThrow(
      /self-contradictory/,
    );
  });

  it('refuses a scaling factor no PriceCurrency difference corroborates', async () => {
    const absent = detailsClient(
      new Map([
        [29391797, { CurrencyCode: 'GBP', PriceCurrency: undefined, PriceToContractFactor: 0.01 }],
      ]),
    );
    const same = detailsClient(
      new Map([
        [29391797, { CurrencyCode: 'GBP', PriceCurrency: 'GBP', PriceToContractFactor: 0.01 }],
      ]),
    );

    await expect(saxoInstrumentResolverFromVenue(GBX_ROW, absent)).rejects.toThrow(
      /self-contradictory/,
    );
    await expect(saxoInstrumentResolverFromVenue(GBX_ROW, same)).rejects.toThrow(
      /self-contradictory/,
    );
  });

  it('resolves a line with no PriceCurrency and a factor of 1', async () => {
    const client = detailsClient(
      new Map([
        [29391797, { CurrencyCode: 'GBP', PriceCurrency: undefined, PriceToContractFactor: 1 }],
      ]),
    );

    const resolver = await saxoInstrumentResolverFromVenue(GBX_ROW, client);

    expect(resolver.resolve('LQQ3')?.price_to_contract_factor).toBe(1);
  });
});

describe('SaxoBrokerAdapter Saxo ExternalReference derivation (#1510)', () => {
  const HEX_64_KEY = 'a'.repeat(64);

  it('derives a fixed 40-hex reference, well inside the 50-char venue field even with a leg suffix', () => {
    const ref = saxoExternalReference(HEX_64_KEY);

    expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(`${ref}:target`.length).toBeLessThanOrEqual(50);
  });

  it('derives DISTINCT references for a retry/residual-reflatten suffix, never truncating the base digest', () => {
    const base = saxoExternalReference(HEX_64_KEY);
    const retry1 = saxoExternalReference(`${HEX_64_KEY}:retry-1`);
    const retry2 = saxoExternalReference(`${HEX_64_KEY}:retry-2`);
    const residual = saxoExternalReference(`${HEX_64_KEY}:residual-reflatten-1`);

    expect(new Set([base, retry1, retry2, residual]).size).toBe(4);
  });

  it('places a bracket under the real 64-character idempotency key without refusing', async () => {
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue({
        OrderId: '9000',
        ExternalReference: saxoExternalReference(HEX_64_KEY),
        Orders: [
          { OrderId: '9001', ExternalReference: `${saxoExternalReference(HEX_64_KEY)}:stop` },
          { OrderId: '9002', ExternalReference: `${saxoExternalReference(HEX_64_KEY)}:target` },
        ],
      }),
    });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitBracket(makeBracket({ client_order_id: HEX_64_KEY }));

    expect(ack).toEqual({
      client_order_id: HEX_64_KEY,
      broker_order_ids: ['9000', '9001', '9002'],
      order_state: 'submitted',
    });
    const [request] = vi.mocked(client.placeOrder).mock.calls[0] ?? [];
    expect(request?.ExternalReference).toBe(saxoExternalReference(HEX_64_KEY));
    expect(request?.ExternalReference.length).toBeLessThanOrEqual(50);
  });

  it('flattens under the real 64-character idempotency key without refusing', async () => {
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue({
        OrderId: '9100',
        ExternalReference: saxoExternalReference(HEX_64_KEY),
      }),
    });
    const { adapter } = makeAdapter(client);

    const ack = await adapter.submitFlatten('3USL', 'sell', 3, HEX_64_KEY);

    expect(ack).toEqual({
      client_order_id: HEX_64_KEY,
      broker_order_ids: ['9100'],
      order_state: 'submitted',
    });
  });

  it('maps the Saxo wire reference back to the full 64-character client_order_id on getOrder, after a restart', async () => {
    const state = new InMemoryBrokerStateStore();
    state.saveBracket({
      venue: 'saxo',
      client_order_id: HEX_64_KEY,
      phase: 'armed',
      entry_order_id: '9000',
      stop_order_id: '9001',
      target_order_id: '9002',
      request: null,
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });
    const client = makeClient({
      listOpenOrders: vi.fn().mockResolvedValue([
        workingMaster({
          OrderId: '9000',
          ExternalReference: saxoExternalReference(HEX_64_KEY),
        }),
      ]),
    });
    const { adapter } = makeAdapter(client, state);

    const order = await adapter.getOrder(HEX_64_KEY, '3USL');

    expect(order?.client_order_id).toBe(HEX_64_KEY);
  });

  it('attributes a fill-sweep activity under the derived reference back to the full client_order_id', async () => {
    const client = makeClient({
      listOrderActivities: vi.fn().mockResolvedValue([
        activity({
          ExternalReference: saxoExternalReference(HEX_64_KEY),
          Status: 'Filled',
          FillAmount: 3,
          AveragePrice: 10,
        }),
      ]),
    });
    const { adapter } = makeAdapter(client);
    await adapter.submitBracket(makeBracket({ client_order_id: HEX_64_KEY }));

    const [fill] = await adapter.fetchNewFills(new Date('2026-09-05T08:00:00Z'));

    expect(fill?.client_order_id).toBe(HEX_64_KEY);
    expect(fill?.leg).toBe('entry');
  });
});
