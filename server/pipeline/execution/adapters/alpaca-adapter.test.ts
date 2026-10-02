import type {
  MarketDataService,
  TradingCalendar,
} from '../../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import type { AssetClass, OrderIntent } from '../../../shared/index.js';
import { type Clock, TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import type { CostModel } from '../../../tools/backtest/index.js';
import type { VerdictDecision } from '../../verdict/index.js';
import { BrokerError } from '../broker-error.js';
import { InMemoryBrokerStateStore, toRequestFields } from '../broker-state-store.js';
import { ExecutionImpl } from '../execute.js';
import { FilledZeroSizeThrottle } from '../filled-zero-size-throttle.js';
import { isProtectiveRearmUnsupported } from '../protective-rearm-unsupported.js';
import { ProtectiveReplaceError } from '../protective-replace-error.js';
import { openTestExecutionStore } from '../sqlite-store-harness.js';
import type { ExecutionConfig, ExecutionInput, NativeBracketRequest } from '../types.js';
import type { UnpricedFillAlert, UnpricedFillAlertChannel } from '../unpriced-fill-alert.js';
import { UnrecordedVenuePositionThrottle } from '../unrecorded-venue-position-throttle.js';
import {
  AlpacaBrokerAdapter,
  classifyPriorRearm,
  DEFAULT_UNPRICED_FILL_AGE_OUT_MS,
} from './alpaca-adapter.js';
import { AlpacaBrokerProviderError } from './alpaca-broker-errors.js';
import type {
  AlpacaBrokerClient,
  AlpacaOcoOrderRequest,
  AlpacaOrder,
  AlpacaOrderLeg,
} from './alpaca-client.js';
import { AlpacaHttpBrokerClient } from './alpaca-http-client.js';

const OPEN_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

function makeBracket(overrides: Partial<NativeBracketRequest> = {}): NativeBracketRequest {
  return {
    client_order_id: 'key-aapl-1355',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    ...overrides,
  };
}

function acceptedOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'alpaca-entry-1',
    client_order_id: 'key-aapl-1355',
    symbol: 'AAPL',
    side: 'buy',
    qty: '100',
    order_class: 'bracket',
    status: 'accepted',
    filled_qty: '0',
    filled_avg_price: null,
    filled_at: null,
    legs: [
      {
        id: 'alpaca-target-1',
        type: 'limit',
        status: 'held',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      },
      {
        id: 'alpaca-stop-1',
        type: 'stop',
        status: 'held',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      },
    ],
    ...overrides,
  };
}

function makeClient(overrides: Partial<AlpacaBrokerClient> = {}): AlpacaBrokerClient {
  return {
    submitOrder: vi.fn().mockResolvedValue(acceptedOrder()),
    getOrder: vi.fn().mockResolvedValue(acceptedOrder()),
    getOrderByClientOrderId: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override getOrderByClientOrderId to use it')),
    getAccount: vi.fn().mockRejectedValue(new Error('makeClient: override getAccount to use it')),
    submitMarketOrder: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override submitMarketOrder to use it')),
    submitOcoOrder: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override submitOcoOrder to use it')),
    cancelOrder: vi.fn().mockRejectedValue(new Error('makeClient: override cancelOrder to use it')),
    listOpenOrders: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override listOpenOrders to use it')),
    getPositions: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override getPositions to use it')),
    ...overrides,
  };
}

function recordingAlerts(): UnpricedFillAlertChannel & { readonly posted: UnpricedFillAlert[] } {
  const posted: UnpricedFillAlert[] = [];
  return {
    posted,
    postUnpricedFillAlert: async (alert) => {
      posted.push(alert);
    },
  };
}

class FixedClock implements Clock {
  #now: Date;

  constructor(now: Date) {
    this.#now = now;
  }

  now(): Date {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

function unpricedOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return acceptedOrder({
    status: 'filled',
    filled_qty: '100',
    filled_avg_price: null,
    filled_at: '2026-07-15T14:05:00Z',
    ...overrides,
  });
}

describe('AlpacaBrokerAdapter.submitBracket', () => {
  it('submits a native bracket order carrying entry + target + stop', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    await adapter.submitBracket(makeBracket());

    expect(client.submitOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      side: 'buy',
      qty: '100',
      limit_price: '100.00',
      time_in_force: 'day',
      client_order_id: 'key-aapl-1355',
      order_class: 'bracket',
      take_profit: { limit_price: '110.00' },
      stop_loss: { stop_price: '95.00' },
    });
  });

  it('refuses a bracket that is not stocks before anything reaches the wire or the journal', async () => {
    const client = makeClient();
    const state = new InMemoryBrokerStateStore();
    const adapter = new AlpacaBrokerAdapter({
      client,
      state,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    await expect(
      adapter.submitBracket(
        makeBracket({ client_order_id: 'key-btc', instrument: 'BTC-USD', asset_class: 'crypto' }),
      ),
    ).rejects.toThrow(
      new Error(
        "Alpaca adapter refuses 'key-btc' (BTC-USD): asset_class 'crypto' is not tradable here; " +
          'only US equities and ETFs are.',
      ),
    );
    expect(client.submitOrder).not.toHaveBeenCalled();
    expect(state.loadBrackets('alpaca')).toEqual([]);
  });

  it('submits a stop_limit parent when the bracket carries an entry trigger, the trigger on the tick grid and never above the limit (#1941)', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    await adapter.submitBracket(makeBracket({ entry: 100, entry_trigger: 99.501 }));
    await adapter.submitBracket(
      makeBracket({ client_order_id: 'point', entry: 100, entry_trigger: 100.004 }),
    );

    expect(client.submitOrder).toHaveBeenNthCalledWith(1, {
      symbol: 'AAPL',
      side: 'buy',
      qty: '100',
      limit_price: '100.00',
      stop_price: '99.51',
      time_in_force: 'day',
      client_order_id: 'key-aapl-1355',
      order_class: 'bracket',
      take_profit: { limit_price: '110.00' },
      stop_loss: { stop_price: '95.00' },
    });
    expect(client.submitOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        client_order_id: 'point',
        limit_price: '100.00',
        stop_price: '100.00',
      }),
    );
  });

  it('refuses a stop_limit parent whose trigger rounds onto the stop, submitting nothing (#1941)', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    await expect(
      adapter.submitBracket(makeBracket({ entry: 100, stop: 99.505, entry_trigger: 99.506 })),
    ).rejects.toThrow(/trigger 99.506 became 99.51, at or past the stop 99.51/);
    expect(client.submitOrder).not.toHaveBeenCalled();
  });

  it('rounds a sub-penny short bracket onto the venue price grid (#983)', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    await adapter.submitBracket(
      makeBracket({
        instrument: 'SPY',
        side: 'sell',
        size: 6,
        entry: 762.335,
        stop: 766.40805334,
        target: 754.18889332,
      }),
    );

    expect(client.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        limit_price: '762.34',
        stop_loss: { stop_price: '766.40' },
        take_profit: { limit_price: '754.19' },
      }),
    );
  });

  it("journals the ROUNDED request, not the caller's unrounded one (#983)", async () => {
    const client = makeClient();
    const state = new InMemoryBrokerStateStore();
    const saveBracket = vi.spyOn(state, 'saveBracket');
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      state,
    });

    await adapter.submitBracket(
      makeBracket({ side: 'sell', entry: 762.335, stop: 766.40805334, target: 754.18889332 }),
    );

    expect(saveBracket).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ entry: 762.34, stop: 766.4, target: 754.19 }),
      }),
    );
  });

  it('acks with the parent + attached OCO leg ids and a submitted state', async () => {
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient(),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    const ack = await adapter.submitBracket(makeBracket());

    expect(ack).toEqual({
      client_order_id: 'key-aapl-1355',
      broker_order_ids: ['alpaca-entry-1', 'alpaca-target-1', 'alpaca-stop-1'],
      order_state: 'submitted',
    });
  });

  it.each([
    ['new', 'submitted'],
    ['accepted', 'submitted'],
    ['partially_filled', 'partially_filled'],
    ['filled', 'filled'],
    ['canceled', 'cancelled'],
    ['rejected', 'rejected'],
    ['expired', 'expired'],
  ] as const)('maps Alpaca status %s to order_state %s', async (alpacaStatus, orderState) => {
    const client = makeClient({
      submitOrder: vi.fn().mockResolvedValue(acceptedOrder({ status: alpacaStatus })),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    const ack = await adapter.submitBracket(makeBracket());

    expect(ack.order_state).toBe(orderState);
  });
});

describe('AlpacaBrokerAdapter.fetchNewFills', () => {
  it('does not poll a bracket submitted while the pass is already in flight', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    (client.getOrder as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await adapter.submitBracket(makeBracket({ client_order_id: 'key-tsla-1400' }));
      return acceptedOrder();
    });

    await adapter.fetchNewFills(new Date(0));

    expect(client.getOrder).toHaveBeenCalledTimes(1);
  });

  it('normalizes an entry fill into the shared NormalizedFill shape', async () => {
    const filledAt = '2026-07-15T14:05:00Z';
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: filledAt,
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toEqual([
      {
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'alpaca-entry-1',
        leg: 'entry',
        price: 100.02,
        qty: 100,
        fee: 0,
        timestamp: new Date(filledAt),
        qty_is_cumulative: true,
      },
    ]);
  });

  it('collects a partial fill the venue has not dated, timestamped at the sweep clock', async () => {
    const now = new Date('2026-07-15T14:07:00Z');
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'partially_filled',
          filled_qty: '50',
          filled_avg_price: '100.02',
          filled_at: null,
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      clock: { now: () => now },
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toEqual([
      {
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'alpaca-entry-1',
        leg: 'entry',
        price: 100.02,
        qty: 50,
        fee: 0,
        timestamp: now,
        qty_is_cumulative: true,
      },
    ]);
  });

  it('re-offers the same order id at a growing cumulative filled_qty (#842)', async () => {
    const getOrder = vi
      .fn()
      .mockResolvedValueOnce(
        acceptedOrder({
          status: 'partially_filled',
          filled_qty: '50',
          filled_avg_price: '100',
          filled_at: '2026-07-15T14:05:00Z',
        }),
      )
      .mockResolvedValueOnce(
        acceptedOrder({
          status: 'canceled',
          filled_qty: '80',
          filled_avg_price: '100.75',
          filled_at: '2026-07-15T14:06:00Z',
        }),
      );
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient({ getOrder }),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    const first = await adapter.fetchNewFills(new Date(0));
    const second = await adapter.fetchNewFills(new Date(0));

    expect(first).toEqual([expect.objectContaining({ broker_fill_id: 'alpaca-entry-1', qty: 50 })]);
    expect(second).toEqual([
      expect.objectContaining({ broker_fill_id: 'alpaca-entry-1', qty: 80 }),
    ]);
    expect(second[0]?.qty_is_cumulative).toBe(true);
  });

  it('tags the take-profit leg as target and the stop-loss leg as stop', async () => {
    const filledAt = '2026-07-15T15:00:00Z';
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: '2026-07-15T14:05:00Z',
          legs: [
            {
              id: 'alpaca-target-1',
              type: 'limit',
              status: 'filled',
              filled_qty: '100',
              filled_avg_price: '110.00',
              filled_at: filledAt,
            },
            {
              id: 'alpaca-stop-1',
              type: 'stop',
              status: 'canceled',
              filled_qty: '0',
              filled_avg_price: null,
              filled_at: null,
            },
          ],
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));
    const legs = fills.map((fill) => fill.leg);

    expect(legs).toContain('entry');
    expect(legs).toContain('target');
    expect(legs).not.toContain('stop');

    const target = fills.find((fill) => fill.leg === 'target');
    expect(target).toMatchObject({ broker_fill_id: 'alpaca-target-1', qty: 100, price: 110 });
  });

  it('reports no fills while the bracket is still unfilled', async () => {
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient(),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    expect(await adapter.fetchNewFills(new Date(0))).toEqual([]);
  });

  it('serves fills from the poll cursor forward', async () => {
    const filledAt = new Date('2026-07-15T14:05:00Z');
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: filledAt.toISOString(),
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    expect(await adapter.fetchNewFills(filledAt)).toHaveLength(1);
    expect(await adapter.fetchNewFills(new Date(filledAt.getTime() + 1))).toHaveLength(0);
  });

  it('an unrecognized client order id yields no fills to poll', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    expect(await adapter.fetchNewFills(new Date(0))).toEqual([]);
    expect(client.getOrder).not.toHaveBeenCalled();
  });
});

describe('AlpacaBrokerAdapter integration: entry fill then stop-out', () => {
  it('normalizes the entry fill, then the stop fill, as the position round-trips to flat', async () => {
    const entryFilledAt = '2026-07-15T14:05:00Z';
    const stopFilledAt = '2026-07-15T16:30:00Z';

    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    vi.mocked(client.getOrder).mockResolvedValueOnce(
      acceptedOrder({
        status: 'filled',
        filled_qty: '100',
        filled_avg_price: '100.02',
        filled_at: entryFilledAt,
        legs: [
          {
            id: 'alpaca-target-1',
            type: 'limit',
            status: 'held',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
          {
            id: 'alpaca-stop-1',
            type: 'stop',
            status: 'held',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
        ],
      }),
    );
    const afterEntry = await adapter.fetchNewFills(new Date(0));
    expect(afterEntry).toEqual([
      {
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'alpaca-entry-1',
        leg: 'entry',
        price: 100.02,
        qty: 100,
        fee: 0,
        timestamp: new Date(entryFilledAt),
        qty_is_cumulative: true,
      },
    ]);

    vi.mocked(client.getOrder).mockResolvedValueOnce(
      acceptedOrder({
        status: 'filled',
        filled_qty: '100',
        filled_avg_price: '100.02',
        filled_at: entryFilledAt,
        legs: [
          {
            id: 'alpaca-target-1',
            type: 'limit',
            status: 'canceled',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
          {
            id: 'alpaca-stop-1',
            type: 'stop',
            status: 'filled',
            filled_qty: '100',
            filled_avg_price: '95.00',
            filled_at: stopFilledAt,
          },
        ],
      }),
    );
    const afterStopOut = await adapter.fetchNewFills(new Date(stopFilledAt));
    expect(afterStopOut).toEqual([
      {
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'alpaca-stop-1',
        leg: 'stop',
        price: 95,
        qty: 100,
        fee: 0,
        timestamp: new Date(stopFilledAt),
        qty_is_cumulative: true,
      },
    ]);
  });
});

describe('AlpacaBrokerAdapter outbound call discipline', () => {
  it('paces every outbound call through the rate limiter', async () => {
    const client = makeClient();
    const rateLimiter = permissiveLimiter();
    const acquire = vi.spyOn(rateLimiter, 'acquire');
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter,
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    await adapter.submitBracket(makeBracket());
    await adapter.fetchNewFills(new Date(0));

    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('never lets a venue error carry its HTTP context out of the adapter', async () => {
    const secret = 'PKTEST_APIKEY_9f2c';
    const client = makeClient({
      submitOrder: vi.fn().mockRejectedValue(
        Object.assign(new Error(`403 forbidden — APCA-API-KEY-ID: ${secret}`), {
          response: { status: 403 },
          code: 'forbidden',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });

    const error = await adapter.submitBracket(makeBracket()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).message).toBe(
      'alpaca submitBracket failed (status 403, code forbidden)',
    );
    expect((error as BrokerError).message).not.toContain(secret);
    expect('cause' in (error as BrokerError)).toBe(false);
  });

  it('populates BrokerError.venueCode from a real Alpaca 422 rejection body (#953)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: new Headers(),
      json: async () => ({
        code: 42210000,
        message: 'fractional orders must be simple orders that are DAY orders',
      }),
      text: async () =>
        JSON.stringify({
          code: 42210000,
          message: 'fractional orders must be simple orders that are DAY orders',
        }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    try {
      const httpClient = new AlpacaHttpBrokerClient({
        apiKey: 'test-fake-alpaca-key',
        apiSecret: 'test-fake-alpaca-secret',
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      });
      const adapter = new AlpacaBrokerAdapter({
        client: httpClient,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        logger: recordingLogger(),
      });

      const error = await adapter.submitBracket(makeBracket()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BrokerError);
      expect((error as BrokerError).venueCode).toBe('42210000');
      expect((error as BrokerError).venueMessage).toBe(
        'fractional orders must be simple orders that are DAY orders',
      );
      expect((error as BrokerError).message).toBe(
        'alpaca submitBracket failed (status 422, code 42210000): fractional orders must be ' +
          'simple orders that are DAY orders',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('AlpacaBrokerAdapter.fetchNewFills on inconsistent venue data', () => {
  it('does not fail the sweep for a filled quantity Alpaca reports no average price for', async () => {
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: null,
          filled_at: '2026-07-15T14:05:00Z',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    await expect(adapter.fetchNewFills(new Date(0))).resolves.toEqual([]);
  });

  it('refuses an unparseable filled_qty rather than booking NaN', async () => {
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: 'N/A',
          filled_avg_price: '100.02',
          filled_at: '2026-07-15T14:05:00Z',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    const error = await adapter.fetchNewFills(new Date(0)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringMatching(/unparseable filled_qty 'N\/A'/),
    });
  });

  it('isolates a malformed bracket so it cannot starve the rest of the sweep', async () => {
    const filledAt = '2026-07-15T15:00:00Z';
    const client = makeClient({
      getOrder: vi
        .fn()
        .mockResolvedValueOnce(
          acceptedOrder({
            id: 'alpaca-poisoned',
            status: 'filled',
            filled_qty: '100',
            filled_avg_price: null,
            filled_at: filledAt,
          }),
        )
        .mockResolvedValueOnce(
          acceptedOrder({
            id: 'alpaca-healthy',
            status: 'filled',
            filled_qty: '50',
            filled_avg_price: '100.02',
            filled_at: filledAt,
          }),
        ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket({ client_order_id: 'poisoned-lot' }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'healthy-lot' }));

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'healthy-lot', qty: 50, price: 100.02 });
  });
});

describe('AlpacaBrokerAdapter.fetchNewFills failure logging (#609)', () => {
  it('logs a per-source failure even when another source in the same sweep produced a fill', async () => {
    const client = makeClient({
      getOrder: vi
        .fn()
        .mockResolvedValueOnce(
          acceptedOrder({
            id: 'alpaca-healthy',
            status: 'filled',
            filled_qty: '50',
            filled_avg_price: '100.02',
            filled_at: '2026-07-15T15:00:00Z',
          }),
        )
        .mockResolvedValueOnce(
          acceptedOrder({
            id: 'alpaca-broken',
            status: 'filled',
            filled_qty: 'N/A',
            filled_avg_price: '100.02',
            filled_at: '2026-07-15T15:00:00Z',
          }),
        ),
    });
    const logger = recordingLogger();
    const clock = new FixedClock(new Date('2026-07-15T14:00:00Z'));
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket({ client_order_id: 'healthy-lot' }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'broken-lot' }));

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(1);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'error',
      message: 'Alpaca fetchNewFills: per-source failure',
      payload: {
        error: expect.stringMatching(/unparseable filled_qty 'N\/A'/),
        fills_read: 1,
        bracket_failures: 1,
      },
    });
  });

  it('logs nothing on a clean sweep with no failures', async () => {
    const logger = recordingLogger();
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: '2026-07-15T14:05:00Z',
        }),
      ),
    });
    const clock = new FixedClock(new Date('2026-07-15T14:00:00Z'));
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(1);
    expect(logger.entries).toEqual([]);
  });

  it('logs nothing for an unpriced fill with a working journal (#524, not a #609 failure)', async () => {
    const logger = recordingLogger();
    const client = makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) });
    const clock = new FixedClock(new Date('2026-07-15T14:00:00Z'));
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(0);
    expect(logger.entries).toEqual([]);
  });
});

