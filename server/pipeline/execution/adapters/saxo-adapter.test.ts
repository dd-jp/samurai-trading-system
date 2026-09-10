/**
 * `SaxoBrokerAdapter` against a fake `SaxoOpenApiClient` (#1032 item 1).
 *
 * Every wire shape below is a recorded SIM-gateway response from 2026-09-05
 * (doc 43) with the account/client keys stripped — no credential appears here.
 */
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

/**
 * Mirrors `DEFAULT_FILL_POLL_INTERVAL_MS`'s default (production/defaults.ts)
 * — restated rather than imported, since that constant lives in
 * `apps/orchestrator` and this adapter's own tests live in `pipeline/`.
 */
const FILL_POLL_INTERVAL_MS = 15_000;

/**
 * #1214: `ExecutionInput.sessionCalendars`. An open venue for both classes —
 * nothing in this file turns on the residual re-flatten's session gate, and a
 * shut venue would stand that path down for a reason none of these tests are
 * about.
 */
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

/**
 * LQQ3, the GBX line of doc 44 §2.1's measured pair: quoted in pence,
 * settled in GBP, `PriceToContractFactor` 0.01.
 */
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

/** Every pool line answers as 3USL's did on SIM (USD/USD/1.0) unless a test says otherwise. */
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

/** The `:target` sibling of `dormantLeg`, as its own `listOpenOrders` row. */
function targetLeg(overrides: Partial<SaxoOpenOrder> = {}): SaxoOpenOrder {
  return dormantLeg({
    OrderId: '5040047179',
    ExternalReference: 'key-3usl-0930:target',
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

/**
 * A clock the test advances explicitly between polls, rather than one that
 * advances on its own read — `escalateIfStale`'s flow reads `clock.now()`
 * more than once per `getOrder` call (the activity lookback window, then the
 * defer record), so an auto-advancing clock would not correspond 1:1 with
 * polls. `advance` models one fill-poll interval
 * (`DEFAULT_FILL_POLL_INTERVAL_MS`) elapsing between polls, which is what the
 * dormant-defer repeat (`DORMANT_DEFER_ALERT_REPEAT_EVERY_MS`) is measured
 * against.
 */
function controllableClock(startAt = new Date('2026-09-05T09:00:00Z')) {
  let currentMs = startAt.getTime();
  return {
    now: () => new Date(currentMs),
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

/**
 * Drives `DORMANT_DEFER_ALERT_AFTER` polls against the same reference, one
 * `FILL_POLL_INTERVAL_MS` apart, so the first alert fires on the LAST poll —
 * and leaves `clock` exactly at that poll's timestamp (no trailing advance),
 * so a caller's next `clock.advance(x)` measures elapsed time since the
 * alert precisely rather than `x + FILL_POLL_INTERVAL_MS`.
 */
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

  // The dormant-legs defer (#1215 round 1) must win even when a corroborating
  // audit row IS available on the 409 retry — the retry reads the open list
  // only, never the audit trail, so a `Filled` row sitting right there is
  // never consulted (#1438). Consulting it would adopt a phantom fill on
  // `Status` evidence the retry itself cannot corroborate against a
  // `masterSeenOpen` fact, exactly what `cancel`'s corroboration path exists
  // to avoid doing on the placement side too.
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

    // One more poll, one fill-poll interval later — nowhere near
    // DORMANT_DEFER_ALERT_REPEAT_EVERY_MS since the first alert.
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

      // Simulate the real fill-poll loop for a 2-hour wedge: one poll every
      // FILL_POLL_INTERVAL_MS. At the pre-#1426 poll-count-8 repeat this would
      // have alerted every 8 polls (~2 minutes) — 60 times in 2 hours. At the
      // re-derived wall-clock repeat it must alert only on the polls that land
      // at or past each DORMANT_DEFER_ALERT_REPEAT_EVERY_MS boundary.
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
      // Each cancel() reads twice: the master is open on the first, gone on
      // the re-read after its DELETE 404s.
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

    // The wedge must reach the page, so the empty answer cannot clear the
    // consecutive-defer count on its way past.
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
      // The master is on the list for the first read only: it left inside the
      // first cancel and never comes back, which is the wedge itself.
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

    // Every poll runs reconcile() -> getOrder() on the same key before the
    // next cancel. That call must inherit "the master was open moments ago",
    // or it takes lookup's cancel-on-silence verdict and strips the legs one
    // poll after cancel refused to — so the DELETE count is asserted before
    // the answer, and only the master's own DELETE may have happened.
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

    // Both halves matter. The discriminator is what stops the #549 sweep
    // retrying a gap that can never close; throwing outside `this.call` is
    // what keeps the discriminator alive, since `sanitizeBrokerError` keeps
    // only `BrokerError`'s own fields (protective-rearm-unsupported.ts's
    // INVARIANT).
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
      sessionCalendars: OPEN_SESSION_CALENDARS,
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

  /**
   * Until #1302 this left that one fill's `fee_currency` unset and logged,
   * so a batch was never held hostage to one attribution gap. The price now
   * depends on the same lookup — without the line's factor a GBX quote is
   * 100x wrong — so the whole sweep fails instead. A transient cause clears
   * next poll (`ingestFills` re-drives off the open lots' `opened_at` rather
   * than a watermark); a persistent one wedges every poll until the pool or
   * the Uic is fixed, which is why the refusal also pages.
   */
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
          ExternalReference: 'key-3usl-0930:stop',
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

describe('saxoInstrumentResolverFromVenue', () => {
  it('maps every checked-in pool row with its own Saxo line, and only those', async () => {
    const resolver = await saxoInstrumentResolverFromVenue(LSE_ETP_POOL, detailsClient());
    const own = LSE_ETP_POOL.filter((row) => row.provenance.saxo.line !== null);
    const siblingOnly = LSE_ETP_POOL.filter(
      (row) => row.provenance.saxo.line === null && row.provenance.saxo.sibling_line !== undefined,
    );

    // 14 since #1220 added 3LUS, the sterling line of 3USL's ISIN, from this
    // same 2026-09-05 capture's own sibling record.
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

/**
 * #1302 — the GBX/GBP unit collision, end to end across the adapter's
 * boundary. LQQ3 is doc 44 §2.1's measured GBX line: `CurrencyCode` `GBP`,
 * `PriceCurrency` `GBX`, `PriceToContractFactor` `0.01`, so a quote of 31151
 * is £311.51 and not £31,151. Saxo's search endpoint — the pool's own source
 * — reports the line as `GBP` and carries neither of the last two fields, so
 * nothing but the details endpoint can tell the two readings apart.
 */
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
      ExternalReference: GBX_BRACKET.client_order_id,
      OrderId: '5040047200',
      Orders: [
        { ExternalReference: 'key-lqq3-0930:target', OrderId: '5040047202' },
        { ExternalReference: 'key-lqq3-0930:stop', OrderId: '5040047201' },
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
      // Empty for the placement's own adopt-or-place lookup, then the fill.
      listOrderActivities: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          activity({
            ExternalReference: GBX_BRACKET.client_order_id,
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
            ExternalReference: GBX_BRACKET.client_order_id,
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

  /**
   * `ingestFills` floors its `since` at the earliest open lot's `opened_at`
   * rather than advancing a watermark, so a PERSISTENT unresolvable Uic is
   * re-driven every poll. The refusal must fire on every one of them —
   * booking a possibly-100x price is the only outcome worse than the flood —
   * while the page repeats on the throttle's cadence instead. The `LogId`
   * changes each poll deliberately: the episode is the Uic, not the row that
   * happened to trigger it, and `fetchNewFills` refuses at the FIRST
   * unresolved row, so keying on the row would let a shifting venue order
   * restart the count and page every poll anyway.
   */
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
              ExternalReference: GBX_BRACKET.client_order_id,
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

  /** One episode per Uic: a second unresolvable line pages at once, not on the first one's cadence. */
  it('pages a different unresolvable Uic immediately', async () => {
    const filled = {
      ExternalReference: GBX_BRACKET.client_order_id,
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

  /** The same cadence on the read-only side, where the price is nulled rather than refused. */
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

  /**
   * The refusal is scoped to rows that carry a PRICE (#1302 round 1). An
   * owned row with no price — `Placed` here — has no unit to resolve, and
   * `ingestFills` floors its lookback at the earliest open lot's `opened_at`
   * rather than advancing a watermark, so a Uic the pool no longer knows
   * (pool edited under a live lot, restart mid-lot) would otherwise sit in
   * range and refuse every OTHER lot's fills on every poll, forever.
   */
  it('books a fill for one lot while an owned non-fill row under an unknown Uic sits in the sweep', async () => {
    const other: NativeBracketRequest = { ...GBX_BRACKET, client_order_id: 'key-lqq3-1000' };
    const client = makeClient({
      placeOrder: vi.fn().mockResolvedValue(gbxPlacement()),
      listOrderActivities: vi
        .fn()
        // Empty for each placement's own adopt-or-place lookup, then the sweep.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          activity({
            LogId: 'log-stale',
            ExternalReference: GBX_BRACKET.client_order_id,
            Uic: 999999,
            Status: 'Placed',
          }),
          activity({
            LogId: 'log-fill',
            ExternalReference: other.client_order_id,
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
      // Empty for the placement's own adopt-or-place lookup, then the fill.
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
  });

  /**
   * The issue's own blast-radius arithmetic, pinned against the conversion
   * rather than against the pipeline: ADR-0018 D5's £350 index allowance over
   * 3UKL at 2,435 GBp buys 14 shares, where the unconverted quote would have
   * put the instrument above the allowance and silently out of the tradeable
   * set. Nothing feeds a Saxo quote into sizing today (no LSE mark source,
   * #895), so this pins the consequence of the unit, not a wired path.
   */
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

  /**
   * The other side of the same coin flip, and the dangerous one: a scaling
   * factor no currency difference corroborates would resolve clean and read
   * 31151 as £3.1151, so an order aimed at £311.51 goes out as 31151. ADR-0018
   * D5 sizes cash-first, making that a 100x OVER-quantity on a live GIA rather
   * than the undersize the issue's own blast radius describes.
   */
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

  /**
   * That refusal is fail-closed at boot, so its boundary matters: a line
   * stating no quote unit and no scaling is not a contradiction — quote and
   * cash coincide whatever `PriceCurrency` would have said — and must still
   * resolve, or a gateway that merely omits the field takes the adapter down
   * for every line rather than for a mis-priced one.
   */
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