describe('AlpacaBrokerAdapter since-floor invariant audit (#1123)', () => {
  const T0 = new Date('2026-07-20T16:00:00Z');

  it('warns when a fill is dated before its own bracket was submitted', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: '2026-07-20T15:59:00Z',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(1);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'alpaca_fill_predates_bracket_submission',
        payload: expect.objectContaining({
          client_order_id: 'key-aapl-1355',
          leg: 'entry',
          filled_at: '2026-07-20T15:59:00.000Z',
          submitted_at: T0.toISOString(),
        }),
      }),
    ]);
  });

  it('warns only on first sighting of a genuine violation, not every sweep', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: '2026-07-20T15:59:00Z',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    await adapter.fetchNewFills(new Date(0));
    await adapter.fetchNewFills(new Date(0));
    await adapter.fetchNewFills(new Date(0));

    expect(logger.entries).toHaveLength(1);
  });

  it('warns on BOTH the entry leg and a re-armed leg of the same lot, each once, when both violate', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const submitOcoOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-venue-id', legs: [] });
    const getOrderByClientOrderId = vi.fn().mockResolvedValue(null);
    const violatingFill = {
      status: 'filled' as const,
      filled_qty: '100',
      filled_avg_price: '100.02',
      filled_at: '2026-07-20T15:59:00Z',
      legs: [],
    };
    const getOrder = vi.fn(async (id: string) => {
      if (id === 'rearm-venue-id') {
        return acceptedOrder({ id: 'rearm-venue-id', ...violatingFill });
      }
      return acceptedOrder({ id: 'alpaca-entry-1', ...violatingFill });
    });
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient({ submitOcoOrder, getOrderByClientOrderId, getOrder }),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());
    await adapter.rearmProtectiveLegs('key-aapl-1355', 'AAPL', 'buy', 100, 90, 115);

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(2);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'alpaca_fill_predates_bracket_submission',
        payload: expect.objectContaining({
          client_order_id: 'key-aapl-1355',
          leg: 'entry',
          filled_at: '2026-07-20T15:59:00.000Z',
          submitted_at: T0.toISOString(),
        }),
      }),
      expect.objectContaining({
        level: 'warn',
        event: 'alpaca_fill_predates_bracket_submission',
        payload: expect.objectContaining({
          client_order_id: 'key-aapl-1355',
          leg: 'target',
          filled_at: '2026-07-20T15:59:00.000Z',
          submitted_at: T0.toISOString(),
        }),
      }),
    ]);
  });

  it('stays quiet for a fill dated after its bracket was submitted', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: '2026-07-20T16:00:01Z',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    await adapter.fetchNewFills(new Date(0));

    expect(logger.entries).toEqual([]);
  });

  it('stays quiet for a re-polled, already-closed bracket even once the global since floor has moved past its fill', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: '2026-07-20T16:00:01Z',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());
    await adapter.fetchNewFills(new Date(0));

    const laterSince = new Date('2026-07-20T18:00:00Z');
    await adapter.fetchNewFills(laterSince);

    expect(logger.entries).toEqual([]);
  });

  it('does not audit a bracket restored after a restart, which has no local submission-time proxy', async () => {
    const clock = new FixedClock(T0);
    const state = new InMemoryBrokerStateStore();
    const firstProcessAdapter = new AlpacaBrokerAdapter({
      client: makeClient(),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      clock,
      state,
    });
    await firstProcessAdapter.submitBracket(makeBracket());

    const logger = recordingLogger();
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          filled_at: '2026-07-20T15:00:00Z',
        }),
      ),
    });
    const recoveredAdapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
      state,
    });

    await recoveredAdapter.fetchNewFills(new Date(0));

    expect(logger.entries).toEqual([]);
  });
});

describe('AlpacaBrokerAdapter flatten sweep since-floor invariant audit (#1415)', () => {
  const T0 = new Date('2026-07-20T16:00:00Z');

  it('warns when a flatten fill is dated before its own submission', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const client = makeClient({
      submitMarketOrder: vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' }),
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          id: 'flatten-1',
          status: 'filled',
          filled_qty: '12',
          filled_avg_price: '99.50',
          filled_at: '2026-07-20T15:59:00Z',
          legs: [],
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(1);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'alpaca_fill_predates_bracket_submission',
        payload: expect.objectContaining({
          client_order_id: 'flatten-key',
          leg: 'exit',
          filled_at: '2026-07-20T15:59:00.000Z',
          submitted_at: T0.toISOString(),
        }),
      }),
    ]);
  });

  it('warns only on first sighting of a genuine violation, not every sweep', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const client = makeClient({
      submitMarketOrder: vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' }),
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          id: 'flatten-1',
          status: 'accepted',
          filled_qty: '12',
          filled_avg_price: '99.50',
          filled_at: '2026-07-20T15:59:00Z',
          legs: [],
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');

    await adapter.fetchNewFills(new Date(0));
    await adapter.fetchNewFills(new Date(0));
    await adapter.fetchNewFills(new Date(0));

    expect(logger.entries).toHaveLength(1);
  });

  it('stays quiet for a fill dated after its flatten was submitted', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const client = makeClient({
      submitMarketOrder: vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' }),
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          id: 'flatten-1',
          status: 'filled',
          filled_qty: '12',
          filled_avg_price: '99.50',
          filled_at: '2026-07-20T16:00:01Z',
          legs: [],
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });
    await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');

    await adapter.fetchNewFills(new Date(0));

    expect(logger.entries).toEqual([]);
  });

  it('does not audit a flatten resumed after a restart, which has no local submission-time proxy', async () => {
    const clock = new FixedClock(T0);
    const violatingOrder = acceptedOrder({
      id: 'flatten-1',
      status: 'filled',
      filled_qty: '12',
      filled_avg_price: '99.50',
      filled_at: '2026-07-20T15:00:00Z',
      legs: [],
    });
    const logger = recordingLogger();
    const client = makeClient({
      getOrderByClientOrderId: vi.fn().mockResolvedValue(violatingOrder),
      getOrder: vi.fn().mockResolvedValue(violatingOrder),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger,
      clock,
    });

    await adapter.resumeFlatten('flatten-key', 'AAPL');
    await adapter.fetchNewFills(new Date(0));

    expect(logger.entries).toEqual([]);
  });
});

describe('AlpacaBrokerAdapter unpriced-fill age-out', () => {
  const T0 = new Date('2026-07-15T14:06:00Z');

  async function submitAndSweep(options: {
    clock: FixedClock;
    alerts: UnpricedFillAlertChannel;
    client: AlpacaBrokerClient;
    state?: InMemoryBrokerStateStore;
    ageOutMs?: number;
  }): Promise<AlpacaBrokerAdapter> {
    const adapter = new AlpacaBrokerAdapter({
      client: options.client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: options.alerts,
      logger: recordingLogger(),
      clock: options.clock,
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.ageOutMs === undefined ? {} : { unpricedFillAgeOutMs: options.ageOutMs }),
    });
    await adapter.submitBracket(makeBracket());
    return adapter;
  }

  it('stays quiet while the venue is only briefly behind', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const adapter = await submitAndSweep({
      clock,
      alerts,
      client: makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) }),
    });

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS - 1);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted).toEqual([]);
  });

  it('escalates once past the threshold, with the context an operator can act on', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const adapter = await submitAndSweep({
      clock,
      alerts,
      client: makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) }),
    });

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    expect(alerts.posted).toEqual([]);

    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted).toEqual([
      {
        venue: 'alpaca',
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'alpaca-entry-1',
        leg: 'entry',
        instrument: 'AAPL',
        qty: 100,
        first_seen_at: T0,
        unpriced_for_ms: DEFAULT_UNPRICED_FILL_AGE_OUT_MS,
        age_out_ms: DEFAULT_UNPRICED_FILL_AGE_OUT_MS,
      },
    ]);

    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS * 4);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    expect(alerts.posted).toHaveLength(1);
  });

  it('names the bracket parent symbol for an unpriced protective leg', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const adapter = await submitAndSweep({
      clock,
      alerts,
      client: makeClient({
        getOrder: vi.fn().mockResolvedValue(
          acceptedOrder({
            symbol: 'TSLA',
            status: 'filled',
            filled_qty: '100',
            filled_avg_price: '100.02',
            filled_at: '2026-07-15T14:05:00Z',
            legs: [
              {
                id: 'alpaca-stop-1',
                type: 'stop',
                status: 'filled',
                filled_qty: '100',
                filled_avg_price: null,
                filled_at: '2026-07-15T15:00:00Z',
              },
            ],
          }),
        ),
      }),
    });

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted[0]).toMatchObject({
      instrument: 'TSLA',
      leg: 'stop',
      broker_fill_id: 'alpaca-stop-1',
    });
  });

  it('escalates even on a sweep that other brackets are filling normally', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const client = makeClient({
      getOrder: vi
        .fn()
        .mockResolvedValueOnce(unpricedOrder({ id: 'alpaca-stuck' }))
        .mockResolvedValueOnce(
          acceptedOrder({
            id: 'alpaca-healthy',
            status: 'filled',
            filled_qty: '50',
            filled_avg_price: '100.02',
            filled_at: '2026-07-15T14:05:00Z',
          }),
        ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: alerts,
      logger: recordingLogger(),
      clock,
    });
    await adapter.submitBracket(makeBracket({ client_order_id: 'stuck-lot' }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'healthy-lot' }));

    await adapter.fetchNewFills(new Date(0));

    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    (client.getOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(unpricedOrder({ id: 'alpaca-stuck' }))
      .mockResolvedValueOnce(
        acceptedOrder({
          id: 'alpaca-healthy',
          status: 'filled',
          filled_qty: '50',
          filled_avg_price: '100.02',
          filled_at: '2026-07-15T14:05:00Z',
        }),
      );
    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(1);
    expect(alerts.posted).toMatchObject([{ client_order_id: 'stuck-lot', qty: 100 }]);
  });

  it('forgets a fill the venue eventually prices, rather than alerting on it later', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const client = makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) });
    const adapter = await submitAndSweep({ clock, alerts, client });

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    (client.getOrder as ReturnType<typeof vi.fn>).mockResolvedValue(
      acceptedOrder({
        status: 'filled',
        filled_qty: '100',
        filled_avg_price: '100.02',
        filled_at: '2026-07-15T14:05:00Z',
      }),
    );
    clock.advance(1_000);
    const fills = await adapter.fetchNewFills(new Date(0));
    expect(fills).toHaveLength(1);

    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS * 2);
    await adapter.fetchNewFills(new Date(0));

    expect(alerts.posted).toEqual([]);
  });

  it('retries delivery instead of recording an alert nobody received', async () => {
    const clock = new FixedClock(T0);
    const state = new InMemoryBrokerStateStore();
    const failing: UnpricedFillAlertChannel = {
      postUnpricedFillAlert: async () => {
        throw new Error('POST https://api.telegram.org/bot<token>/sendMessage failed: 503');
      },
    };
    const adapter = await submitAndSweep({
      clock,
      alerts: failing,
      state,
      client: makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) }),
    });

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(state.loadUnpricedFills('alpaca')[0]?.alerted_at).toBeNull();

    const alerts = recordingAlerts();
    const recovered = new AlpacaBrokerAdapter({
      client: makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) }),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: alerts,
      logger: recordingLogger(),
      state,
      clock,
    });

    await recovered.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted).toHaveLength(1);
    expect(state.loadUnpricedFills('alpaca')[0]?.alerted_at).toEqual(clock.now());
  });

  it('survives a journal write failure rather than starving the whole sweep', async () => {
    const clock = new FixedClock(T0);
    const state = new InMemoryBrokerStateStore();
    vi.spyOn(state, 'recordUnpricedFill').mockImplementation(() => {
      throw new Error('simulated journal failure');
    });
    const client = makeClient({
      getOrder: vi
        .fn()
        .mockResolvedValueOnce(unpricedOrder({ id: 'alpaca-stuck' }))
        .mockResolvedValueOnce(
          acceptedOrder({
            id: 'alpaca-healthy',
            status: 'filled',
            filled_qty: '50',
            filled_avg_price: '100.02',
            filled_at: '2026-07-15T14:05:00Z',
          }),
        ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      state,
      clock,
    });
    await adapter.submitBracket(makeBracket({ client_order_id: 'stuck-lot' }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'healthy-lot' }));

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toMatchObject([{ client_order_id: 'healthy-lot', qty: 50 }]);
  });

  it('does not leak the alert channel error text into the sweep failure', async () => {
    const clock = new FixedClock(T0);
    const secret = 'bot123456:SUPER-SECRET-TOKEN';
    const adapter = await submitAndSweep({
      clock,
      alerts: {
        postUnpricedFillAlert: async () => {
          throw new Error(`POST https://api.telegram.org/${secret}/sendMessage failed`);
        },
      },
      client: makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) }),
    });

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    const error = (await adapter
      .fetchNewFills(new Date(0))
      .catch((caught: unknown) => caught)) as AggregateError;

    const reported = error.errors.map((each: Error) => each.message).join('\n');
    expect(reported).not.toContain(secret);
    expect(reported).toContain('alert delivery failed for order alpaca-entry-1');
  });

  it('does not fail the sweep when the only new activity is an unpriced flatten fill', async () => {
    const submitMarketOrder = vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' });
    const client = makeClient({
      submitMarketOrder,
      getOrder: vi.fn().mockResolvedValue(unpricedOrder({ id: 'flatten-1' })),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');

    await expect(adapter.fetchNewFills(new Date(0))).resolves.toEqual([]);
  });

  it('still collects a healthy bracket fill in the same poll as an unpriced flatten', async () => {
    const filledAt = '2026-07-15T14:05:00Z';
    const getOrder = vi.fn(async (orderId: string) =>
      orderId === 'alpaca-entry-1'
        ? acceptedOrder({
            status: 'filled',
            filled_qty: '100',
            filled_avg_price: '100.02',
            filled_at: filledAt,
            legs: [],
          })
        : unpricedOrder({ id: 'flatten-stuck' }),
    );
    const submitMarketOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-stuck' });
    const client = makeClient({ getOrder, submitMarketOrder });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());
    await adapter.submitFlatten('TSLA', 'sell', 5, 'flatten-key');

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toEqual([
      {
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'alpaca-entry-1',
        leg: 'entry',
        price: 100.02,
        qty: 100,
        fee: 0,
        timestamp: new Date(filledAt),
        qty_is_cumulative: true,
      },
    ]);
  });
});

describe('AlpacaBrokerAdapter — intervention path (#429)', () => {
  function adapterWith(client: AlpacaBrokerClient): AlpacaBrokerAdapter {
    return new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
  }

  it('flattens with a plain MARKET order, never a bracket', async () => {
    const submitMarketOrder = vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' });
    const submitOrder = vi.fn();
    const adapter = adapterWith(makeClient({ submitMarketOrder, submitOrder }));

    const ack = await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');

    expect(submitOrder).not.toHaveBeenCalled();
    expect(submitMarketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      side: 'sell',
      qty: '12',
      time_in_force: 'ioc',
      client_order_id: 'flatten-key',
    });
    expect(ack.client_order_id).toBe('flatten-key');
    expect(ack.broker_order_ids).toEqual(['flatten-1']);
  });

  it('sweeps a submitted flatten and reports its fill tagged as an exit, not an entry', async () => {
    const submitMarketOrder = vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' });
    const filledAt = '2026-07-15T15:10:00Z';
    const getOrder = vi.fn().mockResolvedValue(
      acceptedOrder({
        id: 'flatten-1',
        status: 'filled',
        filled_qty: '12',
        filled_avg_price: '99.50',
        filled_at: filledAt,
        legs: [],
      }),
    );
    const adapter = adapterWith(makeClient({ submitMarketOrder, getOrder }));
    await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toEqual([
      {
        client_order_id: 'flatten-key',
        broker_fill_id: 'flatten-1',
        leg: 'exit',
        price: 99.5,
        qty: 12,
        fee: 0,
        timestamp: new Date(filledAt),
        qty_is_cumulative: true,
      },
    ]);
  });

  it('does not poll a flatten twice under the same order — resubmitting under the same client order id is a venue no-op', async () => {
    const submitMarketOrder = vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' });
    const getOrder = vi
      .fn()
      .mockResolvedValue(acceptedOrder({ id: 'flatten-1', status: 'accepted' }));
    const adapter = adapterWith(makeClient({ submitMarketOrder, getOrder }));

    await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');
    await adapter.submitFlatten('AAPL', 'sell', 12, 'flatten-key');
    await adapter.fetchNewFills(new Date(0));

    expect(getOrder).toHaveBeenCalledTimes(1);
  });

  it('cancels the order the venue holds under our client order id', async () => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const adapter = adapterWith(
      makeClient({
        getOrderByClientOrderId: vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'venue-77' }),
        cancelOrder,
      }),
    );

    await adapter.cancel('key-1', 'AAPL');

    expect(cancelOrder).toHaveBeenCalledWith('venue-77');
  });

  it('resolves quietly when the venue has no such order', async () => {
    const cancelOrder = vi.fn();
    const adapter = adapterWith(
      makeClient({
        getOrderByClientOrderId: vi.fn().mockResolvedValue(null),
        cancelOrder,
      }),
    );

    await expect(adapter.cancel('key-gone', 'AAPL')).resolves.toBeUndefined();
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  describe('cancel() when the by-client-order-id lookup is the thing that is broken (#1500)', () => {
    it('reaches the order through the open-order list and cancels it', async () => {
      const getOrderByClientOrderId = vi
        .fn()
        .mockRejectedValue(new Error('order-details endpoint 503'));
      const listOpenOrders = vi.fn().mockResolvedValue([
        { ...acceptedOrder(), id: 'venue-77', client_order_id: 'key-1' },
        { ...acceptedOrder(), id: 'someone-elses', client_order_id: 'key-2' },
      ]);
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(
        makeClient({ getOrderByClientOrderId, listOpenOrders, cancelOrder }),
      );

      await expect(adapter.cancel('key-1', 'AAPL')).resolves.toBeUndefined();

      expect(cancelOrder).toHaveBeenCalledTimes(1);
      expect(cancelOrder).toHaveBeenCalledWith('venue-77');
    });

    it('takes the lot re-arm from the SAME snapshot rather than a second failing lookup', async () => {
      const listOpenOrders = vi.fn().mockResolvedValue([
        { ...acceptedOrder(), id: 'bracket-venue-id', client_order_id: 'key-1' },
        { ...acceptedOrder(), id: 'rearm-venue-id', client_order_id: 'key-1:rearm' },
      ]);
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: vi.fn().mockRejectedValue(new Error('order-details 503')),
          listOpenOrders,
          cancelOrder,
        }),
      );

      await adapter.cancel('key-1', 'AAPL');

      expect(listOpenOrders).toHaveBeenCalledTimes(1);
      expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual([
        'rearm-venue-id',
        'bracket-venue-id',
      ]);
    });

    it('resolves without cancelling when the order is no longer open — a filled flatten is not in the list', async () => {
      const cancelOrder = vi.fn();
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: vi.fn().mockRejectedValue(new Error('order-details 503')),
          listOpenOrders: vi.fn().mockResolvedValue([]),
          cancelOrder,
        }),
      );

      await expect(adapter.cancel('key-1', 'AAPL')).resolves.toBeUndefined();
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('keeps the id the direct lookup DID answer with when only the :rearm lookup breaks', async () => {
      const getOrderByClientOrderId = vi.fn(async (clientOrderId: string) => {
        if (clientOrderId === 'key-1') return { ...acceptedOrder(), id: 'bracket-venue-id' };
        throw new Error('order-details 503 on the :rearm key');
      });
      const listOpenOrders = vi
        .fn()
        .mockResolvedValue([
          { ...acceptedOrder(), id: 'rearm-venue-id', client_order_id: 'key-1:rearm' },
        ]);
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(
        makeClient({ getOrderByClientOrderId, listOpenOrders, cancelOrder }),
      );

      await adapter.cancel('key-1', 'AAPL');

      expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual([
        'rearm-venue-id',
        'bracket-venue-id',
      ]);
    });

    it('keeps an IN-PROCESS re-arm id even when the direct lookup breaks — it needs no venue', async () => {
      let directFails = false;
      const getOrderByClientOrderId = vi.fn(async (clientOrderId: string) => {
        if (directFails) throw new Error('order-details 503');
        if (clientOrderId === 'key-1') return { ...acceptedOrder(), id: 'bracket-venue-id' };
        return {
          ...acceptedOrder(),
          id: 'rearm-venue-id',
          order_class: 'oco' as const,
          qty: '6',
          limit_price: '110',
          legs: [
            {
              id: 'rearm-stop-leg',
              type: 'stop' as const,
              status: 'held',
              filled_qty: '0',
              filled_avg_price: null,
              filled_at: null,
              stop_price: '95',
            },
          ],
        };
      });
      const listOpenOrders = vi
        .fn()
        .mockResolvedValue([
          { ...acceptedOrder(), id: 'bracket-venue-id', client_order_id: 'key-1' },
        ]);
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(
        makeClient({ getOrderByClientOrderId, listOpenOrders, cancelOrder }),
      );
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      cancelOrder.mockClear();
      directFails = true;

      await adapter.cancel('key-1', 'AAPL');

      expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual([
        'rearm-venue-id',
        'bracket-venue-id',
      ]);
      expect(listOpenOrders).toHaveBeenCalledTimes(1);
    });

    it('still refuses, naming the original cause, when the venue is unreachable on BOTH endpoints', async () => {
      const cancelOrder = vi.fn();
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('order-details 503'), { status: 503 })),
          listOpenOrders: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('list endpoint 502'), { status: 502 })),
          cancelOrder,
        }),
      );

      await expect(adapter.cancel('key-1', 'AAPL')).rejects.toMatchObject({ statusCode: 503 });
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('does not reach for the list at all while the direct lookup answers', async () => {
      const listOpenOrders = vi.fn();
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: vi.fn(async (clientOrderId: string) =>
            clientOrderId === 'key-1' ? { ...acceptedOrder(), id: 'venue-77' } : null,
          ),
          listOpenOrders,
          cancelOrder: vi.fn().mockResolvedValue(undefined),
        }),
      );

      await adapter.cancel('key-1', 'AAPL');

      expect(listOpenOrders).not.toHaveBeenCalled();
    });
  });

  it("adopts a resting prior whose venue prices are the ROUNDED form of the caller's (#983)", async () => {
    const prior: AlpacaOrder = {
      ...acceptedOrder(),
      id: 'rearm-venue-id',
      client_order_id: 'key-1:rearm',
      order_class: 'oco',
      qty: '6',
      limit_price: '754.19',
      legs: [
        {
          id: 'rearm-stop-leg',
          type: 'stop' as const,
          status: 'held',
          filled_qty: '0',
          filled_avg_price: null,
          filled_at: null,
          stop_price: '766.40',
        },
      ],
    };
    const getOrderByClientOrderId = vi.fn(
      async (clientOrderId: string): Promise<AlpacaOrder | null> =>
        clientOrderId === 'key-1:rearm' ? prior : null,
    );
    const cancelOrder = vi.fn();
    const submitOcoOrder = vi.fn();
    const adapter = adapterWith(
      makeClient({ getOrderByClientOrderId, cancelOrder, submitOcoOrder }),
    );

    await adapter.rearmProtectiveLegs('key-1', 'SPY', 'sell', 6, 766.40805334, 754.18889332);

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(submitOcoOrder).not.toHaveBeenCalled();
  });

  it('rounds the legs it does place (#983)', async () => {
    const getOrderByClientOrderId = vi.fn(async () => null);
    const submitOcoOrder = vi.fn().mockResolvedValue({
      ...acceptedOrder(),
      id: 'rearm-venue-id',
      order_class: 'oco' as const,
      legs: [],
    });
    const adapter = adapterWith(makeClient({ getOrderByClientOrderId, submitOcoOrder }));

    await adapter.rearmProtectiveLegs('key-1', 'SPY', 'sell', 6, 766.40805334, 754.18889332);

    expect(submitOcoOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        take_profit: { limit_price: '754.19' },
        stop_loss: { stop_price: '766.40' },
      }),
    );
  });

  describe('cancel() also clears a re-armed residual (#525 follow-up)', () => {
    function byClientOrderId(
      orders: Record<string, ReturnType<typeof acceptedOrder> | null>,
    ): (clientOrderId: string) => Promise<ReturnType<typeof acceptedOrder> | null> {
      return async (clientOrderId: string) => orders[clientOrderId] ?? null;
    }

    it('cancels BOTH the original bracket and the re-armed OCO, RE-ARM first (#867)', async () => {
      const sequence: string[] = [];
      const getOrderByClientOrderId = vi.fn(
        byClientOrderId({
          'key-1': { ...acceptedOrder(), id: 'bracket-venue-id' },
          'key-1:rearm': {
            ...acceptedOrder(),
            id: 'rearm-venue-id',
            order_class: 'oco',
            qty: '6',
            limit_price: '110',
            legs: [
              {
                id: 'rearm-stop-leg',
                type: 'stop' as const,
                status: 'held',
                filled_qty: '0',
                filled_avg_price: null,
                filled_at: null,
                stop_price: '95',
              },
            ],
          },
        }),
      );
      const cancelOrder = vi.fn(async (id: string) => {
        sequence.push(id);
      });
      const submitOcoOrder = vi.fn().mockResolvedValue({
        ...acceptedOrder(),
        id: 'rearm-venue-id',
        order_class: 'oco',
        legs: [],
      });
      const adapter = adapterWith(
        makeClient({ getOrderByClientOrderId, cancelOrder, submitOcoOrder }),
      );
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      cancelOrder.mockClear();

      await adapter.cancel('key-1', 'AAPL');

      expect(sequence).toEqual(['rearm-venue-id', 'bracket-venue-id']);
    });

    it('finds and cancels a re-armed OCO placed before a restart, when rearmedLegs is empty', async () => {
      const getOrderByClientOrderId = vi.fn(
        byClientOrderId({
          'key-1': { ...acceptedOrder(), id: 'bracket-venue-id' },
          'key-1:rearm': { ...acceptedOrder(), id: 'rearm-venue-id' },
        }),
      );
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(makeClient({ getOrderByClientOrderId, cancelOrder }));

      await adapter.cancel('key-1', 'AAPL');

      expect(cancelOrder).toHaveBeenCalledWith('bracket-venue-id');
      expect(cancelOrder).toHaveBeenCalledWith('rearm-venue-id');
      expect(cancelOrder).toHaveBeenCalledTimes(2);
    });

    it('makes no extra cancel call on the ordinary path — no re-arm ever happened', async () => {
      const getOrderByClientOrderId = vi.fn(
        byClientOrderId({
          'key-1': { ...acceptedOrder(), id: 'bracket-venue-id' },
        }),
      );
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(makeClient({ getOrderByClientOrderId, cancelOrder }));

      await adapter.cancel('key-1', 'AAPL');

      expect(cancelOrder).toHaveBeenCalledTimes(1);
      expect(cancelOrder).toHaveBeenCalledWith('bracket-venue-id');
    });

    it('refuses (throws) when cancelling the re-armed OCO fails, matching the existing cancel-failure posture', async () => {
      const getOrderByClientOrderId = vi.fn(
        byClientOrderId({
          'key-1': { ...acceptedOrder(), id: 'bracket-venue-id' },
          'key-1:rearm': { ...acceptedOrder(), id: 'rearm-venue-id' },
        }),
      );
      const cancelOrder = vi.fn(async (id: string) => {
        if (id === 'rearm-venue-id') throw new Error('venue rejected the cancel');
      });
      const adapter = adapterWith(makeClient({ getOrderByClientOrderId, cancelOrder }));

      await expect(adapter.cancel('key-1', 'AAPL')).rejects.toThrow();

      expect(cancelOrder).not.toHaveBeenCalledWith('bracket-venue-id');
      expect(cancelOrder).toHaveBeenCalledTimes(1);
    });

    it('does not touch the venue when the :rearm lookup fails — protection stays intact (#867)', async () => {
      const getOrderByClientOrderId = vi.fn(async (clientOrderId: string) => {
        if (clientOrderId === 'key-1:rearm') throw new Error('venue unavailable');
        return { ...acceptedOrder(), id: 'bracket-venue-id' };
      });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(makeClient({ getOrderByClientOrderId, cancelOrder }));

      await expect(adapter.cancel('key-1', 'AAPL')).rejects.toThrow();

      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('does not touch the venue when the BRACKET lookup fails either (#867)', async () => {
      const getOrderByClientOrderId = vi.fn(async (clientOrderId: string) => {
        if (clientOrderId === 'key-1') throw new Error('venue unavailable');
        return { ...acceptedOrder(), id: 'rearm-venue-id' };
      });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(makeClient({ getOrderByClientOrderId, cancelOrder }));

      await expect(adapter.cancel('key-1', 'AAPL')).rejects.toThrow();

      expect(cancelOrder).not.toHaveBeenCalled();
    });
  });

  it("re-arms with an entry-less OCO order under a FRESH client order id, never the lot's own", async () => {
    const submitOcoOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-1', order_class: 'oco', legs: [] });
    const getOrderByClientOrderId = vi.fn().mockResolvedValue(null);
    const adapter = adapterWith(makeClient({ submitOcoOrder, getOrderByClientOrderId }));

    await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

    expect(submitOcoOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      side: 'sell',
      qty: '6',
      time_in_force: 'gtc',
      client_order_id: 'key-1:rearm',
      order_class: 'oco',
      take_profit: { limit_price: '110.00' },
      stop_loss: { stop_price: '95.00' },
    });
  });

  describe('re-arm adopt-or-place (#549)', () => {
    function venueHolding(rows: Record<string, AlpacaOrder>) {
      return vi.fn(async (clientOrderId: string): Promise<AlpacaOrder | null> => {
        return rows[clientOrderId] ?? null;
      });
    }

    function matchingPriorOco() {
      return {
        ...acceptedOrder(),
        id: 'prior-rearm-oco',
        client_order_id: 'key-1:rearm',
        order_class: 'oco',
        qty: '6',
        limit_price: '110',
        legs: [
          {
            id: 'prior-rearm-stop',
            type: 'stop' as const,
            status: 'held',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
            stop_price: '95',
          },
        ],
      };
    }

    it('adopts a live prior OCO that MATCHES the request instead of submitting again', async () => {
      const submitOcoOrder = vi.fn();
      const cancelOrder = vi.fn();
      const getOrderByClientOrderId = venueHolding({ 'key-1:rearm': matchingPriorOco() });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(getOrderByClientOrderId).toHaveBeenCalledWith('key-1:rearm');
      expect(submitOcoOrder).not.toHaveBeenCalled();
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('cancels and replaces a live prior whose qty no longer matches the residual', async () => {
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-2', order_class: 'oco', legs: [] });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const getOrderByClientOrderId = venueHolding({
        'key-1:rearm': { ...matchingPriorOco(), qty: '9' },
      });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(cancelOrder).toHaveBeenCalledWith('prior-rearm-oco');
      expect(submitOcoOrder).toHaveBeenCalledTimes(1);
      expect(submitOcoOrder).toHaveBeenCalledWith(expect.objectContaining({ qty: '6' }));
    });

    it('refuses to adopt a prior whose price fields are missing — unverifiable protection is replaced', async () => {
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-2', order_class: 'oco', legs: [] });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const prior: AlpacaOrder = matchingPriorOco();
      delete prior.limit_price;
      const getOrderByClientOrderId = venueHolding({ 'key-1:rearm': prior });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(cancelOrder).toHaveBeenCalledWith('prior-rearm-oco');
      expect(submitOcoOrder).toHaveBeenCalledTimes(1);
    });

    it('adopts a PARTIALLY_FILLED prior without cancel-and-replace, even when the store-side residual disagrees', async () => {
      const submitOcoOrder = vi.fn();
      const cancelOrder = vi.fn();
      const getOrderByClientOrderId = venueHolding({
        'key-1:rearm': {
          ...matchingPriorOco(),
          status: 'partially_filled',
          filled_qty: '2',
        },
      });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(submitOcoOrder).not.toHaveBeenCalled();
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('does not adopt a matching prior in an unrecognized status (done_for_day) — cancels and replaces', async () => {
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-2', order_class: 'oco', legs: [] });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const getOrderByClientOrderId = venueHolding({
        'key-1:rearm': { ...matchingPriorOco(), status: 'done_for_day' },
      });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(cancelOrder).toHaveBeenCalledWith('prior-rearm-oco');
      expect(submitOcoOrder).toHaveBeenCalledTimes(1);
      expect(submitOcoOrder).toHaveBeenCalledWith(expect.objectContaining({ qty: '6' }));
    });

    it('adopts a FILLED prior regardless of size — its fill is already closing the residual', async () => {
      const submitOcoOrder = vi.fn();
      const cancelOrder = vi.fn();
      const getOrderByClientOrderId = venueHolding({
        'key-1:rearm': { ...matchingPriorOco(), qty: '9', status: 'filled', filled_qty: '9' },
      });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(submitOcoOrder).not.toHaveBeenCalled();
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('places afresh when the prior attempt under the wire id is dead (cancelled)', async () => {
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-2', order_class: 'oco', legs: [] });
      const getOrderByClientOrderId = venueHolding({
        'key-1:rearm': {
          ...acceptedOrder(),
          id: 'prior-rearm-oco',
          client_order_id: 'key-1:rearm',
          order_class: 'oco',
          status: 'canceled',
          legs: [],
        },
      });
      const adapter = adapterWith(makeClient({ submitOcoOrder, getOrderByClientOrderId }));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(submitOcoOrder).toHaveBeenCalledTimes(1);
      expect(submitOcoOrder).toHaveBeenCalledWith(
        expect.objectContaining({ client_order_id: 'key-1:rearm-1' }),
      );
    });
  });

  describe('re-arm wire ids are consumed permanently (#1346)', () => {
    function measuredAlpacaVenue() {
      const rows = new Map<string, AlpacaOrder>();
      let placed = 0;

      const submitOcoOrder = vi.fn(async (request: AlpacaOcoOrderRequest): Promise<AlpacaOrder> => {
        if (rows.has(request.client_order_id)) {
          throw new AlpacaBrokerProviderError(
            'Alpaca rejected POST /v2/orders: 422 {"code":40010001,"message":"client_order_id must be unique"}',
            422,
            '40010001',
            'client_order_id must be unique',
            'POST',
          );
        }
        placed += 1;
        const row: AlpacaOrder = {
          ...acceptedOrder(),
          id: `oco-${placed}`,
          client_order_id: request.client_order_id,
          order_class: 'oco',
          qty: request.qty,
          limit_price: request.take_profit.limit_price,
          legs: [
            {
              id: `oco-${placed}-stop`,
              type: 'stop',
              status: 'held',
              filled_qty: '0',
              filled_avg_price: null,
              filled_at: null,
              stop_price: request.stop_loss.stop_price,
            },
          ],
        };
        rows.set(row.client_order_id, row);
        return row;
      });

      const getOrderByClientOrderId = vi.fn(
        async (clientOrderId: string): Promise<AlpacaOrder | null> =>
          rows.get(clientOrderId) ?? null,
      );

      const cancelOrder = vi.fn(async (alpacaOrderId: string): Promise<void> => {
        for (const [key, row] of rows) {
          if (row.id === alpacaOrderId) rows.set(key, { ...row, status: 'canceled' });
        }
      });

      const WORKING = [
        'new',
        'accepted',
        'pending_new',
        'accepted_for_bidding',
        'partially_filled',
      ];
      const resting = (): AlpacaOrder[] =>
        [...rows.values()].filter((row) => WORKING.includes(row.status));

      return { submitOcoOrder, getOrderByClientOrderId, cancelOrder, resting, rows };
    }

    function patchRow(
      venue: ReturnType<typeof measuredAlpacaVenue>,
      key: string,
      patch: Partial<AlpacaOrder>,
    ): void {
      const prior = venue.rows.get(key);
      if (!prior) throw new Error(`patchRow: no row set for ${key} yet`);
      venue.rows.set(key, { ...prior, ...patch });
    }

    it('protects the SAME lot a second time after its first re-arm was cancelled', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm']);

      await venue.cancelOrder('oco-1');

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);

      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm-1']);
      expect(venue.resting().map((row) => row.qty)).toEqual(['4']);
    });

    it('never leaves two live OCOs on one lot across a cancel-and-replace', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);

      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm-1']);
      expect(venue.rows.get('key-1:rearm')?.status).toBe('canceled');
    });

    it('adopts the resting prior instead of advancing when nothing changed', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(venue.submitOcoOrder).toHaveBeenCalledTimes(1);
      expect(venue.cancelOrder).not.toHaveBeenCalled();
    });

    it('raises the PERMANENT-gap error once every wire id this lot may use is spent', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      for (let spent = 0; spent < 4; spent += 1) {
        await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
        await venue.cancelOrder(`oco-${spent + 1}`);
      }

      const thrown = await adapter
        .rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110)
        .then(() => null)
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/exhausted all 4 re-arm wire ids/);
      expect(isProtectiveRearmUnsupported(thrown)).toBe(true);
      expect(venue.submitOcoOrder).toHaveBeenCalledTimes(4);
    });

    it('cancel() retires the NEWEST re-arm, not the first id the lot ever used', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(
        makeClient({
          ...venue,
          getOrderByClientOrderId: vi.fn(async (clientOrderId: string) =>
            clientOrderId === 'key-1' ? null : (venue.rows.get(clientOrderId) ?? null),
          ),
        }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await venue.cancelOrder('oco-1');
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);

      const restarted = adapterWith(
        makeClient({
          ...venue,
          getOrderByClientOrderId: vi.fn(async (clientOrderId: string) =>
            clientOrderId === 'key-1' ? null : (venue.rows.get(clientOrderId) ?? null),
          ),
        }),
      );
      await restarted.cancel('key-1', 'AAPL');

      expect(venue.cancelOrder).toHaveBeenCalledWith('oco-2');
      expect(venue.resting()).toEqual([]);
    });

    it('does not downgrade to a FILLED early attempt while a later one still rests', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm-1']);

      patchRow(venue, 'key-1:rearm', { status: 'filled', filled_qty: '6' });

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);

      await adapter.cancel('key-1', 'AAPL');

      expect(venue.cancelOrder).toHaveBeenLastCalledWith('oco-2');
      expect(venue.resting()).toEqual([]);
    });

    it('still adopts a filled prior when every id above it is already dead', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
      patchRow(venue, 'key-1:rearm', { status: 'filled', filled_qty: '6' });
      patchRow(venue, 'key-1:rearm-1', { status: 'canceled' });
      venue.submitOcoOrder.mockClear();

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);

      expect(venue.submitOcoOrder).not.toHaveBeenCalled();
      expect(venue.rows.has('key-1:rearm-2')).toBe(false);
    });

    it('adopts a filled prior despite a defensive cancel at a LOWER index', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
      patchRow(venue, 'key-1:rearm', { status: 'pending_cancel' });
      patchRow(venue, 'key-1:rearm-1', { status: 'filled', filled_qty: '4' });
      venue.submitOcoOrder.mockClear();

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);

      expect(venue.submitOcoOrder).not.toHaveBeenCalled();
      expect(venue.rows.has('key-1:rearm-2')).toBe(false);
    });

    it('does not place a second leg over a PARTIALLY_FILLED prior whose remainder still works', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
      patchRow(venue, 'key-1:rearm', { status: 'partially_filled', filled_qty: '2' });
      venue.submitOcoOrder.mockClear();

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 3, 95, 110);

      expect(venue.submitOcoOrder).not.toHaveBeenCalled();
      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm']);
    });

    it('re-arms rather than adopting a full fill that a later attempt outgrew', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      patchRow(venue, 'key-1:rearm', { status: 'filled', filled_qty: '4' });
      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm-1']);
      venue.submitOcoOrder.mockClear();

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 2, 95, 110);

      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm-2']);
      expect(venue.resting().map((row) => row.qty)).toEqual(['2']);
    });

    it('re-arms over a full fill outgrown by an attempt this walk never touched', async () => {
      const venue = measuredAlpacaVenue();
      const adapter = adapterWith(makeClient(venue));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      patchRow(venue, 'key-1:rearm', { status: 'filled', filled_qty: '4' });
      patchRow(venue, 'key-1:rearm-1', { status: 'canceled' });
      venue.submitOcoOrder.mockClear();
      venue.cancelOrder.mockClear();

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 2, 95, 110);

      expect(venue.cancelOrder).not.toHaveBeenCalled();
      expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm-2']);
      expect(venue.resting().map((row) => row.qty)).toEqual(['2']);
    });

    const PRIOR_STATUS_SHAPES = [
      'resting-match',
      'resting-mismatch',
      'partially_filled',
      'filled',
      'filled-undersized',
      'canceled',
      'pending_cancel',
    ] as const;
    type PriorStatusShape = (typeof PRIOR_STATUS_SHAPES)[number];

    function buildPriorStatusSequences(maxDepth: number): PriorStatusShape[][] {
      let sequences: PriorStatusShape[][] = [[]];
      let frontier: PriorStatusShape[][] = [[]];
      for (let depth = 0; depth < maxDepth; depth += 1) {
        frontier = frontier.flatMap((prefix) =>
          PRIOR_STATUS_SHAPES.map((shape) => [...prefix, shape]),
        );
        sequences = [...sequences, ...frontier];
      }
      return sequences;
    }

    function observedResidualFloor(
      namedId: string | null | undefined,
      qty: number,
      sequenceLength: number,
      seededQty: Map<string, number>,
    ): number {
      let observed = qty;
      for (let above = 0; above < sequenceLength; above += 1) {
        const id = `seed-${above}`;
        const size = seededQty.get(id);
        if (id === namedId) observed = qty;
        else if (size !== undefined) observed = Math.max(observed, size);
      }
      return observed;
    }

    function nakedClearViolation(
      where: string,
      workingAtEntry: Set<string>,
      workingAtExit: AlpacaOrder[],
      venue: ReturnType<typeof measuredAlpacaVenue>,
      namedId: string | null | undefined,
      qty: number,
      sequenceLength: number,
      seededQty: Map<string, number>,
    ): string | null {
      const destroyed = [...workingAtEntry].some(
        (id) => !workingAtExit.some((row) => row.id === id),
      );
      if (!destroyed || workingAtExit.length !== 0) return null;

      const named = [...venue.rows.values()].find((row) => row.id === namedId);
      const observed = observedResidualFloor(namedId, qty, sequenceLength, seededQty);
      const covers = named?.status === 'filled' && Number(named.filled_qty) >= observed;
      if (covers) return null;

      return (
        `${where} destroyed working protection and left none; ` +
        `bookkeeping names ${String(namedId)} ` +
        `(${String(named?.status)} ${String(named?.filled_qty)}/${observed})`
      );
    }

    function misnamedBookkeepingViolation(
      where: string,
      workingAtExit: AlpacaOrder[],
      namedId: string | null | undefined,
    ): string | null {
      if (workingAtExit.length !== 1) return null;
      if (namedId === workingAtExit[0]?.id) return null;
      return `${where} bookkeeping names ${String(namedId)}, working leg is ${workingAtExit[0]?.id}`;
    }

    async function runPriorStatusSequenceCase(
      qty: number,
      sequence: PriorStatusShape[],
      seed: (attempt: number, shape: PriorStatusShape) => AlpacaOrder,
    ): Promise<string[]> {
      const where = `[${sequence.join(', ')}] @ qty ${qty}`;
      const violations: string[] = [];

      const venue = measuredAlpacaVenue();
      const seededQty = new Map<string, number>();
      sequence.forEach((shape, attempt) => {
        const row = seed(attempt, shape);
        venue.rows.set(row.client_order_id, row);
        seededQty.set(row.id, Number(row.qty));
      });
      const state = new InMemoryBrokerStateStore();
      let namedId: string | null | undefined;
      const record = state.recordBracketOrderIds.bind(state);
      state.recordBracketOrderIds = (venueName, key, ids) => {
        namedId = ids.target_order_id;
        record(venueName, key, ids);
      };
      const adapter = new AlpacaBrokerAdapter({
        client: makeClient(venue),
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        logger: recordingLogger(),
        state,
      });

      const workingAtEntry = new Set(venue.resting().map((row) => row.id));
      const threw = await adapter
        .rearmProtectiveLegs('key-1', 'AAPL', 'buy', qty, 95, 110)
        .then(() => false)
        .catch(() => true);

      const workingAtExit = venue.resting();

      if (workingAtExit.length > 1) violations.push(`${where} two working legs`);

      if (threw) return violations;

      const naked = nakedClearViolation(
        where,
        workingAtEntry,
        workingAtExit,
        venue,
        namedId,
        qty,
        sequence.length,
        seededQty,
      );
      if (naked) violations.push(naked);

      const misnamed = misnamedBookkeepingViolation(where, workingAtExit, namedId);
      if (misnamed) violations.push(misnamed);

      return violations;
    }

    // CPU-heavy: 9-12 s under coverage at load 25
    it('holds the money invariants across every reachable prior-status sequence', {
      timeout: 40_000,
    }, async () => {
      const sequences = buildPriorStatusSequences(4);
      expect(sequences).toHaveLength(2801);

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flat per-shape dispatch — one guard clause per fixture shape, not a decision tree
      function seed(attempt: number, shape: PriorStatusShape): AlpacaOrder {
        const row: AlpacaOrder = {
          ...acceptedOrder(),
          id: `seed-${attempt}`,
          client_order_id: attempt === 0 ? 'key-1:rearm' : `key-1:rearm-${attempt}`,
          order_class: 'oco',
          qty: '6',
          limit_price: '110',
          legs: [
            {
              id: `seed-${attempt}-stop`,
              type: 'stop',
              status: 'held',
              filled_qty: '0',
              filled_avg_price: null,
              filled_at: null,
              stop_price: '95',
            },
          ],
        };
        if (shape === 'resting-match') return row;
        if (shape === 'resting-mismatch') return { ...row, qty: '5' };
        if (shape === 'partially_filled')
          return { ...row, status: 'partially_filled', filled_qty: '2' };
        if (shape === 'filled') return { ...row, status: 'filled', filled_qty: '6' };
        if (shape === 'filled-undersized')
          return { ...row, status: 'filled', qty: '4', filled_qty: '4' };
        return { ...row, status: shape === 'canceled' ? 'canceled' : 'pending_cancel' };
      }

      const REQUESTS = [2, 4, 6];

      const violations: string[] = [];
      for (const qty of REQUESTS) {
        for (const sequence of sequences) {
          violations.push(...(await runPriorStatusSequenceCase(qty, sequence, seed)));
        }
      }

      expect(violations).toEqual([]);
    });

    describe('a fresh entry-order lookup breaks the ADOPT-direction naked-clear tie (#1581)', () => {
      it('declines a settled prior once its own entry order shows more bought than it closed', async () => {
        const venue = measuredAlpacaVenue();
        const adapter = adapterWith(makeClient(venue));

        await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
        patchRow(venue, 'key-1:rearm', { status: 'filled', filled_qty: '4' });
        venue.rows.set('key-1', {
          ...acceptedOrder(),
          id: 'entry-1',
          client_order_id: 'key-1',
          status: 'filled',
          qty: '6',
          filled_qty: '6',
        });
        venue.submitOcoOrder.mockClear();

        await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 2, 95, 110);

        expect(venue.submitOcoOrder).toHaveBeenCalledWith(
          expect.objectContaining({ client_order_id: 'key-1:rearm-1', qty: '2' }),
        );
        expect(venue.resting().map((row) => row.client_order_id)).toEqual(['key-1:rearm-1']);
      });

      it('still adopts a settled prior once the entry lookup confirms it covers everything ever bought', async () => {
        const venue = measuredAlpacaVenue();
        const adapter = adapterWith(makeClient(venue));

        await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);
        patchRow(venue, 'key-1:rearm', { status: 'filled', filled_qty: '4' });
        venue.rows.set('key-1', {
          ...acceptedOrder(),
          id: 'entry-1',
          client_order_id: 'key-1',
          status: 'filled',
          qty: '4',
          filled_qty: '4',
        });
        venue.submitOcoOrder.mockClear();

        await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 4, 95, 110);

        expect(venue.submitOcoOrder).not.toHaveBeenCalled();
        expect(venue.resting()).toEqual([]);
      });
    });
  });

  it("sweeps a re-armed residual and tags its fills under the LOT's own key, target first then stop", async () => {
    const submitOcoOrder = vi.fn().mockResolvedValue({
      ...acceptedOrder(),
      id: 'rearm-1',
      order_class: 'oco',
      legs: [
        {
          id: 'rearm-stop-1',
          type: 'stop',
          status: 'held',
          filled_qty: '0',
          filled_avg_price: null,
          filled_at: null,
        },
      ],
    });
    const filledAt = '2026-07-15T15:10:00Z';
    const getOrder = vi.fn().mockResolvedValue(
      acceptedOrder({
        id: 'rearm-1',
        status: 'filled',
        filled_qty: '6',
        filled_avg_price: '110',
        filled_at: filledAt,
        legs: [
          {
            id: 'rearm-stop-1',
            type: 'stop',
            status: 'canceled',
            filled_qty: '0',
            filled_avg_price: null,
            filled_at: null,
          },
        ],
      }),
    );
    const adapter = adapterWith(
      makeClient({
        submitOcoOrder,
        getOrder,
        getOrderByClientOrderId: vi.fn().mockResolvedValue(null),
      }),
    );
    await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toEqual([
      {
        client_order_id: 'key-1',
        broker_fill_id: 'rearm-1',
        leg: 'target',
        price: 110,
        qty: 6,
        fee: 0,
        timestamp: new Date(filledAt),
        qty_is_cumulative: true,
      },
    ]);
  });

  it('normalizes venue positions, signing the short side', async () => {
    const adapter = adapterWith(
      makeClient({
        getPositions: vi.fn().mockResolvedValue([
          { symbol: 'AAPL', qty: '10', side: 'long', avg_entry_price: '190.5' },
          { symbol: 'TSLA', qty: '-4', side: 'short', avg_entry_price: '220' },
        ]),
      }),
    );

    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: 'AAPL', qty: 10, side: 'buy', avg_entry_price: 190.5 },
      { instrument: 'TSLA', qty: -4, side: 'sell', avg_entry_price: 220 },
    ]);
  });

  it('drops an unparseable row rather than reporting NaN', async () => {
    const adapter = adapterWith(
      makeClient({
        getPositions: vi.fn().mockResolvedValue([
          { symbol: 'AAPL', qty: 'not-a-number', side: 'long', avg_entry_price: '190' },
          { symbol: 'MSFT', qty: '0', side: 'long', avg_entry_price: '400' },
          { symbol: 'TSLA', qty: '4', side: 'long', avg_entry_price: 'unpriced' },
        ]),
      }),
    );

    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: 'TSLA', qty: 4, side: 'buy', avg_entry_price: null },
    ]);
  });
});

describe('AlpacaBrokerAdapter — flatten entry pruning (#524 review)', () => {
  const NOW = new Date('2026-07-20T16:00:00Z');
  const fixedClock: Clock = { now: () => NOW };

  function executionConfig(): ExecutionConfig {
    return {
      simulated: {
        volatility_indicator: {
          indicator: 'atr',
          params: { period: 14 },
          timeframe: '1h',
          lookback: 15,
        },
        adv_window: { timeframe: '1d', lookback: 20 },
      },
    };
  }

  function orderIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
    return {
      idempotency_key: 'key-aapl-entry',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      size: 10,
      entry: 100,
      stop: 95,
      target: 110,
      time_in_force: 'day',
      decision_timestamp: NOW,
      decided_at: NOW,
      metadata: {
        debate_id: 'debate-1',
        conviction: 0.7,
        converged: true,
        sizing: {
          base_risk_fraction: 0.01,
          conviction_multiplier: 1,
          vol_floor_factor: 1,
          non_converged_haircut: 1,
          cosine_multiplier: 1,
        },
        cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
      },
      ...overrides,
    };
  }

  function goDecision(order: OrderIntent): VerdictDecision {
    return {
      status: 'go',
      order,
      no_go_reason: null,
      no_go_detail: null,
      approval_path: 'automated',
      would_require_approval: true,
      idempotency_key: order.idempotency_key,
      timestamp: NOW,
    };
  }

  it('stops polling a flatten once it reaches a terminal state and its fill has closed the lot', async () => {
    const { store } = openTestExecutionStore();

    const aaplEntry = orderIntent({
      idempotency_key: 'key-aapl-entry',
      instrument: 'AAPL',
      size: 10,
      entry: 100,
      stop: 95,
      target: 110,
    });
    const tslaEntry = orderIntent({
      idempotency_key: 'key-tsla-entry',
      instrument: 'TSLA',
      size: 5,
      entry: 200,
      stop: 190,
      target: 220,
    });

    const getOrder = vi.fn(async (orderId: string) => {
      switch (orderId) {
        case 'aapl-entry-order':
          return acceptedOrder({
            id: 'aapl-entry-order',
            client_order_id: 'key-aapl-entry',
            symbol: 'AAPL',
            status: 'filled',
            filled_qty: '10',
            filled_avg_price: '100',
            filled_at: NOW.toISOString(),
            legs: [],
          });
        case 'tsla-entry-order':
          return acceptedOrder({
            id: 'tsla-entry-order',
            client_order_id: 'key-tsla-entry',
            symbol: 'TSLA',
            status: 'filled',
            filled_qty: '5',
            filled_avg_price: '200',
            filled_at: NOW.toISOString(),
            legs: [],
          });
        case 'aapl-flatten-order':
          return acceptedOrder({
            id: 'aapl-flatten-order',
            symbol: 'AAPL',
            status: 'filled',
            filled_qty: '10',
            filled_avg_price: '105',
            filled_at: NOW.toISOString(),
            legs: [],
          });
        default:
          throw new Error(`unexpected getOrder(${orderId})`);
      }
    });
    const submitOrder = vi.fn(async (request: { client_order_id: string }) =>
      acceptedOrder({
        id: request.client_order_id === 'key-aapl-entry' ? 'aapl-entry-order' : 'tsla-entry-order',
        client_order_id: request.client_order_id,
        status: 'accepted',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        legs: [],
      }),
    );
    const submitMarketOrder = vi.fn(async () =>
      acceptedOrder({
        id: 'aapl-flatten-order',
        status: 'accepted',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
        legs: [],
      }),
    );
    const getOrderByClientOrderId = vi.fn().mockResolvedValue(null);

    const client = makeClient({
      submitOrder,
      getOrder,
      submitMarketOrder,
      getOrderByClientOrderId,
    });
    const broker = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      clock: fixedClock,
    });
    const input: ExecutionInput = {
      trace_id: 'trace-1',
      clock: fixedClock,
      broker,
      store,
      costModel: {} as CostModel,
      marketData: {} as MarketDataService,
      config: executionConfig(),
      sessionCalendars: OPEN_SESSION_CALENDARS,
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
      unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
      logger: { log: () => {} },
    };
    const execution = new ExecutionImpl(input);

    await execution.execute(goDecision(aaplEntry));
    await execution.execute(goDecision(tslaEntry));
    await execution.ingestFills();

    const exitResult = await execution.execute(
      goDecision(
        orderIntent({
          idempotency_key: 'key-aapl-exit',
          instrument: 'AAPL',
          side: 'sell',
          intent_type: 'exit',
          size: 10,
          entry: 105,
          stop: 105,
          target: 105,
          metadata: { ...orderIntent().metadata, exit_reason: 'flatten' },
        }),
      ),
    );
    expect(exitResult.status).toBe('submitted');

    await execution.ingestFills();

    expect((await store.getPosition('key-aapl-entry'))?.order_state).toBe('closed');
    expect(await store.getClosedTrades()).toHaveLength(1);
    expect(await store.getOpenPositions()).toEqual([
      expect.objectContaining({ idempotency_key: 'key-tsla-entry' }),
    ]);

    const flattenOrderCallsAfterClose = getOrder.mock.calls.filter(
      ([orderId]) => orderId === 'aapl-flatten-order',
    ).length;
    expect(flattenOrderCallsAfterClose).toBe(1);

    await execution.ingestFills();

    const flattenOrderCallsAfterSecondPoll = getOrder.mock.calls.filter(
      ([orderId]) => orderId === 'aapl-flatten-order',
    ).length;
    expect(flattenOrderCallsAfterSecondPoll).toBe(1);
  });

  it('follows the venue cumulative across polls instead of freezing at the first observation', async () => {
    const { store } = openTestExecutionStore();
    const getOrder = vi
      .fn()
      .mockResolvedValueOnce(
        acceptedOrder({
          id: 'aapl-entry-order',
          client_order_id: 'key-aapl-entry',
          status: 'partially_filled',
          filled_qty: '50',
          filled_avg_price: '100',
          filled_at: NOW.toISOString(),
          legs: [],
        }),
      )
      .mockResolvedValueOnce(
        acceptedOrder({
          id: 'aapl-entry-order',
          client_order_id: 'key-aapl-entry',
          status: 'canceled',
          filled_qty: '80',
          filled_avg_price: '100.75',
          filled_at: NOW.toISOString(),
          legs: [],
        }),
      );
    const client = makeClient({
      submitOrder: vi.fn(async () =>
        acceptedOrder({
          id: 'aapl-entry-order',
          client_order_id: 'key-aapl-entry',
          status: 'accepted',
          filled_qty: '0',
          filled_avg_price: null,
          filled_at: null,
          legs: [],
        }),
      ),
      getOrder,
    });
    const broker = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      clock: fixedClock,
    });
    const execution = new ExecutionImpl({
      trace_id: 'trace-1',
      clock: fixedClock,
      broker,
      store,
      costModel: {} as CostModel,
      marketData: {} as MarketDataService,
      config: executionConfig(),
      sessionCalendars: OPEN_SESSION_CALENDARS,
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
      unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
      logger: { log: () => {} },
    });

    await execution.execute(
      goDecision(orderIntent({ idempotency_key: 'key-aapl-entry', size: 100 })),
    );
    await execution.ingestFills();
    expect((await store.getPosition('key-aapl-entry'))?.filled_size).toBe(50);

    await execution.ingestFills();

    const position = await store.getPosition('key-aapl-entry');
    expect(position?.filled_size).toBe(80);
    expect(position?.avg_entry_price).toBeCloseTo(100.75, 10);
  });

  it('books a partial fill the venue never dated, on a clock that advances between reads (#842)', async () => {
    const { store } = openTestExecutionStore();
    let tick = 0;
    const advancingClock: Clock = { now: () => new Date(NOW.getTime() + tick++ * 1000) };
    const getOrder = vi.fn().mockResolvedValue(
      acceptedOrder({
        id: 'aapl-entry-order',
        client_order_id: 'key-aapl-entry',
        status: 'partially_filled',
        filled_qty: '50',
        filled_avg_price: '100',
        filled_at: null,
        legs: [],
      }),
    );
    const client = makeClient({
      submitOrder: vi.fn(async () =>
        acceptedOrder({
          id: 'aapl-entry-order',
          client_order_id: 'key-aapl-entry',
          status: 'accepted',
          filled_qty: '0',
          filled_avg_price: null,
          filled_at: null,
          legs: [],
        }),
      ),
      getOrder,
    });
    const broker = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      clock: advancingClock,
    });
    const execution = new ExecutionImpl({
      trace_id: 'trace-1',
      clock: advancingClock,
      broker,
      store,
      costModel: {} as CostModel,
      marketData: {} as MarketDataService,
      config: executionConfig(),
      sessionCalendars: OPEN_SESSION_CALENDARS,
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
      unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
      logger: { log: () => {} },
    });

    await execution.execute(
      goDecision(orderIntent({ idempotency_key: 'key-aapl-entry', size: 100 })),
    );
    await execution.ingestFills();

    expect((await store.getPosition('key-aapl-entry'))?.filled_size).toBe(50);
  });

  describe('AlpacaBrokerAdapter.resumeFlatten (#519, #526)', () => {
    it('returns null, Alpaca-authoritatively, when the venue has no such order', async () => {
      const client = makeClient({
        getOrderByClientOrderId: vi.fn().mockResolvedValue(null),
      });
      const adapter = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
      });

      const result = await adapter.resumeFlatten('flatten-1', 'AAPL');

      expect(result).toBeNull();
    });

    it('throws (never null) when the adapter cannot answer — mirrors getOrder', async () => {
      const client = makeClient({
        getOrderByClientOrderId: vi.fn().mockRejectedValue(new Error('connection reset')),
      });
      const adapter = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
      });

      await expect(adapter.resumeFlatten('flatten-1', 'AAPL')).rejects.toThrow();
    });

    it('does not journal the flatten to the durable bracket index', async () => {
      const state = new InMemoryBrokerStateStore();
      const saveBracketSpy = vi.spyOn(state, 'saveBracket');
      const recordIdsSpy = vi.spyOn(state, 'recordBracketOrderIds');
      const client = makeClient({
        getOrderByClientOrderId: vi.fn().mockResolvedValue(
          acceptedOrder({
            id: 'aapl-flatten-order',
            status: 'filled',
            filled_qty: '10',
            filled_avg_price: '105',
            filled_at: NOW.toISOString(),
            legs: [],
          }),
        ),
      });
      const adapter = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
        state,
      });

      await adapter.resumeFlatten('flatten-1', 'AAPL');

      expect(saveBracketSpy).not.toHaveBeenCalled();
      expect(recordIdsSpy).not.toHaveBeenCalled();
    });

    it('re-populates the flatten sweep across a restart: a SECOND adapter instance, never told about the flatten directly, still finds and prices its fill via resumeFlatten', async () => {
      const venueOrder = acceptedOrder({
        id: 'aapl-flatten-order',
        client_order_id: 'flatten-1',
        status: 'filled',
        filled_qty: '10',
        filled_avg_price: '105',
        filled_at: NOW.toISOString(),
        legs: [],
      });
      const getOrderByClientOrderId = vi.fn().mockResolvedValue(venueOrder);
      const getOrder = vi.fn().mockResolvedValue(venueOrder);
      const submitMarketOrder = vi.fn().mockResolvedValue(
        acceptedOrder({
          id: 'aapl-flatten-order',
          client_order_id: 'flatten-1',
          status: 'accepted',
          filled_qty: '0',
          filled_avg_price: null,
          filled_at: null,
          legs: [],
        }),
      );
      const client = makeClient({ getOrderByClientOrderId, getOrder, submitMarketOrder });

      const first = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
      });
      await first.submitFlatten('AAPL', 'sell', 10, 'flatten-1');

      const second = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
      });

      expect(await second.fetchNewFills(new Date(0))).toEqual([]);

      const resumed = await second.resumeFlatten('flatten-1', 'AAPL');
      expect(resumed).toMatchObject({ client_order_id: 'flatten-1', order_state: 'filled' });

      const fills = await second.fetchNewFills(new Date(0));
      expect(fills).toEqual([
        expect.objectContaining({
          client_order_id: 'flatten-1',
          broker_fill_id: 'aapl-flatten-order',
          leg: 'exit',
          price: 105,
          qty: 10,
        }),
      ]);
    });
  });
});

describe('AlpacaBrokerAdapter.submitProtectedExit (#1801)', () => {
  const ENTRY_ID = 'key-aapl-1355';
  const EXIT_ID = 'key-aapl-1355-exit';
  const TARGET_LEG_ID = 'alpaca-target-1';
  const STOP_LEG_ID = 'alpaca-stop-1';

  function restingEntryOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
    return acceptedOrder({
      id: 'alpaca-entry-1',
      client_order_id: ENTRY_ID,
      status: 'filled',
      filled_qty: '6',
      legs: [
        {
          id: TARGET_LEG_ID,
          type: 'limit',
          status: 'new',
          filled_qty: '0',
          filled_avg_price: null,
          filled_at: null,
        },
        {
          id: STOP_LEG_ID,
          type: 'stop',
          status: 'new',
          filled_qty: '0',
          filled_avg_price: null,
          filled_at: null,
        },
      ],
      ...overrides,
    });
  }

  function noPriorOrders(entry: AlpacaOrder) {
    return vi.fn(async (clientOrderId: string) => {
      if (clientOrderId === ENTRY_ID) return entry;
      return null;
    });
  }

  function adapterWith(
    client: AlpacaBrokerClient,
    cancelConfirmWait: (ms: number) => Promise<void> = () => Promise.resolve(),
  ): AlpacaBrokerAdapter {
    return new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      cancelConfirmWait,
    });
  }

  function request(
    overrides: Partial<Parameters<AlpacaBrokerAdapter['submitProtectedExit']>[0]> = {},
  ) {
    return {
      entryClientOrderId: ENTRY_ID,
      clientOrderId: EXIT_ID,
      instrument: 'AAPL',
      side: 'sell' as const,
      size: 6,
      rearm: { stop: 95, target: 110 },
      ...overrides,
    };
  }

  function confirmingGetOrder() {
    return vi.fn().mockResolvedValue({ ...acceptedOrder(), status: 'canceled' });
  }

  function livePosition(qty = '6') {
    return [{ symbol: 'AAPL', qty, side: 'long' as const, avg_entry_price: '100' }];
  }

  it('cancels the target leg then the stop leg, confirms each cancelled, then flattens with time_in_force day', async () => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const submitMarketOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'accepted' });
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder,
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue(livePosition()),
      submitMarketOrder,
    });
    const adapter = adapterWith(client);

    const ack = await adapter.submitProtectedExit(request());

    expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual([TARGET_LEG_ID, STOP_LEG_ID]);
    expect(submitMarketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      side: 'sell',
      qty: '6',
      time_in_force: 'day',
      client_order_id: EXIT_ID,
    });
    expect(ack).toEqual({
      client_order_id: EXIT_ID,
      broker_order_ids: ['flatten-1'],
      order_state: 'submitted',
    });
  });

  it.each([
    ['target', 0],
    ['stop', 1],
  ] as const)('cancels a %s leg still `held` before it flattens', async (_leg, held) => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const legs = (restingEntryOrder().legs ?? []).map((leg, index) =>
      index === held ? { ...leg, status: 'held' } : leg,
    );
    const adapter = adapterWith(
      makeClient({
        getOrderByClientOrderId: noPriorOrders(restingEntryOrder({ legs })),
        cancelOrder,
        getOrder: confirmingGetOrder(),
        getPositions: vi.fn().mockResolvedValue(livePosition()),
        submitMarketOrder: vi
          .fn()
          .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'accepted' }),
      }),
    );

    await adapter.submitProtectedExit(request());

    expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual([TARGET_LEG_ID, STOP_LEG_ID]);
  });

  it('closes nothing when the broker holds the name on the other side', async () => {
    const submitMarketOrder = vi.fn();
    const adapter = adapterWith(
      makeClient({
        getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
        cancelOrder: vi.fn().mockResolvedValue(undefined),
        getOrder: confirmingGetOrder(),
        getPositions: vi.fn().mockResolvedValue([{ ...livePosition('-6')[0], side: 'short' }]),
        submitMarketOrder,
      }),
    );
    expect(await adapter.submitProtectedExit(request())).toEqual({
      client_order_id: EXIT_ID,
      broker_order_ids: [],
      order_state: 'closed',
    });
    expect(submitMarketOrder).not.toHaveBeenCalled();
  });

  it('cancels a previously re-armed order instead of re-deriving the original bracket legs', async () => {
    const REARM_LEG_ID = 'alpaca-rearm-1';
    const getOrderByClientOrderId = vi.fn(async (clientOrderId: string) => {
      if (clientOrderId === `${ENTRY_ID}:rearm`) {
        return acceptedOrder({
          id: REARM_LEG_ID,
          client_order_id: `${ENTRY_ID}:rearm`,
          status: 'accepted',
        });
      }
      return null;
    });
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const submitMarketOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'accepted' });
    const client = makeClient({
      getOrderByClientOrderId,
      cancelOrder,
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue(livePosition()),
      submitMarketOrder,
    });
    const adapter = adapterWith(client);

    await adapter.submitProtectedExit(request());

    expect(cancelOrder).toHaveBeenCalledExactlyOnceWith(REARM_LEG_ID);
  });

  it('adopts an existing non-rejected exit order instead of cancelling legs again (crash idempotency)', async () => {
    const getOrderByClientOrderId = vi.fn(async (clientOrderId: string) => {
      if (clientOrderId === EXIT_ID) {
        return acceptedOrder({
          id: 'flatten-1',
          client_order_id: EXIT_ID,
          status: 'accepted',
          legs: [],
        });
      }
      return null;
    });
    const cancelOrder = vi.fn();
    const getPositions = vi.fn();
    const submitMarketOrder = vi.fn();
    const client = makeClient({
      getOrderByClientOrderId,
      cancelOrder,
      getPositions,
      submitMarketOrder,
    });
    const adapter = adapterWith(client);

    const ack = await adapter.submitProtectedExit(request());

    expect(ack).toEqual({
      client_order_id: EXIT_ID,
      broker_order_ids: ['flatten-1'],
      order_state: 'submitted',
    });
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(getPositions).not.toHaveBeenCalled();
    expect(submitMarketOrder).not.toHaveBeenCalled();
  });

  it('skips the flatten and reports closed when getOpenPositions ground truth shows nothing left to sell', async () => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const submitMarketOrder = vi.fn();
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder,
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue([]),
      submitMarketOrder,
    });
    const adapter = adapterWith(client);

    const ack = await adapter.submitProtectedExit(request());

    expect(ack).toEqual({ client_order_id: EXIT_ID, broker_order_ids: [], order_state: 'closed' });
    expect(submitMarketOrder).not.toHaveBeenCalled();
    expect(cancelOrder).toHaveBeenCalledTimes(2);
  });

  it('flattens the broker-reported quantity, not the ledger size, when they disagree', async () => {
    const submitMarketOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'accepted' });
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue(livePosition('2')),
      submitMarketOrder,
    });
    const adapter = adapterWith(client);

    await adapter.submitProtectedExit(request({ size: 6 }));

    expect(submitMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ qty: '2' }));
  });

  it('never attempts the flatten when a leg cancel does not confirm after repeated polling', async () => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const getOrder = vi.fn().mockResolvedValue({ ...acceptedOrder(), status: 'new' });
    const getPositions = vi.fn();
    const submitMarketOrder = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder,
      getOrder,
      getPositions,
      submitMarketOrder,
    });
    const adapter = adapterWith(client, wait);

    await expect(adapter.submitProtectedExit(request())).rejects.toThrow(
      /did not confirm cancelled/,
    );

    expect(cancelOrder).toHaveBeenCalledExactlyOnceWith(TARGET_LEG_ID);
    expect(getOrder.mock.calls.length).toBeGreaterThan(1);
    expect(wait).toHaveBeenCalled();
    expect(getPositions).not.toHaveBeenCalled();
    expect(submitMarketOrder).not.toHaveBeenCalled();
  });

  it('re-arms the entry-side protective legs inline when the day flatten comes back rejected, and throws', async () => {
    const submitOcoOrder = vi
      .fn()
      .mockResolvedValue(acceptedOrder({ id: 'rearm-1', client_order_id: `${ENTRY_ID}:rearm` }));
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue(livePosition()),
      submitMarketOrder: vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'rejected' }),
      submitOcoOrder,
    });
    const adapter = adapterWith(client);

    await expect(adapter.submitProtectedExit(request())).rejects.toThrow(/rejected by Alpaca/);

    expect(submitOcoOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'AAPL',
        side: 'sell',
        qty: '6',
        client_order_id: `${ENTRY_ID}:rearm`,
        stop_loss: { stop_price: '95.00' },
        take_profit: { limit_price: '110.00' },
      }),
    );
  });

  it('re-arms inline and re-throws the original submission failure when the day flatten submission itself throws', async () => {
    const submitOcoOrder = vi
      .fn()
      .mockResolvedValue(acceptedOrder({ id: 'rearm-1', client_order_id: `${ENTRY_ID}:rearm` }));
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue(livePosition()),
      submitMarketOrder: vi.fn().mockRejectedValue(new Error('network blip')),
      submitOcoOrder,
    });
    const adapter = adapterWith(client);

    await expect(adapter.submitProtectedExit(request())).rejects.toThrow(BrokerError);
    expect(submitOcoOrder).toHaveBeenCalledTimes(1);
  });

  it('throws a distinct UNPROTECTED error, without attempting a rearm, when the flatten fails and no rearm price was journalled', async () => {
    const submitOcoOrder = vi.fn();
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue(livePosition()),
      submitMarketOrder: vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'rejected' }),
      submitOcoOrder,
    });
    const adapter = adapterWith(client);

    await expect(adapter.submitProtectedExit(request({ rearm: undefined }))).rejects.toThrow(
      /UNPROTECTED/,
    );
    expect(submitOcoOrder).not.toHaveBeenCalled();
  });

  it('surfaces both failures, with UNPROTECTED wording, when the inline rearm itself fails after the flatten submission throws', async () => {
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue(livePosition()),
      submitMarketOrder: vi.fn().mockRejectedValue(new Error('network blip')),
      submitOcoOrder: vi.fn().mockRejectedValue(new Error('venue unavailable')),
    });
    const adapter = adapterWith(client);

    await expect(adapter.submitProtectedExit(request())).rejects.toThrow(
      /submitFlatten failed.*inline re-arm also failed.*rearmProtectiveLegs failed.*UNPROTECTED/s,
    );
  });

  it('sizes the flatten off the position matching the requested instrument, not just the first one on the account', async () => {
    const submitMarketOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'accepted' });
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrder: confirmingGetOrder(),
      getPositions: vi
        .fn()
        .mockResolvedValue([
          { symbol: 'TSLA', qty: '2', side: 'long' as const, avg_entry_price: '250' },
          ...livePosition('6'),
        ]),
      submitMarketOrder,
    });
    const adapter = adapterWith(client);

    await adapter.submitProtectedExit(request());

    expect(submitMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ qty: '6' }));
  });

  it('cancels only the stop leg when the target has already left the resting bracket, without a prior rearm', async () => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const submitMarketOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'accepted' });
    const client = makeClient({
      getOrderByClientOrderId: noPriorOrders(
        restingEntryOrder({
          legs: [
            {
              id: TARGET_LEG_ID,
              type: 'limit',
              status: 'filled',
              filled_qty: '6',
              filled_avg_price: '110',
              filled_at: '2026-09-28T00:00:00Z',
            },
            {
              id: STOP_LEG_ID,
              type: 'stop',
              status: 'new',
              filled_qty: '0',
              filled_avg_price: null,
              filled_at: null,
            },
          ],
        }),
      ),
      cancelOrder,
      getOrder: confirmingGetOrder(),
      getPositions: vi.fn().mockResolvedValue([]),
      submitMarketOrder,
    });
    const adapter = adapterWith(client);

    await adapter.submitProtectedExit(request());

    expect(cancelOrder).toHaveBeenCalledExactlyOnceWith(STOP_LEG_ID);
  });

  describe('replaceProtectiveLegs (#1990)', () => {
    const replace = {
      entryClientOrderId: ENTRY_ID,
      instrument: 'AAPL',
      side: 'buy' as const,
      qty: 151,
      stop: 63.333,
      target: 80.001,
    };

    it('cancels the stale target and stop legs, confirms each, and only then places the rescaled OCO', async () => {
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const getOrder = confirmingGetOrder();
      const getPositions = vi.fn().mockResolvedValue(livePosition('151'));
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'oco-1', status: 'accepted' });
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
          cancelOrder,
          getOrder,
          getPositions,
          submitOcoOrder,
        }),
      );

      await adapter.replaceProtectiveLegs(replace);

      expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual([TARGET_LEG_ID, STOP_LEG_ID]);
      expect(getPositions.mock.invocationCallOrder[0]).toBeGreaterThan(
        Math.max(...getOrder.mock.invocationCallOrder),
      );
      expect(submitOcoOrder).toHaveBeenCalledExactlyOnceWith({
        symbol: 'AAPL',
        side: 'sell',
        qty: '151',
        time_in_force: 'gtc',
        client_order_id: `${ENTRY_ID}:rearm`,
        order_class: 'oco',
        take_profit: { limit_price: '80.00' },
        stop_loss: { stop_price: '63.34' },
      });
      const lastConfirm = Math.max(...getOrder.mock.invocationCallOrder);
      expect(submitOcoOrder.mock.invocationCallOrder[0]).toBeGreaterThan(lastConfirm);
    });

    it('places nothing when a stale leg never confirms cancelled, and names the cancel step', async () => {
      const submitOcoOrder = vi.fn();
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
          cancelOrder: vi.fn().mockResolvedValue(undefined),
          getOrder: vi.fn().mockResolvedValue({ ...acceptedOrder(), status: 'new' }),
          submitOcoOrder,
        }),
      );

      const thrown = await adapter.replaceProtectiveLegs(replace).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ProtectiveReplaceError);
      expect(thrown).toMatchObject({
        name: 'ProtectiveReplaceError',
        cause: expect.objectContaining({ message: expect.stringContaining('did not confirm') }),
        step: 'cancel',
        message: expect.stringMatching(
          /^replaceProtectiveLegs: the stale legs of key-aapl-1355 on AAPL did not cancel: submitProtectedExit: leg alpaca-target-1/,
        ),
      });
      expect(submitOcoOrder).not.toHaveBeenCalled();
    });

    it('names the place step when the OCO is refused after the stale legs cancelled', async () => {
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
          cancelOrder: vi.fn().mockResolvedValue(undefined),
          getOrder: confirmingGetOrder(),
          getPositions: vi.fn().mockResolvedValue(livePosition('151')),
          submitOcoOrder: vi.fn().mockRejectedValue(new Error('insufficient qty')),
        }),
      );

      const thrown = await adapter.replaceProtectiveLegs(replace).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ProtectiveReplaceError);
      expect((thrown as Error).cause).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({
        step: 'place',
        message: expect.stringMatching(
          /^replaceProtectiveLegs: the stale legs of key-aapl-1355 on AAPL are cancelled and the replacement failed: /,
        ),
      });
    });

    function ocoClient(entry: AlpacaOrder, positionQty: string, side: 'long' | 'short' = 'long') {
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'oco-1', status: 'accepted' });
      const client = makeClient({
        getOrderByClientOrderId: noPriorOrders(entry),
        cancelOrder,
        getOrder: confirmingGetOrder(),
        getPositions: vi.fn().mockResolvedValue([{ ...livePosition(positionQty)[0], side }]),
        submitOcoOrder,
      });
      return { cancelOrder, submitOcoOrder, client };
    }

    async function replacedWith(
      entry: AlpacaOrder,
      positionQty: string,
      side: 'long' | 'short' = 'long',
    ) {
      const { cancelOrder, submitOcoOrder, client } = ocoClient(entry, positionQty, side);
      const placed = await adapterWith(client).replaceProtectiveLegs(replace);
      return { cancelled: cancelOrder.mock.calls.map(([id]) => id), submitOcoOrder, placed };
    }

    it.each(['new', 'accepted', 'pending_new', 'accepted_for_bidding', 'held'])(
      'cancels a stop leg resting as %s and nothing terminal',
      async (status) => {
        const [target, stop] = restingEntryOrder().legs ?? [];
        const { cancelled } = await replacedWith(
          restingEntryOrder({
            legs: [
              { ...target, status: 'filled' },
              { ...stop, status },
            ] as AlpacaOrderLeg[],
          }),
          '151',
        );
        expect(cancelled).toEqual([STOP_LEG_ID]);
      },
    );

    it('names the positions read when it fails after the cancel, as the place step', async () => {
      const { cancelOrder, submitOcoOrder } = ocoClient(restingEntryOrder(), '151');
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: noPriorOrders(restingEntryOrder()),
          cancelOrder,
          getOrder: confirmingGetOrder(),
          getPositions: vi.fn().mockRejectedValue(new Error('positions down')),
          submitOcoOrder,
        }),
      );
      const thrown = await adapter.replaceProtectiveLegs(replace).catch((error: unknown) => error);
      expect(thrown).toMatchObject({
        step: 'place',
        cause: expect.objectContaining({ operation: 'replaceProtectiveLegs' }),
      });
      expect(submitOcoOrder).not.toHaveBeenCalled();
    });

    it('cancels a stop leg Alpaca still holds `held` beside a live target before placing', async () => {
      const [target, stop] = restingEntryOrder().legs ?? [];
      const { cancelled, submitOcoOrder } = await replacedWith(
        restingEntryOrder({ legs: [target, { ...stop, status: 'held' }] as AlpacaOrderLeg[] }),
        '151',
      );
      expect(cancelled).toEqual([TARGET_LEG_ID, STOP_LEG_ID]);
      expect(submitOcoOrder).toHaveBeenCalledOnce();
    });

    it('sizes the OCO to the broker position when a stale stop part-filled during the cancel', async () => {
      const { submitOcoOrder, placed } = await replacedWith(restingEntryOrder(), '100');
      expect(placed).toBe(100);
      expect(submitOcoOrder).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ qty: '100', client_order_id: `${ENTRY_ID}:rearm` }),
      );
    });

    it('keeps the ledger qty when the broker holds more', async () => {
      const { submitOcoOrder, placed } = await replacedWith(restingEntryOrder(), '200');
      expect(placed).toBe(151);
      expect(submitOcoOrder).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ qty: '151' }),
      );
    });

    it('places nothing when the stale stop filled the whole position during the cancel', async () => {
      const { submitOcoOrder, placed } = await replacedWith(restingEntryOrder(), '0');
      expect(placed).toBe(0);
      expect(submitOcoOrder).not.toHaveBeenCalled();
    });

    it('places nothing when a stale stop oversold the long into a short during the cancel', async () => {
      const { submitOcoOrder, placed } = await replacedWith(restingEntryOrder(), '-20', 'short');
      expect(placed).toBe(0);
      expect(submitOcoOrder).not.toHaveBeenCalled();
    });

    it('re-arms a short against a short broker position on the buy side', async () => {
      const { cancelOrder, submitOcoOrder, client } = ocoClient(
        restingEntryOrder(),
        '-151',
        'short',
      );
      const placed = await adapterWith(client).replaceProtectiveLegs({
        ...replace,
        side: 'sell',
        stop: 90,
        target: 70,
      });
      expect(cancelOrder).toHaveBeenCalled();
      expect(placed).toBe(151);
      expect(submitOcoOrder).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ side: 'buy', qty: '151' }),
      );
    });

    it('re-arms a holding with no resting stop without cancelling anything (crash after the cancel)', async () => {
      const done = (restingEntryOrder().legs ?? []).map((leg) => ({ ...leg, status: 'canceled' }));
      const { cancelled, submitOcoOrder } = await replacedWith(
        restingEntryOrder({ legs: done }),
        '151',
      );
      expect(cancelled).toEqual([]);
      expect(submitOcoOrder).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ qty: '151', client_order_id: `${ENTRY_ID}:rearm` }),
      );
    });

    it('cancels a resting re-arm OCO and confirms it before the next wire id goes out', async () => {
      const prior = { ...acceptedOrder(), id: 'oco-0', client_order_id: `${ENTRY_ID}:rearm` };
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const getOrder = vi.fn().mockResolvedValue({ ...prior, status: 'canceled' });
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'oco-1', status: 'accepted' });
      const adapter = adapterWith(
        makeClient({
          getOrderByClientOrderId: vi.fn(async (id: string) => {
            if (id === prior.client_order_id) return { ...prior, status: 'canceled' };
            return id === ENTRY_ID ? restingEntryOrder() : null;
          }),
          cancelOrder,
          getOrder,
          getPositions: vi.fn().mockResolvedValue(livePosition('151')),
          submitOcoOrder,
        }),
      );

      await adapter.replaceProtectiveLegs(replace);

      expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual(['oco-0']);
      expect(submitOcoOrder).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ client_order_id: `${ENTRY_ID}:rearm-1` }),
      );
      expect(submitOcoOrder.mock.invocationCallOrder[0]).toBeGreaterThan(
        Math.max(...getOrder.mock.invocationCallOrder),
      );
    });
  });
});

describe('AlpacaBrokerAdapter — exact operations, ids, logs and edges', () => {
  const KEY = 'key-aapl-1355';
  const EXIT = `${KEY}-exit`;
  const T0 = new Date('2026-07-20T16:00:00Z');
  const MINUTE = 60_000;

  type AdapterInput = ConstructorParameters<typeof AlpacaBrokerAdapter>[0];

  function adapterOn(
    client: AlpacaBrokerClient,
    extra: Partial<AdapterInput> = {},
  ): AlpacaBrokerAdapter {
    return new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
      ...extra,
    });
  }

  function orderAt(id: string, clientOrderId: string, overrides: Partial<AlpacaOrder> = {}) {
    return acceptedOrder({ id, client_order_id: clientOrderId, ...overrides });
  }

  function lookupBy(byClientOrderId: Record<string, AlpacaOrder | Error>) {
    return vi.fn(async (clientOrderId: string) => {
      const found = byClientOrderId[clientOrderId];
      if (found instanceof Error) throw found;
      return found ?? null;
    });
  }

  function leg(overrides: Partial<NonNullable<AlpacaOrder['legs']>[number]>) {
    return {
      id: 'leg',
      type: 'limit' as const,
      status: 'new',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
      ...overrides,
    };
  }

  function restingEntry(stopStatus = 'new', targetStatus = 'new'): AlpacaOrder {
    return orderAt('alpaca-entry-1', KEY, {
      status: 'filled',
      filled_qty: '6',
      legs: [
        leg({ id: 'alpaca-target-1', type: 'limit', status: targetStatus }),
        leg({ id: 'alpaca-stop-1', type: 'stop', status: stopStatus }),
      ],
    });
  }

  function exitClient(overrides: Partial<AlpacaBrokerClient> = {}): AlpacaBrokerClient {
    return makeClient({
      getOrderByClientOrderId: lookupBy({ [KEY]: restingEntry() }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrder: vi.fn().mockResolvedValue({ ...acceptedOrder(), status: 'canceled' }),
      getPositions: vi
        .fn()
        .mockResolvedValue([{ symbol: 'AAPL', qty: '6', side: 'long', avg_entry_price: '100' }]),
      submitMarketOrder: vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'accepted' }),
      submitOcoOrder: vi.fn().mockResolvedValue(orderAt('rearm-1', `${KEY}:rearm`, { legs: [] })),
      ...overrides,
    });
  }

  function exitRequest(
    overrides: Partial<Parameters<AlpacaBrokerAdapter['submitProtectedExit']>[0]> = {},
  ) {
    return {
      entryClientOrderId: KEY,
      clientOrderId: EXIT,
      instrument: 'AAPL',
      side: 'sell' as const,
      size: 6,
      rearm: { stop: 95, target: 110 },
      ...overrides,
    };
  }

  function cancelledIds(client: AlpacaBrokerClient): unknown[] {
    return vi.mocked(client.cancelOrder).mock.calls.map(([id]) => id);
  }

  function lookedUp(client: AlpacaBrokerClient): unknown[] {
    return vi.mocked(client.getOrderByClientOrderId).mock.calls.map(([id]) => id);
  }

  function sweptIds(client: AlpacaBrokerClient): unknown[] {
    return vi.mocked(client.getOrder).mock.calls.map(([id]) => id);
  }

  async function caught(promise: Promise<unknown>): Promise<Error> {
    const error = await promise.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof Error)) throw new Error('expected the call to reject with an Error');
    return error;
  }

  function legless(order: AlpacaOrder): AlpacaOrder {
    const { legs: _legs, ...rest } = order;
    return rest;
  }

  function payloadOf(entries: readonly { payload?: unknown }[], field: string): unknown[] {
    return entries.map((entry) => (entry.payload as Record<string, unknown> | undefined)?.[field]);
  }

  class FaultyState extends InMemoryBrokerStateStore {
    readonly failing = new Set<string>();

    private fault(operation: string): void {
      if (this.failing.has(operation)) throw new Error(`${operation} failed`);
    }

    override clearUnpricedFill(
      ...args: Parameters<InMemoryBrokerStateStore['clearUnpricedFill']>
    ): void {
      this.fault('clearUnpricedFill');
      super.clearUnpricedFill(...args);
    }

    override recordUnpricedFill(
      ...args: Parameters<InMemoryBrokerStateStore['recordUnpricedFill']>
    ): void {
      this.fault('recordUnpricedFill');
      super.recordUnpricedFill(...args);
    }

    override loadUnpricedFills(
      ...args: Parameters<InMemoryBrokerStateStore['loadUnpricedFills']>
    ): ReturnType<InMemoryBrokerStateStore['loadUnpricedFills']> {
      this.fault('loadUnpricedFills');
      return super.loadUnpricedFills(...args);
    }

    override markUnpricedFillAlerted(
      ...args: Parameters<InMemoryBrokerStateStore['markUnpricedFillAlerted']>
    ): void {
      this.fault('markUnpricedFillAlerted');
      super.markUnpricedFillAlerted(...args);
    }
  }

  const SWEEP_TRACE = 'alpaca-fetch-new-fills';
  const PREDATES_MESSAGE =
    '#1123: Alpaca fill dated before its own order was submitted — the ingest-fills ' +
    'since-floor invariant may be violated';

  describe('operation names on venue failures', () => {
    const outage = new Error('venue down');

    it('names getOpenPositions, getOrder and resumeFlatten', async () => {
      const adapter = adapterOn(
        makeClient({
          getPositions: vi.fn().mockRejectedValue(outage),
          getOrderByClientOrderId: vi.fn().mockRejectedValue(outage),
        }),
      );

      await expect(adapter.getOpenPositions()).rejects.toMatchObject({
        operation: 'getOpenPositions',
      });
      await expect(adapter.getOrder(KEY, 'AAPL')).rejects.toMatchObject({ operation: 'getOrder' });
      await expect(adapter.resumeFlatten(KEY, 'AAPL')).rejects.toMatchObject({
        operation: 'resumeFlatten',
      });
    });

    it('names cancel on a failed re-armed-order cancel, which goes first', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({
          [KEY]: orderAt('e1', KEY),
          [`${KEY}:rearm`]: orderAt('r0', `${KEY}:rearm`),
        }),
        cancelOrder: vi.fn().mockRejectedValue(outage),
      });

      await expect(adapterOn(client).cancel(KEY, 'AAPL')).rejects.toMatchObject({
        operation: 'cancel',
      });
      expect(cancelledIds(client)).toEqual(['r0']);
    });

    it('names cancel on a failed bracket cancel', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({ [KEY]: orderAt('e1', KEY) }),
        cancelOrder: vi.fn().mockRejectedValue(outage),
      });

      await expect(adapterOn(client).cancel(KEY, 'AAPL')).rejects.toMatchObject({
        operation: 'cancel',
      });
      expect(cancelledIds(client)).toEqual(['e1']);
    });

    it('rethrows the lookup failure, named cancel, when the open-order list also fails', async () => {
      const client = makeClient({
        getOrderByClientOrderId: vi.fn().mockRejectedValue(outage),
        listOpenOrders: vi.fn().mockRejectedValue(new Error('list down')),
      });

      await expect(adapterOn(client).cancel(KEY, 'AAPL')).rejects.toMatchObject({
        name: 'BrokerError',
        operation: 'cancel',
      });
    });

    it('rethrows the order lookup failure even with an in-process re-arm on record', async () => {
      let lookupsFail = false;
      const client = makeClient({
        getOrderByClientOrderId: vi.fn(async () => {
          if (lookupsFail) throw outage;
          return null;
        }),
        submitOcoOrder: vi.fn().mockResolvedValue(orderAt('r0', `${KEY}:rearm`, { legs: [] })),
        listOpenOrders: vi.fn().mockRejectedValue(new Error('list down')),
      });
      const adapter = adapterOn(client);
      await adapter.rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110);
      lookupsFail = true;

      await expect(adapter.cancel(KEY, 'AAPL')).rejects.toMatchObject({
        name: 'BrokerError',
        operation: 'cancel',
      });
    });

    it('names submitProtectedExit on the position read, the entry lookup, the leg cancel and the leg poll', async () => {
      await expect(
        adapterOn(
          exitClient({ getPositions: vi.fn().mockRejectedValue(outage) }),
        ).submitProtectedExit(exitRequest()),
      ).rejects.toMatchObject({ operation: 'submitProtectedExit' });
      await expect(
        adapterOn(
          exitClient({ getOrderByClientOrderId: lookupBy({ [KEY]: outage }) }),
        ).submitProtectedExit(exitRequest()),
      ).rejects.toMatchObject({ operation: 'submitProtectedExit' });
      await expect(
        adapterOn(
          exitClient({ cancelOrder: vi.fn().mockRejectedValue(outage) }),
        ).submitProtectedExit(exitRequest()),
      ).rejects.toMatchObject({ operation: 'submitProtectedExit' });
      await expect(
        adapterOn(exitClient({ getOrder: vi.fn().mockRejectedValue(outage) })).submitProtectedExit(
          exitRequest(),
        ),
      ).rejects.toMatchObject({ operation: 'submitProtectedExit' });
    });

    it('names rearmProtectiveLegs on the wire-id walk', async () => {
      const client = makeClient({ getOrderByClientOrderId: vi.fn().mockRejectedValue(outage) });

      await expect(
        adapterOn(client).rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110),
      ).rejects.toMatchObject({ operation: 'rearmProtectiveLegs' });
    });

    it('names rearmProtectiveLegs on cancelling a superseded live re-arm', async () => {
      const live = (id: string, wireId: string) =>
        orderAt(id, wireId, {
          qty: '6',
          limit_price: '110',
          status: 'new',
          legs: [leg({ id: `${id}-stop`, type: 'stop', stop_price: '95' })],
        });
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({
          [`${KEY}:rearm`]: live('r0', `${KEY}:rearm`),
          [`${KEY}:rearm-1`]: live('r1', `${KEY}:rearm-1`),
        }),
        cancelOrder: vi.fn().mockRejectedValue(outage),
      });

      await expect(
        adapterOn(client).rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110),
      ).rejects.toMatchObject({ operation: 'rearmProtectiveLegs' });
      expect(cancelledIds(client)).toEqual(['r0']);
    });

    it('names rearmProtectiveLegs on cancelling a stale re-arm', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({
          [`${KEY}:rearm`]: orderAt('r0', `${KEY}:rearm`, { qty: '5', status: 'new' }),
        }),
        cancelOrder: vi.fn().mockRejectedValue(outage),
      });

      await expect(
        adapterOn(client).rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110),
      ).rejects.toMatchObject({ operation: 'rearmProtectiveLegs' });
    });

    it('names rearmProtectiveLegs on the entry read behind a settled re-arm', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({
          [`${KEY}:rearm`]: orderAt('r0', `${KEY}:rearm`, { status: 'filled', filled_qty: '6' }),
          [KEY]: outage,
        }),
      });

      await expect(
        adapterOn(client).rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110),
      ).rejects.toMatchObject({ operation: 'rearmProtectiveLegs' });
    });

    it.each([
      ['bracket', { bracket_failures: 1, flatten_failures: 0, rearm_failures: 0 }],
      ['flatten', { bracket_failures: 0, flatten_failures: 1, rearm_failures: 0 }],
      ['rearm', { bracket_failures: 0, flatten_failures: 0, rearm_failures: 1 }],
    ] as const)(
      'names fetchNewFills on a failed %s read and logs the exact failure line',
      async (source, counts) => {
        const logger = recordingLogger();
        const client = makeClient({
          getOrder: vi.fn().mockRejectedValue(outage),
          getOrderByClientOrderId: vi.fn().mockResolvedValue(null),
          submitMarketOrder: vi.fn().mockResolvedValue(orderAt('f1', EXIT)),
          submitOcoOrder: vi.fn().mockResolvedValue(orderAt('r0', `${KEY}:rearm`, { legs: [] })),
        });
        const adapter = adapterOn(client, { logger });
        if (source === 'bracket') await adapter.submitBracket(makeBracket());
        if (source === 'flatten') await adapter.submitFlatten('AAPL', 'sell', 6, EXIT);
        if (source === 'rearm') await adapter.rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110);

        const error = await caught(adapter.fetchNewFills(new Date(0)));

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([
          expect.objectContaining({ operation: 'fetchNewFills' }),
        ]);
        expect(error.message).toBe(
          'Alpaca fetchNewFills: 1 failure(s) during the sweep ' +
            `(${counts.bracket_failures} bracket(s), ${counts.flatten_failures} flatten(s), ` +
            `${counts.rearm_failures} rearm(s) failed); ` +
            'no fills could be read',
        );
        expect(logger.entries).toEqual([
          {
            trace_id: SWEEP_TRACE,
            stage: 'execution',
            event: 'alpaca_fill_sweep_source_failed',
            level: 'error',
            message: 'Alpaca fetchNewFills: per-source failure',
            payload: {
              ...counts,
              fills_read: 0,
              error: 'alpaca fetchNewFills failed (status unknown)',
            },
          },
        ]);
      },
    );
  });

  describe('order ids', () => {
    it('returns null for an order the venue does not know', async () => {
      const adapter = adapterOn(makeClient({ getOrderByClientOrderId: lookupBy({}) }));

      expect(await adapter.getOrder(KEY, 'AAPL')).toBeNull();
    });

    it('lists the parent and every leg id, or the parent alone when there are no legs', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({
          [KEY]: orderAt('e1', KEY),
          [EXIT]: legless(orderAt('f1', EXIT)),
        }),
      });
      const adapter = adapterOn(client);

      expect((await adapter.getOrder(KEY, 'AAPL'))?.broker_order_ids).toEqual([
        'e1',
        'alpaca-target-1',
        'alpaca-stop-1',
      ]);
      expect((await adapter.resumeFlatten(EXIT, 'AAPL'))?.broker_order_ids).toEqual(['f1']);
    });

    it('acks a legless bracket response with the parent id alone', async () => {
      const client = makeClient({
        submitOrder: vi.fn().mockResolvedValue(legless(acceptedOrder())),
      });

      const ack = await adapterOn(client).submitBracket(makeBracket());

      expect(ack.broker_order_ids).toEqual(['alpaca-entry-1']);
    });

    it.each([
      ['target first', ['limit', 'stop']],
      ['stop first', ['stop', 'limit']],
    ] as const)('journals each leg id under its own name (%s)', async (_label, types) => {
      const state = new InMemoryBrokerStateStore();
      const legs = types.map((type) =>
        leg({ id: type === 'stop' ? 'alpaca-stop-1' : 'alpaca-target-1', type, status: 'held' }),
      );
      const client = makeClient({
        submitOrder: vi.fn().mockResolvedValue(acceptedOrder({ legs })),
      });

      await adapterOn(client, { state }).submitBracket(makeBracket());

      expect(state.loadBrackets('alpaca')).toEqual([
        expect.objectContaining({
          entry_order_id: 'alpaca-entry-1',
          stop_order_id: 'alpaca-stop-1',
          target_order_id: 'alpaca-target-1',
        }),
      ]);
    });

    it('journals a re-armed OCO under the lot on the alpaca venue', async () => {
      const state = new InMemoryBrokerStateStore();
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({}),
        submitOcoOrder: vi.fn().mockResolvedValue(
          orderAt('r0', `${KEY}:rearm`, {
            legs: [leg({ id: 'r0-stop', type: 'stop' })],
          }),
        ),
      });

      await adapterOn(client, { state }).rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110);

      expect(state.loadBrackets('alpaca')).toEqual([
        expect.objectContaining({
          client_order_id: KEY,
          stop_order_id: 'r0-stop',
          target_order_id: 'r0',
        }),
      ]);
    });

    it('reloads only brackets with an entry id after a restart', async () => {
      const state = new InMemoryBrokerStateStore();
      const record = (clientOrderId: string, entryId: string | null, journalled: boolean) =>
        state.saveBracket({
          venue: 'alpaca',
          client_order_id: clientOrderId,
          phase: 'armed',
          entry_order_id: entryId,
          stop_order_id: null,
          target_order_id: null,
          request: journalled ? toRequestFields(makeBracket({ instrument: 'AAPL' })) : null,
          armed_qty: null,
          arming_qty: null,
          arm_attempt: 0,
        });
      record('unsubmitted-lot', null, true);
      record('legacy-lot', 'n1', false);
      record('stocks-lot', 's1', true);
      const client = makeClient({
        getOrder: vi.fn().mockResolvedValue(acceptedOrder({ legs: [] })),
      });

      await adapterOn(client, { state }).fetchNewFills(new Date(0));

      expect(sweptIds(client)).toEqual(['n1', 's1']);
    });
  });

  describe('cancel target resolution', () => {
    it('falls back to the open-order list, picking the exact entry and the highest re-arm attempt', async () => {
      const client = makeClient({
        getOrderByClientOrderId: vi.fn().mockRejectedValue(new Error('lookup down')),
        listOpenOrders: vi
          .fn()
          .mockResolvedValue([
            orderAt('x', 'someone-else'),
            orderAt('e1', KEY),
            orderAt('r1', `${KEY}:rearm-1`),
            orderAt('r4', `${KEY}:rearm-4`),
            orderAt('r2', `${KEY}:rearm-2`),
            orderAt('r2b', `${KEY}:rearm-2`),
            orderAt('r0', `${KEY}:rearm`),
          ]),
        cancelOrder: vi.fn().mockResolvedValue(undefined),
      });

      await adapterOn(client).cancel(KEY, 'AAPL');

      expect(cancelledIds(client)).toEqual(['r2', 'e1']);
    });

    it('does not walk re-arm ids by lookup once the entry lookup has failed', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({
          [KEY]: new Error('lookup down'),
          [`${KEY}:rearm`]: orderAt('r0', `${KEY}:rearm`),
        }),
        listOpenOrders: vi.fn().mockResolvedValue([orderAt('e1', KEY)]),
        cancelOrder: vi.fn().mockResolvedValue(undefined),
      });

      await adapterOn(client).cancel(KEY, 'AAPL');

      expect(cancelledIds(client)).toEqual(['e1']);
    });

    it('stops the re-arm walk at the last wire id and cancels the latest', async () => {
      const wireIds = [`${KEY}:rearm`, `${KEY}:rearm-1`, `${KEY}:rearm-2`, `${KEY}:rearm-3`];
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({
          [KEY]: orderAt('e1', KEY),
          ...Object.fromEntries(wireIds.map((id, i) => [id, orderAt(`r${i}`, id)])),
          [`${KEY}:rearm-4`]: orderAt('r4', `${KEY}:rearm-4`),
        }),
        cancelOrder: vi.fn().mockResolvedValue(undefined),
      });

      await adapterOn(client).cancel(KEY, 'AAPL');

      expect(cancelledIds(client)).toEqual(['r3', 'e1']);
      expect(lookedUp(client)).not.toContain(`${KEY}:rearm-4`);
    });

    it('stops sweeping a bracket and a re-arm once each is cancelled', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({}),
        submitOcoOrder: vi.fn().mockResolvedValue(orderAt('r0', `${KEY}:rearm`, { legs: [] })),
        cancelOrder: vi.fn().mockResolvedValue(undefined),
      });
      const adapter = adapterOn(client);
      await adapter.submitBracket(makeBracket());
      await adapter.rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110);
      vi.mocked(client.getOrderByClientOrderId).mockImplementation(async (id) =>
        id === KEY ? orderAt('alpaca-entry-1', KEY) : null,
      );

      await adapter.cancel(KEY, 'AAPL');
      await adapter.fetchNewFills(new Date(0));

      expect(cancelledIds(client)).toEqual(['r0', 'alpaca-entry-1']);
      expect(sweptIds(client)).toEqual([]);
    });
  });

  describe('submitProtectedExit edges', () => {
    it('re-submits over an existing exit the venue rejected', async () => {
      const client = exitClient({
        getOrderByClientOrderId: lookupBy({
          [KEY]: restingEntry(),
          [EXIT]: orderAt('flatten-0', EXIT, { status: 'rejected', legs: [] }),
        }),
      });

      const ack = await adapterOn(client).submitProtectedExit(exitRequest());

      expect(ack.broker_order_ids).toEqual(['flatten-1']);
      expect(cancelledIds(client)).toEqual(['alpaca-target-1', 'alpaca-stop-1']);
    });

    it('refuses to cancel anything when the re-arm lookup fails', async () => {
      const client = exitClient({
        getOrderByClientOrderId: lookupBy({
          [KEY]: restingEntry(),
          [`${KEY}:rearm`]: new Error('lookup down'),
        }),
      });

      await expect(adapterOn(client).submitProtectedExit(exitRequest())).rejects.toMatchObject({
        operation: 'cancel',
      });
      expect(client.cancelOrder).not.toHaveBeenCalled();
    });

    it('flattens without cancelling when the entry order is unknown', async () => {
      const client = exitClient({ getOrderByClientOrderId: lookupBy({}) });

      const ack = await adapterOn(client).submitProtectedExit(exitRequest());

      expect(client.cancelOrder).not.toHaveBeenCalled();
      expect(ack.broker_order_ids).toEqual(['flatten-1']);
    });

    it('cancels only the target when the stop has left the resting set', async () => {
      const client = exitClient({
        getOrderByClientOrderId: lookupBy({ [KEY]: restingEntry('filled') }),
      });

      await adapterOn(client).submitProtectedExit(exitRequest());

      expect(cancelledIds(client)).toEqual(['alpaca-target-1']);
    });

    it('polls a stuck leg exactly five times, waiting the configured gap between checks', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      const client = exitClient({
        getOrder: vi.fn().mockResolvedValue({ ...acceptedOrder(), status: 'new' }),
      });
      const adapter = adapterOn(client, { cancelConfirmWait: wait, cancelConfirmWaitMs: 7 });

      const error = await caught(adapter.submitProtectedExit(exitRequest()));

      expect(error.message).toBe(
        'submitProtectedExit: leg alpaca-target-1 on AAPL did not confirm cancelled after 5 checks',
      );
      expect(client.getOrder).toHaveBeenCalledTimes(5);
      expect(wait.mock.calls).toEqual([[7], [7], [7], [7]]);
    });

    it('never waits before the first check, and waits 250 ms by default', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      const confirmed = exitClient();
      await adapterOn(confirmed, { cancelConfirmWait: wait }).submitProtectedExit(exitRequest());
      expect(wait).not.toHaveBeenCalled();

      const getOrder = vi
        .fn()
        .mockResolvedValueOnce({ ...acceptedOrder(), status: 'new' })
        .mockResolvedValue({ ...acceptedOrder(), status: 'canceled' });
      await adapterOn(exitClient({ getOrder }), { cancelConfirmWait: wait }).submitProtectedExit(
        exitRequest(),
      );
      expect(wait.mock.calls).toEqual([[250]]);
    });

    it('waits on a real timer when no wait is injected', async () => {
      const getOrder = vi
        .fn()
        .mockResolvedValueOnce({ ...acceptedOrder(), status: 'new' })
        .mockResolvedValue({ ...acceptedOrder(), status: 'canceled' });

      const ack = await adapterOn(exitClient({ getOrder }), {
        cancelConfirmWaitMs: 5,
      }).submitProtectedExit(exitRequest());

      expect(ack.broker_order_ids).toEqual(['flatten-1']);
    });

    it('holds the next cancel check until the default timer fires', async () => {
      vi.useFakeTimers();
      try {
        const getOrder = vi
          .fn()
          .mockResolvedValueOnce({ ...acceptedOrder(), status: 'new' })
          .mockResolvedValue({ ...acceptedOrder(), status: 'canceled' });
        const pending = adapterOn(exitClient({ getOrder }), {
          cancelConfirmWaitMs: 5,
        }).submitProtectedExit(exitRequest());

        await vi.advanceTimersByTimeAsync(4);
        expect(getOrder).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({ broker_order_ids: ['flatten-1'] });
        expect(getOrder.mock.calls.length).toBeGreaterThan(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('names the missing rearm price exactly and keeps the rejection as the cause', async () => {
      const client = exitClient({
        submitMarketOrder: vi
          .fn()
          .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'rejected' }),
      });

      const error = await caught(
        adapterOn(client).submitProtectedExit(exitRequest({ rearm: undefined })),
      );

      expect(error.message).toBe(
        `submitProtectedExit: the flatten for AAPL (${KEY}) failed with no journalled rearm ` +
          'price available; the position is UNPROTECTED',
      );
      expect(error.cause).toMatchObject({
        message:
          `submitProtectedExit: day flatten '${EXIT}' for AAPL was rejected by Alpaca; ` +
          'protective legs were re-armed inline',
      });
    });

    it('keeps the flatten failure as the cause when the inline re-arm also fails', async () => {
      const client = exitClient({
        submitMarketOrder: vi.fn().mockRejectedValue(new Error('network blip')),
        submitOcoOrder: vi.fn().mockRejectedValue(new Error('venue unavailable')),
      });

      const error = await caught(adapterOn(client).submitProtectedExit(exitRequest()));

      expect(error.cause).toMatchObject({ name: 'BrokerError', operation: 'submitFlatten' });
    });

    it('re-arms a short on the buy side after its buy-to-cover flatten is rejected', async () => {
      const client = exitClient({
        getPositions: vi
          .fn()
          .mockResolvedValue([
            { symbol: 'AAPL', qty: '-6', side: 'short', avg_entry_price: '100' },
          ]),
        submitMarketOrder: vi
          .fn()
          .mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1', status: 'rejected' }),
      });

      await caught(
        adapterOn(client).submitProtectedExit(
          exitRequest({ side: 'buy', rearm: { stop: 105, target: 90 } }),
        ),
      );

      expect(client.submitOcoOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy' }));
    });
  });

  describe('rearmProtectiveLegs edges', () => {
    it('re-arms a short lot with a buy-side OCO', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({}),
        submitOcoOrder: vi.fn().mockResolvedValue(orderAt('r0', `${KEY}:rearm`, { legs: [] })),
      });

      await adapterOn(client).rearmProtectiveLegs(KEY, 'AAPL', 'sell', 6, 105, 90);

      expect(client.submitOcoOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'buy' }));
    });

    it('does not read the entry when no prior re-arm has settled', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({}),
        submitOcoOrder: vi.fn().mockResolvedValue(orderAt('r0', `${KEY}:rearm`, { legs: [] })),
      });

      await adapterOn(client).rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110);

      expect(lookedUp(client)).toEqual([`${KEY}:rearm`]);
    });

    it('names the exhausted wire ids exactly, as an alpaca rearm-unsupported error', async () => {
      const client = makeClient({
        getOrderByClientOrderId: vi.fn(async (id: string) =>
          orderAt(`venue-${id}`, id, { status: 'canceled' }),
        ),
      });

      const error = await caught(
        adapterOn(client).rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110),
      );

      expect(isProtectiveRearmUnsupported(error)).toBe(true);
      expect(error).toMatchObject({ venue: 'alpaca' });
      expect(error.message).toBe(
        `Alpaca adapter exhausted all 4 re-arm wire ids for lot '${KEY}' ` +
          `(${KEY}:rearm .. ${KEY}:rearm-3): each is already owned by an order at the venue ` +
          'that is not protecting this residual, and Alpaca refuses a reused client_order_id ' +
          'permanently (measured, docs/research/43). The residual is NOT protected, and no ' +
          'retry of this call can change that.',
      );
    });
  });

  describe('classifyPriorRearm', () => {
    const resting = (legs: NonNullable<AlpacaOrder['legs']> | null): AlpacaOrder => {
      const order = orderAt('r0', `${KEY}:rearm`, { status: 'new', qty: '6', limit_price: '110' });
      return legs === null ? legless(order) : { ...order, legs };
    };

    it('reads the stop price off the stop leg wherever it sits', () => {
      const legs = [
        leg({ id: 'target', type: 'limit' }),
        leg({ id: 'stop', type: 'stop', stop_price: '95' }),
      ];

      expect(classifyPriorRearm(resting(legs), 6, 95, 110)).toBe('live');
    });

    it('treats a resting order with no legs, no stop leg, or a stop leg without a price as stale', () => {
      expect(classifyPriorRearm(resting(null), 6, 95, 110)).toBe('stale');
      expect(classifyPriorRearm(resting([leg({ type: 'limit' })]), 6, 95, 110)).toBe('stale');
      expect(
        classifyPriorRearm(resting([leg({ type: 'stop', stop_price: null })]), 6, 0, 110),
      ).toBe('stale');
    });

    it('treats a resting order at another target, or with no limit price, as stale', () => {
      const legs = [leg({ type: 'stop', stop_price: '95' })];

      expect(classifyPriorRearm(resting(legs), 6, 95, 111)).toBe('stale');
      expect(classifyPriorRearm({ ...resting(legs), limit_price: null }, 6, 95, 0)).toBe('stale');
    });
  });

  describe('since-floor audit edges', () => {
    function bracketFill(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
      return acceptedOrder({
        status: 'filled',
        filled_qty: '100',
        filled_avg_price: '100.02',
        filled_at: '2026-07-20T15:59:00Z',
        ...overrides,
      });
    }

    async function sweepAfterBracket(fill: AlpacaOrder, logger = recordingLogger()) {
      const adapter = adapterOn(makeClient({ getOrder: vi.fn().mockResolvedValue(fill) }), {
        logger,
        clock: new FixedClock(T0),
      });
      await adapter.submitBracket(makeBracket());
      await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
      return logger.entries.filter((entry) => entry.level === 'warn');
    }

    it('logs the exact predates line', async () => {
      const warns = await sweepAfterBracket(bracketFill());

      expect(warns).toEqual([
        {
          trace_id: SWEEP_TRACE,
          stage: 'execution',
          event: 'alpaca_fill_predates_bracket_submission',
          level: 'warn',
          message: PREDATES_MESSAGE,
          payload: {
            client_order_id: KEY,
            broker_fill_id: 'alpaca-entry-1',
            leg: 'entry',
            instrument: 'AAPL',
            filled_at: '2026-07-20T15:59:00.000Z',
            submitted_at: T0.toISOString(),
          },
        },
      ]);
    });

    it.each([
      ['a zero fill', { filled_qty: '0' }],
      ['an unparseable fill', { filled_qty: 'garbage' }],
      ['a fill exactly at submission', { filled_at: T0.toISOString() }],
    ])('stays silent on %s', async (_label, overrides) => {
      expect(await sweepAfterBracket(bracketFill(overrides))).toEqual([]);
    });

    it.each([
      ['empty', ''],
      ['missing', undefined],
    ])('audits a %s symbol under the unknown instrument', async (_label, symbol) => {
      const warns = await sweepAfterBracket(bracketFill({ symbol: symbol as string }));

      expect(payloadOf(warns, 'instrument')).toEqual(['unknown']);
    });

    it('audits each bracket leg', async () => {
      const warns = await sweepAfterBracket(
        bracketFill({
          filled_at: '2026-07-20T16:01:00Z',
          legs: [
            leg({
              id: 'alpaca-target-1',
              type: 'limit',
              status: 'filled',
              filled_qty: '100',
              filled_avg_price: '110',
              filled_at: '2026-07-20T15:58:00Z',
            }),
          ],
        }),
      );

      expect(payloadOf(warns, 'leg')).toEqual(['target']);
    });

    it('sweeps a bracket whose entry has no legs without a parse failure', async () => {
      const logger = recordingLogger();
      await sweepAfterBracket(legless(bracketFill({ filled_at: T0.toISOString() })), logger);

      expect(logger.entries).toEqual([]);
    });

    it('keeps the first submission time when a bracket is re-submitted', async () => {
      const logger = recordingLogger();
      const clock = new FixedClock(T0);
      const client = makeClient({
        getOrder: vi
          .fn()
          .mockResolvedValue(bracketFill({ filled_at: '2026-07-20T16:05:00Z', legs: [] })),
      });
      const adapter = adapterOn(client, { logger, clock });
      await adapter.submitBracket(makeBracket());
      clock.advance(10 * MINUTE);
      await adapter.submitBracket(makeBracket());

      await adapter.fetchNewFills(new Date(0));

      expect(logger.entries).toEqual([]);
    });

    it('keeps the first submission time when a flatten is re-submitted', async () => {
      const logger = recordingLogger();
      const clock = new FixedClock(T0);
      const client = makeClient({
        submitMarketOrder: vi.fn().mockResolvedValue(orderAt('f1', EXIT)),
        getOrder: vi
          .fn()
          .mockResolvedValue(legless(bracketFill({ id: 'f1', filled_at: '2026-07-20T16:05:00Z' }))),
      });
      const adapter = adapterOn(client, { logger, clock });
      await adapter.submitFlatten('AAPL', 'sell', 6, EXIT);
      clock.advance(10 * MINUTE);
      await adapter.submitFlatten('AAPL', 'sell', 6, EXIT);

      await adapter.fetchNewFills(new Date(0));

      expect(logger.entries).toEqual([]);
    });

    it('forgets a settled flatten submission time, so a later re-use is audited afresh', async () => {
      const logger = recordingLogger();
      const clock = new FixedClock(T0);
      const getOrder = vi
        .fn()
        .mockResolvedValueOnce(bracketFill({ id: 'f1', filled_at: '2026-07-20T16:01:00Z' }))
        .mockResolvedValue(bracketFill({ id: 'f1', filled_at: '2026-07-20T16:05:00Z' }));
      const client = makeClient({
        submitMarketOrder: vi.fn().mockResolvedValue(orderAt('f1', EXIT)),
        getOrder,
      });
      const adapter = adapterOn(client, { logger, clock });
      await adapter.submitFlatten('AAPL', 'sell', 6, EXIT);
      await adapter.fetchNewFills(new Date(0));
      clock.advance(10 * MINUTE);
      await adapter.submitFlatten('AAPL', 'sell', 6, EXIT);

      await adapter.fetchNewFills(new Date(0));

      expect(payloadOf(logger.entries, 'leg')).toEqual(['exit']);
    });
  });

  describe('flatten and re-arm sweeps', () => {
    it('keeps sweeping a flatten the venue still holds open', async () => {
      const client = makeClient({
        submitMarketOrder: vi.fn().mockResolvedValue(orderAt('f1', EXIT)),
        getOrder: vi.fn().mockResolvedValue(orderAt('f1', EXIT, { status: 'accepted' })),
      });
      const adapter = adapterOn(client);
      await adapter.submitFlatten('AAPL', 'sell', 6, EXIT);

      await adapter.fetchNewFills(new Date(0));
      await adapter.fetchNewFills(new Date(0));

      expect(sweptIds(client)).toEqual(['f1', 'f1']);
    });

    async function rearmedSweep(status: string) {
      const logger = recordingLogger();
      const clock = new FixedClock(T0);
      const rearmOrder = orderAt('r0', `${KEY}:rearm`, {
        status,
        legs: [
          leg({
            id: 'r0-stop',
            type: 'stop',
            status: 'filled',
            filled_qty: '6',
            filled_avg_price: '95',
            filled_at: '2026-07-20T15:59:00Z',
          }),
        ],
      });
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({}),
        submitOcoOrder: vi.fn().mockResolvedValue(orderAt('r0', `${KEY}:rearm`, { legs: [] })),
        getOrder: vi.fn(async (id: string) =>
          id === 'r0' ? rearmOrder : acceptedOrder({ legs: [] }),
        ),
      });
      const adapter = adapterOn(client, { logger, clock });
      await adapter.submitBracket(makeBracket());
      await adapter.rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110);
      const first = await adapter.fetchNewFills(new Date(0));
      await adapter.fetchNewFills(new Date(0));
      return { client, first, logger };
    }

    it('collects and audits a re-armed leg fill, then stops sweeping the settled OCO', async () => {
      const { client, first, logger } = await rearmedSweep('filled');

      expect(first).toEqual([
        expect.objectContaining({ client_order_id: KEY, broker_fill_id: 'r0-stop', leg: 'stop' }),
      ]);
      expect(payloadOf(logger.entries, 'leg')).toEqual(['stop']);
      expect(sweptIds(client).filter((id) => id === 'r0')).toHaveLength(1);
    });

    it('keeps sweeping a re-armed OCO the venue still holds open', async () => {
      const { client } = await rearmedSweep('new');

      expect(sweptIds(client).filter((id) => id === 'r0')).toHaveLength(2);
    });

    it('sweeps a re-armed OCO the venue returns without legs as no fills and no failure', async () => {
      const client = makeClient({
        getOrderByClientOrderId: lookupBy({}),
        submitOcoOrder: vi.fn().mockResolvedValue(orderAt('r0', `${KEY}:rearm`, { legs: [] })),
        getOrder: vi.fn(async (id: string) =>
          id === 'r0'
            ? legless(orderAt('r0', `${KEY}:rearm`, { status: 'new' }))
            : acceptedOrder({ legs: [] }),
        ),
      });
      const adapter = adapterOn(client, { clock: new FixedClock(T0) });
      await adapter.submitBracket(makeBracket());
      await adapter.rearmProtectiveLegs(KEY, 'AAPL', 'buy', 6, 95, 110);

      await expect(adapter.fetchNewFills(new Date(0))).resolves.toEqual([]);
    });
  });

  describe('unpriced-fill state failures', () => {
    const observation = {
      client_order_id: KEY,
      broker_fill_id: 'fill-1',
      leg: 'entry' as const,
      instrument: 'AAPL',
      qty: 100,
    };

    it('logs a failed unpriced-fill clear without losing the fills', async () => {
      const logger = recordingLogger();
      const state = new FaultyState();
      state.failing.add('clearUnpricedFill');
      const client = makeClient({
        getOrder: vi.fn().mockResolvedValue(
          acceptedOrder({
            status: 'filled',
            filled_qty: '100',
            filled_avg_price: '100',
            filled_at: '2026-07-20T16:01:00Z',
            legs: [],
          }),
        ),
      });
      const adapter = adapterOn(client, { logger, state, clock: new FixedClock(T0) });
      await adapter.submitBracket(makeBracket());

      const fills = await adapter.fetchNewFills(new Date(0));

      expect(fills).toHaveLength(1);
      expect(payloadOf(logger.entries, 'error')).toEqual(['clearUnpricedFill failed']);
    });

    it('counts a failed unpriced-fill record against the bracket sweep', async () => {
      const state = new FaultyState();
      state.failing.add('recordUnpricedFill');
      const client = makeClient({
        getOrder: vi.fn().mockResolvedValue(unpricedOrder({ legs: [] })),
      });
      const adapter = adapterOn(client, { state });
      await adapter.submitBracket(makeBracket());

      const error = await caught(adapter.fetchNewFills(new Date(0)));

      expect((error as AggregateError).errors).toEqual([new Error('recordUnpricedFill failed')]);
      expect(error.message).toContain('(1 bracket(s), 0 flatten(s), 0 rearm(s)');
    });

    it('surfaces a failed unpriced-fill load', async () => {
      const state = new FaultyState();
      state.failing.add('loadUnpricedFills');

      const error = await caught(adapterOn(makeClient(), { state }).fetchNewFills(new Date(0)));

      expect((error as AggregateError).errors).toEqual([new Error('loadUnpricedFills failed')]);
    });

    it('surfaces a failed alerted mark after the alert went out', async () => {
      const state = new FaultyState();
      state.recordUnpricedFill('alpaca', observation, new Date(T0.getTime() - 20 * MINUTE));
      state.failing.add('markUnpricedFillAlerted');
      const alerts = recordingAlerts();

      const error = await caught(
        adapterOn(makeClient(), {
          state,
          unpricedFillAlerts: alerts,
          clock: new FixedClock(T0),
        }).fetchNewFills(new Date(0)),
      );

      expect(alerts.posted).toHaveLength(1);
      expect((error as AggregateError).errors).toEqual([
        new Error('markUnpricedFillAlerted failed'),
      ]);
    });

    it('names a failed unpriced-fill alert exactly', async () => {
      const state = new InMemoryBrokerStateStore();
      state.recordUnpricedFill('alpaca', observation, new Date(T0.getTime() - 20 * MINUTE));

      const error = await caught(
        adapterOn(makeClient(), {
          state,
          unpricedFillAlerts: {
            postUnpricedFillAlert: async () => {
              throw new Error('telegram down');
            },
          },
          clock: new FixedClock(T0),
        }).fetchNewFills(new Date(0)),
      );

      expect((error as AggregateError).errors).toEqual([
        new Error(
          `Alpaca unpriced-fill alert delivery failed for order fill-1 (entry leg of '${KEY}')`,
        ),
      ]);
    });
  });

  it('paces with an alpaca-named default bucket that logs its waits', async () => {
    vi.useFakeTimers();
    try {
      const logger = recordingLogger();
      const adapter = new AlpacaBrokerAdapter({
        client: makeClient({ getPositions: vi.fn().mockResolvedValue([]) }),
        unpricedFillAlerts: recordingAlerts(),
        logger,
      });

      const reads = Array.from({ length: 45 }, () => adapter.getOpenPositions());
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(reads);

      const buckets = payloadOf(logger.entries, 'bucket');
      expect(buckets.length).toBeGreaterThan(0);
      expect(new Set(buckets)).toEqual(new Set(['alpaca']));
    } finally {
      vi.useRealTimers();
    }
  });
});
