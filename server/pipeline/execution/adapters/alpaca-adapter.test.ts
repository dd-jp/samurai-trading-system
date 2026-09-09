import type { MarketDataService } from '../../../providers/market-data-service/index.js';
import type { OrderIntent } from '../../../shared/index.js';
import { type Clock, TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import type { CostModel } from '../../../tools/backtest/index.js';
import type { VerdictDecision } from '../../verdict/index.js';
import { BrokerError } from '../broker-error.js';
import { InMemoryBrokerStateStore } from '../broker-state-store.js';
import { ExecutionImpl } from '../execute.js';
import { FilledZeroSizeThrottle } from '../filled-zero-size-throttle.js';
import type { OcoDoubleFillAlert, OcoDoubleFillAlertChannel } from '../oco-double-fill-alert.js';
import { openTestExecutionStore } from '../sqlite-store-harness.js';
import type { ExecutionConfig, ExecutionInput, NativeBracketRequest } from '../types.js';
import type { UnpricedFillAlert, UnpricedFillAlertChannel } from '../unpriced-fill-alert.js';
import { AlpacaBrokerAdapter, DEFAULT_UNPRICED_FILL_AGE_OUT_MS } from './alpaca-adapter.js';
import type { AlpacaBrokerClient, AlpacaOrder } from './alpaca-client.js';
import { AlpacaHttpBrokerClient } from './alpaca-http-client.js';

/**
 * These tests are about bracket submission and fill normalization, not
 * pacing — a permissive bucket keeps them off the wall clock regardless of how
 * many calls a case makes. The pacing itself is asserted at the bottom of this
 * file and in `shared/http/token-bucket.test.ts`.
 */
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
    // The two members this double never declared. `getOrderByClientOrderId`
    // rejects rather than resolving null: the port documents null as
    // "Alpaca AUTHORITATIVELY knows no such order", which reconcile acts on by
    // marking a lot `rejected`. A default that answered null would let a test
    // that reaches this path silently assert the position was never placed.
    getOrderByClientOrderId: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override getOrderByClientOrderId to use it')),
    getAccount: vi.fn().mockRejectedValue(new Error('makeClient: override getAccount to use it')),
    // #429's three. Rejecting by default for `getOrderByClientOrderId`'s
    // reason: a flatten or a cancel that quietly resolved would let a test
    // assert an intervention happened when nothing was asked of the venue.
    submitMarketOrder: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override submitMarketOrder to use it')),
    // #525's re-arm path — same "reject unless overridden" posture as the
    // other intervention-path methods above: a test that reaches this
    // without overriding it is asserting a re-arm happened when nothing was
    // asked of the venue.
    submitOcoOrder: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override submitOcoOrder to use it')),
    // #586's two plain crypto order types — same posture again: the emulated
    // path submitting an order no test asked for must fail that test.
    submitLimitOrder: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override submitLimitOrder to use it')),
    submitStopLimitOrder: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override submitStopLimitOrder to use it')),
    cancelOrder: vi.fn().mockRejectedValue(new Error('makeClient: override cancelOrder to use it')),
    getPositions: vi
      .fn()
      .mockRejectedValue(new Error('makeClient: override getPositions to use it')),
    ...overrides,
  };
}

/**
 * The operator escalation port (#298), recording what would have reached a
 * human. Every adapter in this file gets one: the seam is required precisely so
 * that a construction which forgets it cannot exist.
 */
function recordingAlerts(): UnpricedFillAlertChannel & { readonly posted: UnpricedFillAlert[] } {
  const posted: UnpricedFillAlert[] = [];
  return {
    posted,
    postUnpricedFillAlert: async (alert) => {
      posted.push(alert);
    },
  };
}

/**
 * #586's required seam, same reasoning as `recordingAlerts` above: a
 * construction that forgets the double-fill escalation cannot exist.
 */
function recordingDoubleFillAlerts(): OcoDoubleFillAlertChannel & {
  readonly posted: OcoDoubleFillAlert[];
} {
  const posted: OcoDoubleFillAlert[] = [];
  return {
    posted,
    postOcoDoubleFillAlert: async (alert) => {
      posted.push(alert);
    },
  };
}

/** Ages a fill without sleeping — the age-out is minutes long by design. */
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

/** An order the venue reports filled and will not price — #298's whole subject. */
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });

    await adapter.submitBracket(makeBracket());

    expect(client.submitOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      side: 'buy',
      qty: '100',
      // #983: emitted at the venue's tick precision, not `String(number)`.
      limit_price: '100.00',
      time_in_force: 'day',
      client_order_id: 'key-aapl-1355',
      order_class: 'bracket',
      take_profit: { limit_price: '110.00' },
      stop_loss: { stop_price: '95.00' },
    });
  });

  /**
   * #983, the shape the venue ACTUALLY refused on 2026-09-01. A whole-share
   * SPY short whose only defect was price precision came back
   * `422 {"code":42210000,"message":"invalid limit_price 762.335. sub-penny
   * increment does not fulfill minimum pricing criteria"}`. Both live
   * rejections that day were shorts, so this is the branch on the live path.
   */
  it('rounds a sub-penny short bracket onto the venue price grid (#983)', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
        // Entry UP: a short's limit is the least it will accept.
        limit_price: '762.34',
        // Stop DOWN: above the entry on a short, so down is a SMALLER loss —
        // rounding must never hand back exposure the Risk Manager removed.
        stop_loss: { stop_price: '766.40' },
        // Target UP: below the entry, so up is the earlier fill.
        take_profit: { limit_price: '754.19' },
      }),
    );
  });

  /**
   * The journal has to hold what was SENT, not what the caller asked for. A
   * restart rehydrates this row to re-place the leg; journalling the
   * unrounded prices would reproduce the same 422 across the restart, and
   * leave the re-arm comparison unable to match the venue's rounded copy.
   */
  it("journals the ROUNDED request, not the caller's unrounded one (#983)", async () => {
    const client = makeClient();
    const state = new InMemoryBrokerStateStore();
    const saveBracket = vi.spyOn(state, 'saveBracket');
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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

  // #586: a crypto bracket must NEVER reach `submitOrder`'s native
  // `order_class: 'bracket'` — the live venue rejects every advanced order
  // class for crypto (422 code 42210000, verified #550). The emulated path
  // sends a PLAIN limit entry instead, in slash form (#585) and with no
  // order class at all; the protective prices go to the journal, not the
  // wire, until the entry fills.
  it('submits a crypto bracket as a PLAIN limit entry, never order_class bracket', async () => {
    const submitLimitOrder = vi.fn().mockResolvedValue(acceptedOrder({ id: 'entry-1', legs: [] }));
    const client = makeClient({ submitLimitOrder });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });

    const ack = await adapter.submitBracket(
      makeBracket({
        client_order_id: 'key-btc-1',
        instrument: 'BTC-USD',
        asset_class: 'crypto',
        size: 0.5,
        entry: 60_000,
        stop: 57_000,
        target: 66_000,
        time_in_force: 'gtc',
      }),
    );

    // The exact wire body, pinned: no `order_class`, no `take_profit`, no
    // `stop_loss` — any of those is the guaranteed 422.
    expect(submitLimitOrder).toHaveBeenCalledWith({
      symbol: 'BTC/USD',
      side: 'buy',
      qty: '0.5',
      limit_price: '60000',
      time_in_force: 'gtc',
      client_order_id: 'key-btc-1',
    });
    expect(client.submitOrder).not.toHaveBeenCalled();
    // Only the entry exists at ack time — the leg ids appear when the sweep
    // arms them; inventing two the venue never heard of would be a lie.
    expect(ack).toEqual({
      client_order_id: 'key-btc-1',
      broker_order_ids: ['entry-1'],
      order_state: 'submitted',
    });
  });

  // #585: a symbol already in Alpaca's own slash form must pass through
  // unmangled — not re-converted into something like 'BTC//USD'. Nothing in
  // this repo submits an already-slash-form instrument today (the universe
  // only ever produces dash form), but the conversion function is a plain
  // string transform with no memory of what called it, so this pins that it
  // stays a no-op on input it has no work to do on.
  it('does not double-convert a symbol already in Alpaca slash form', async () => {
    const submitLimitOrder = vi.fn().mockResolvedValue(acceptedOrder({ id: 'entry-1', legs: [] }));
    const client = makeClient({ submitLimitOrder });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });

    await adapter.submitBracket(
      makeBracket({ client_order_id: 'key-btc-2', instrument: 'BTC/USD', asset_class: 'crypto' }),
    );

    expect(submitLimitOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/USD' }));
  });

  it('acks with the parent + attached OCO leg ids and a submitted state', async () => {
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient(),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });

    const ack = await adapter.submitBracket(makeBracket());

    expect(ack.order_state).toBe(orderState);
  });
});

describe('AlpacaBrokerAdapter.fetchNewFills', () => {
  // The sweep awaits `getOrder` per bracket, so a `submitBracket` landing
  // mid-pass would otherwise be picked up by that same pass — whose `since`
  // window predates it, dropping its fills (PR #290 review, deepseek; the
  // same fix #297 applied to ccxt's `syncBrackets`).
  it('does not poll a bracket submitted while the pass is already in flight', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    (client.getOrder as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // A concurrent submission mutates the bracket map mid-iteration.
      await adapter.submitBracket(makeBracket({ client_order_id: 'key-tsla-1400' }));
      return acceptedOrder();
    });

    await adapter.fetchNewFills(new Date(0));

    // One getOrder: the pass's worklist was fixed at entry, not re-read.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
        // #842: Alpaca reports a running per-order total, flagged for
        // `ingestFills()` so a later, larger observation books the increment.
        qty_is_cumulative: true,
      },
    ]);
  });

  /**
   * #842's OTHER guard. Alpaca's own documentation does not settle whether
   * `filled_at` is populated on the FIRST partial fill or only once an order
   * is COMPLETELY filled — the field carries no description at all in the
   * docs source that generates the Order entity table
   * (alpacahq/alpaca-docs `data/webapi/entities/order-v2.yaml`) or in either
   * OpenAPI spec, and there is no `partially_filled` example payload anywhere
   * in the docs repo to settle it by example. The one indirect signal (the
   * trade_updates stream distinguishing `fill`, "completely filled", from
   * `partial_fill`) points toward "filled means COMPLETELY", i.e. toward a
   * partial reporting a positive `filled_qty` with a null `filled_at`.
   *
   * Under the old guard that combination was dropped silently, every poll,
   * forever — the same money-losing ending as the `hasFill` dedup, reached by
   * a different door. Fixed defensively while the docs cannot rule it out.
   */
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
        // Never EARLIER than the real fill, so `advanceLot`'s no-lookahead
        // filter cannot be tricked into seeing a fill ahead of simulated T.
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
      // The venue's SECOND word on the SAME order — a running total, not a
      // second fill event, and under the same order id. Nothing about the
      // wire shape distinguishes it from a duplicate; only the flag does.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    const first = await adapter.fetchNewFills(new Date(0));
    const second = await adapter.fetchNewFills(new Date(0));

    expect(first).toEqual([expect.objectContaining({ broker_fill_id: 'alpaca-entry-1', qty: 50 })]);
    // The bracket is NOT pruned on a terminal status the way `flattens` is,
    // so the terminating observation is still swept — which is what gives
    // `ingestFills()` the chance to book that last 30.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });

    expect(await adapter.fetchNewFills(new Date(0))).toEqual([]);
    expect(client.getOrder).not.toHaveBeenCalled();
  });
});

describe('AlpacaBrokerAdapter integration: entry fill then stop-out', () => {
  // Alpaca's bracket order gives native OCO exit semantics: once the stop
  // leg fills, the venue cancels the sibling target leg itself — this
  // adapter only needs to normalize what `getOrder` reports, not emulate
  // the cancellation. Full ClosedTrade emission is #83's `ingestFills()`
  // (not yet built); this test proves the adapter-level fill normalization
  // that #83 will consume, across the round trip from submit to stop-out.
  it('normalizes the entry fill, then the stop fill, as the position round-trips to flat', async () => {
    const entryFilledAt = '2026-07-15T14:05:00Z';
    const stopFilledAt = '2026-07-15T16:30:00Z';

    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
        // #842: Alpaca reports a running per-order total, flagged for
        // `ingestFills()` so a later, larger observation books the increment.
        qty_is_cumulative: true,
      },
    ]);

    // The stop leg fills; Alpaca's native OCO has already cancelled the
    // sibling target leg venue-side by the time this poll observes it.
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
        // #842: Alpaca reports a running per-order total, flagged for
        // `ingestFills()` so a later, larger observation books the increment.
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
    // The one construction in this file that had forgotten `unpricedFillAlerts`
    // — the very thing the port comment above says "cannot exist".
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter,
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });

    await adapter.submitBracket(makeBracket());
    await adapter.fetchNewFills(new Date(0));

    // submitOrder + the per-bracket getOrder poll — an unpaced call would show
    // up here as a client call the limiter never saw.
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('never lets a venue error carry its HTTP context out of the adapter', async () => {
    // Alpaca's REST errors quote the failed request, API-key header included,
    // and execute() copies a thrown message into a logged ExecutionResult.reason.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
        ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
        logger: recordingLogger(),
      });

      const error = await adapter.submitBracket(makeBracket()).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BrokerError);
      expect((error as BrokerError).venueCode).toBe('42210000');
      // #1003: the venue's own diagnostic message is now also captured, via
      // the dedicated (allowlisted, length-bounded) `venueMessage` field —
      // NOT the client's raw `.message`, which is exactly what this test used
      // to assert stayed OUT of `BrokerError`. That credential-safety
      // boundary is unchanged; what changed is that Alpaca's parsed `message`
      // field is now curated in, the same way `code` already was.
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
  // Corrected by #524's review (deepseek): this test used to assert that
  // `fetchNewFills` THROWS here (an AggregateError, caught below). That was
  // pinning a bug, not a feature — refusing to BOOK an unpriced fill as a
  // real Fill is correct (recording price 0 would be a phantom fill), but
  // failing the WHOLE sweep over it is not: an unpriced fill is #298's
  // modelled, expected condition (the age-out clock in the `catch` below
  // starts either way), not a failure, and the bracket loop's own "skipped,
  // not swallowed... retried on the next one" comment already said so
  // before the code below it contradicted it. The old assertion's own
  // comment reasoned "the only bracket is the bad one, so nothing is lost by
  // throwing" — true in THIS test's single-bracket setup, but the general
  // behaviour it pinned threw on ANY all-unpriced sweep, which silently
  // drops every OTHER bracket's and flatten's fills too when one happens to
  // land unpriced in the same poll (see `alpaca-adapter.test.ts`'s
  // `still collects a healthy bracket fill in the same poll as an unpriced
  // flatten` for that case).
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());

    // Not booked (an empty array, same as "nothing new"), and not thrown —
    // retried next poll, exactly like an order the venue has not reported
    // on at all yet.
    await expect(adapter.fetchNewFills(new Date(0))).resolves.toEqual([]);
  });

  it('refuses an unparseable filled_qty rather than booking NaN', async () => {
    // `NaN <= 0` is false, so without an explicit finite check this sails past
    // the "nothing filled" guard and is recorded as `qty: NaN`, which poisons
    // weighted-average pricing and realized PnL without ever failing loudly.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
    // The regression this guards: `ingestFills()` awaits fetchNewFills ONCE
    // before advancing any lot, and `brackets` iterates in insertion order, so
    // an unhandled throw on the FIRST bracket would abort ingestion for the
    // whole account — stop-outs on every later bracket included.
    const filledAt = '2026-07-15T15:00:00Z';
    const client = makeClient({
      getOrder: vi
        .fn()
        // Submitted first, so it is swept first — the starvation position.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket({ client_order_id: 'poisoned-lot' }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'healthy-lot' }));

    const fills = await adapter.fetchNewFills(new Date(0));

    // The healthy lot still ingests; the poisoned one contributes nothing and
    // is retried next sweep (dedup on broker_fill_id makes that free).
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'healthy-lot', qty: 50, price: 100.02 });
  });
});

/**
 * #609: `fetchNewFills` accumulated `failures` but discarded them whenever
 * the same sweep also read a fill from another source — `fills.length > 0`
 * skipped the throw gate entirely, and nothing else in this file ever logged
 * the array. Fixed by giving `AlpacaBrokerAdapterInput` a required `Logger`
 * (the same port-level decision #573 made on `ExecutionInput`) and logging
 * every accumulated failure, unconditionally, before that gate runs.
 */
describe('AlpacaBrokerAdapter.fetchNewFills failure logging (#609)', () => {
  it('logs a per-source failure even when another source in the same sweep produced a fill', async () => {
    const client = makeClient({
      getOrder: vi
        .fn()
        // Swept first (insertion order): a genuine fill.
        .mockResolvedValueOnce(
          acceptedOrder({
            id: 'alpaca-healthy',
            status: 'filled',
            filled_qty: '50',
            filled_avg_price: '100.02',
            filled_at: '2026-07-15T15:00:00Z',
          }),
        )
        // Swept second: an unparseable filled_qty is a genuine failure (a
        // plain Error, not the modelled/expected UnpricedFillError), so it
        // lands in `failures` — this is the exact "source A fills, source B
        // fails in the SAME sweep" shape #609 was filed against.
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
    // #1123: a clock reading before either fill's `filled_at`, so the new
    // since-floor invariant audit stays quiet here — this test is about #609's
    // per-source failure logging, not #1123's separate check.
    const clock = new FixedClock(new Date('2026-07-15T14:00:00Z'));
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket({ client_order_id: 'healthy-lot' }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'broken-lot' }));

    const fills = await adapter.fetchNewFills(new Date(0));

    // The healthy lot's fill is still returned — this ticket does not change
    // that — but before #609 the broken lot's failure was silently dropped
    // right here, precisely because a fill was also read this sweep.
    expect(fills).toHaveLength(1);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'error',
      message: 'Alpaca fetchNewFills: per-source failure',
      payload: {
        error: expect.stringMatching(/unparseable filled_qty 'N\/A'/),
        // fills_read > 0 is the #609 shape itself: a source failed in the
        // SAME sweep that also read a fill, the exact case the throw gate
        // (`fills.length === 0 && failures.length > 0`) never sees.
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
    // #1123: a clock reading before `filled_at`, same reason as the test above.
    const clock = new FixedClock(new Date('2026-07-15T14:00:00Z'));
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(1);
    expect(logger.entries).toEqual([]);
  });

  // #524: an unpriced fill with a working journal is the MODELLED, expected
  // condition — the age-out clock, not a failure — and is deliberately never
  // pushed to `failures` (see the bracket loop's own comment on that). This
  // is the quiet path that actually matters in production (far more common
  // than a spotless sweep): if this ever starts logging, #524's "an unpriced
  // fill is not a failure" decision has been silently reversed at the log
  // layer this ticket adds.
  it('logs nothing for an unpriced fill with a working journal (#524, not a #609 failure)', async () => {
    const logger = recordingLogger();
    const client = makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) });
    // #1123: a clock reading before `unpricedOrder`'s `filled_at`, same reason
    // as the two tests above.
    const clock = new FixedClock(new Date('2026-07-15T14:00:00Z'));
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toHaveLength(0);
    expect(logger.entries).toEqual([]);
  });
});

/**
 * #1123: the Alpaca since-floor invariant audit. `ingest-fills.ts`'s global
 * `since` floor is only correct if no fill is ever dated earlier than the
 * `opened_at` of the lot it belongs to (#1096 fixed a violation of this in
 * `SimulatedBrokerAdapter`). This adapter has no access to the true
 * `opened_at` — `execute.ts` reads it, not this adapter — so these assert
 * against the local proxy this ticket adds instead: `bracketSubmittedAt`, a
 * clock read taken before `submitBracket`'s POST. `execute.ts` reads
 * `opened_at` BEFORE calling `submitBracket` at all, so `opened_at <=
 * bracketSubmittedAt`, not the reverse — the check built on it is a superset
 * test (never misses a real violation on a self-submitted bracket, but a
 * benign fill in `[opened_at, bracketSubmittedAt)` can still trip it; see
 * `bracketSubmittedAt`'s doc in alpaca-adapter.ts).
 */
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
          // Earlier than T0, the clock read at submission time below.
          filled_at: '2026-07-20T15:59:00Z',
        }),
      ),
    });
    const adapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    const fills = await adapter.fetchNewFills(new Date(0));

    // Flagged, not clamped: the fill is still booked at its reported date.
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
    // `brackets` is never pruned, so a genuinely violating bracket is
    // re-polled forever — without a throttle this would warn on every one
    // of these sweeps, not just the first.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    await adapter.fetchNewFills(new Date(0));
    await adapter.fetchNewFills(new Date(0));
    await adapter.fetchNewFills(new Date(0));

    expect(logger.entries).toHaveLength(1);
  });

  // #1123 round-1 review: `rearmedLegs` (the re-arm sweep) is keyed by the
  // LOT's own `idempotency_key` — the SAME key space `bracketSubmittedAt`
  // uses — so the original bracket's submission-time bound applies here too,
  // with no new map. The flatten sweep is NOT covered: `flattens` is keyed by
  // the EXIT's own idempotency_key, a different value, so auditing it needs
  // its own bound (tracked as a follow-up, out of scope here).
  //
  // #1123 round-2 review (F1): this test ALSO makes the ORIGINAL bracket
  // entry a violation, not just the re-armed leg — the exact scenario the
  // reviewer proved broken with a lot-only throttle key: the entry leg is
  // polled first and warns, and a lot-only `warnedSinceFloorViolations` key
  // then silently swallowed the re-armed target's OWN, different violation.
  // Both must warn — this is the regression test for the `clientOrderId:leg`
  // composite key.
  it('warns on BOTH the entry leg and a re-armed leg of the same lot, each once, when both violate', async () => {
    const clock = new FixedClock(T0);
    const logger = recordingLogger();
    const submitOcoOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-venue-id', legs: [] });
    const getOrderByClientOrderId = vi.fn().mockResolvedValue(null); // no prior to adopt
    const violatingFill = {
      status: 'filled' as const,
      filled_qty: '100',
      filled_avg_price: '100.02',
      // Earlier than T0, the clock read at the ORIGINAL bracket's
      // submission — the re-arm itself has no submission-time proxy of its
      // own, and shares the lot's original bound instead.
      filled_at: '2026-07-20T15:59:00Z',
      legs: [],
    };
    // id-aware: BOTH the original bracket entry ('alpaca-entry-1') and the
    // re-armed OCO ('rearm-venue-id') violate here.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());
    // `side` is the lot's HELD side (matches `makeBracket`'s 'buy'), so stop
    // below / target above, same ordering as the bracket itself.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());

    await adapter.fetchNewFills(new Date(0));

    expect(logger.entries).toEqual([]);
  });

  // The regression this design exists to prevent: `brackets` is never pruned
  // (see its own doc comment), so a long-closed bracket is re-polled every
  // sweep and would trip the OLD, global `since` floor constantly once
  // `since` has moved on to newer lots — that is noise, not a genuine
  // per-lot violation, and must not warn.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
    });
    await adapter.submitBracket(makeBracket());
    await adapter.fetchNewFills(new Date(0));

    // A later sweep, `since` now well past this bracket's own fill —
    // `brackets` is never pruned, so it is polled again regardless.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
      clock,
      state,
    });
    await firstProcessAdapter.submitBracket(makeBracket());

    // Simulate a restart: a fresh adapter over the same durable state has no
    // in-memory `bracketSubmittedAt` entry for this bracket, only `brackets`
    // (restored from `state.loadBrackets`).
    const logger = recordingLogger();
    const client = makeClient({
      getOrder: vi.fn().mockResolvedValue(
        acceptedOrder({
          status: 'filled',
          filled_qty: '100',
          filled_avg_price: '100.02',
          // Earlier than T0 — would warn if this bracket had a local proxy.
          filled_at: '2026-07-20T15:00:00Z',
        }),
      ),
    });
    const recoveredAdapter = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger,
      clock,
      state,
    });

    await recoveredAdapter.fetchNewFills(new Date(0));

    expect(logger.entries).toEqual([]);
  });
});

/**
 * #298. Refusing to book an unpriced fill is right; refusing forever in silence
 * is not. If Alpaca never prices the fill, the lot stays under-filled, its stop
 * is never resized to the real quantity, no `ClosedTrade` is emitted, and — the
 * part these tests are about — nothing tells anyone. During a 14-day unattended
 * soak (#238) that is an invisible stuck lot.
 */
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
      clock: options.clock,
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.ageOutMs === undefined ? {} : { unpricedFillAgeOutMs: options.ageOutMs }),
    });
    await adapter.submitBracket(makeBracket());
    return adapter;
  }

  it('stays quiet while the venue is only briefly behind', async () => {
    // The common case, and the reason skipping is the right default: the poll
    // feed is inclusive of `since`, so a transiently-unpriced fill is re-offered
    // priced within a poll or two. Paging on that would be noise.
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

    // First sighting starts the clock; nothing is due yet.
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    expect(alerts.posted).toEqual([]);

    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted).toEqual([
      {
        venue: 'alpaca',
        client_order_id: 'key-aapl-1355',
        // The venue order id, the symbol and the quantity are what makes this
        // actionable: an operator has to find this order on Alpaca's dashboard.
        broker_fill_id: 'alpaca-entry-1',
        leg: 'entry',
        instrument: 'AAPL',
        qty: 100,
        first_seen_at: T0,
        unpriced_for_ms: DEFAULT_UNPRICED_FILL_AGE_OUT_MS,
        age_out_ms: DEFAULT_UNPRICED_FILL_AGE_OUT_MS,
      },
    ]);

    // A permanent venue anomaly must not page every 15 seconds for the rest of
    // the soak — which is what "do not silently retry forever" cuts both ways on.
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS * 4);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    expect(alerts.posted).toHaveLength(1);
  });

  it('names the bracket parent symbol for an unpriced protective leg', async () => {
    // `AlpacaOrderLeg` carries no `symbol` of its own, so an alert built from
    // the leg alone could not say what instrument is stuck.
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

  // #585: the venue reports a crypto bracket's own symbol back in slash
  // form. This is the one place that symbol becomes externally observable
  // (a `NormalizedFill` carries no `instrument` field at all) — so this is
  // where the read-back conversion is pinned: the operator-facing alert must
  // read 'BTC-USD', never Alpaca's wire 'BTC/USD', matching what the rest of
  // the system (and the operator) calls this instrument everywhere else.
  it('converts a crypto bracket symbol back to dash form for an unpriced-fill alert', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const adapter = await submitAndSweep({
      clock,
      alerts,
      client: makeClient({
        getOrder: vi.fn().mockResolvedValue(unpricedOrder({ symbol: 'BTC/USD' })),
      }),
    });

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted[0]).toMatchObject({ instrument: 'BTC-USD' });
  });

  // #585: same read-back conversion, through the FLATTEN sweep rather than
  // the bracket one — a separate code path in `fetchNewFills` with its own
  // `symbolOf` call.
  it('converts a crypto flatten symbol back to dash form for an unpriced-fill alert', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const submitMarketOrder = vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' });
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient({
        submitMarketOrder,
        getOrder: vi
          .fn()
          .mockResolvedValue(unpricedOrder({ id: 'flatten-1', symbol: 'BTC/USD', legs: [] })),
      }),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: alerts,
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
      clock,
    });
    await adapter.submitFlatten('BTC-USD', 'sell', 0.5, 'flatten-key');

    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted[0]).toMatchObject({ instrument: 'BTC-USD', leg: 'exit' });
  });

  // #586: the EMULATED crypto sweep's unpriced-fill posture — a stop leg the
  // venue reports filled but will not price is recorded and escalated under
  // the lot's own dash-form instrument, exactly as the native sweeps do.
  // (Crypto no longer reaches the equity re-arm sweep this test used to
  // exercise; the emulation names the instrument from its own journalled
  // request, so no read-back conversion is even needed.)
  it('escalates an unpriced emulated stop-leg fill under the dash-form instrument (#586)', async () => {
    const clock = new FixedClock(T0);
    const alerts = recordingAlerts();
    const submitLimitOrder = vi.fn(async (request: { client_order_id: string }) =>
      acceptedOrder({
        id: request.client_order_id === 'key-1' ? 'entry-1' : 'target-1',
        legs: [],
      }),
    );
    const submitStopLimitOrder = vi
      .fn()
      .mockResolvedValue(acceptedOrder({ id: 'stop-1', legs: [] }));
    const getOrder = vi.fn(async (id: string) => {
      if (id === 'entry-1') {
        return acceptedOrder({
          id: 'entry-1',
          symbol: 'BTC/USD',
          status: 'filled',
          filled_qty: '0.5',
          filled_avg_price: '60000',
          filled_at: '2026-07-15T14:05:00Z',
          legs: [],
        });
      }
      if (id === 'stop-1') {
        return unpricedOrder({ id: 'stop-1', symbol: 'BTC/USD', filled_qty: '0.5', legs: [] });
      }
      return acceptedOrder({ id, symbol: 'BTC/USD', legs: [] });
    });
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient({ submitLimitOrder, submitStopLimitOrder, getOrder }),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: alerts,
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
      clock,
    });
    await adapter.submitBracket(
      makeBracket({
        client_order_id: 'key-1',
        instrument: 'BTC-USD',
        asset_class: 'crypto',
        size: 0.5,
        time_in_force: 'gtc',
      }),
    );

    // Sweep 1: the entry fill is observed and the two plain legs are armed.
    await adapter.fetchNewFills(new Date(0));
    // Sweep 2: the stop leg reports filled-but-unpriced — recorded, not booked.
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS);
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted[0]).toMatchObject({ instrument: 'BTC-USD', leg: 'stop' });
  });

  it('escalates even on a sweep that other brackets are filling normally', async () => {
    // The path that would otherwise hide it: with any healthy fill in the sweep
    // the aggregate throw is skipped and the failure list is discarded, so the
    // escalation cannot be hung off the failure path.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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

    // The venue catches up one poll later — the transient case.
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

    // Long past the threshold measured from the FIRST sighting: a resolved
    // anomaly must not keep ticking towards an alert nobody needs.
    clock.advance(DEFAULT_UNPRICED_FILL_AGE_OUT_MS * 2);
    await adapter.fetchNewFills(new Date(0));

    expect(alerts.posted).toEqual([]);
  });

  it('retries delivery instead of recording an alert nobody received', async () => {
    // "Do not silently give up": a channel outage at the moment the age-out
    // fires must not consume the one alert this fill ever gets.
    const clock = new FixedClock(T0);
    const state = new InMemoryBrokerStateStore();
    const failing: UnpricedFillAlertChannel = {
      postUnpricedFillAlert: async () => {
        // Realistically shaped: a transport error quotes the request it failed
        // on, which is why the adapter must not re-throw or attach it.
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

    // A second adapter over the SAME state — the channel is fixed, the row is
    // still owed an alert, and the clock still reads from the first sighting.
    const alerts = recordingAlerts();
    const recovered = new AlpacaBrokerAdapter({
      client: makeClient({ getOrder: vi.fn().mockResolvedValue(unpricedOrder()) }),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: alerts,
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
      state,
      clock,
    });

    await recovered.fetchNewFills(new Date(0)).catch(() => undefined);

    expect(alerts.posted).toHaveLength(1);
    expect(state.loadUnpricedFills('alpaca')[0]?.alerted_at).toEqual(clock.now());
  });

  it('survives a journal write failure rather than starving the whole sweep', async () => {
    // The age-out journal write runs INSIDE the per-bracket catch, so an
    // unguarded throw there escapes the isolation entirely: one venue anomaly
    // plus one transient DB error would abort ingestion for every OTHER bracket
    // in the account, stop-outs included. Found while writing these tests.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
    // A Telegram transport error quotes the URL it failed on, and that URL
    // carries the bot token — `BrokerError`'s posture applies here too.
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

  // #524 review (deepseek): before this fix, an UnpricedFillError counted as
  // a sweep failure in BOTH the bracket loop and the flatten loop (#517
  // faithfully mirrored the bracket loop's own pre-existing behaviour) —
  // contradicting the bracket catch's own "skipped, not swallowed" comment.
  // On a poll where an unpriced fill was the ONLY new activity, that made
  // the whole `fetchNewFills` call throw, which `ingestFills()` never
  // catches per-order — nothing from ANY bracket or flatten got persisted
  // that poll, not just the unpriced one's. This is the fix, proved for the
  // flatten sweep specifically (the bracket-only version of this failure
  // mode already existed before #517; the tests above tolerate it via
  // `.catch(() => undefined)` because their own assertions are about the
  // age-out mechanism, not the throw).
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    await adapter.submitBracket(makeBracket());
    await adapter.submitFlatten('TSLA', 'sell', 5, 'flatten-key');

    const fills = await adapter.fetchNewFills(new Date(0));

    // The bracket's entry fill made it through untouched — the unpriced
    // flatten cost the sweep nothing beyond its own contribution.
    expect(fills).toEqual([
      {
        client_order_id: 'key-aapl-1355',
        broker_fill_id: 'alpaca-entry-1',
        leg: 'entry',
        price: 100.02,
        qty: 100,
        fee: 0,
        timestamp: new Date(filledAt),
        // #842: Alpaca reports a running per-order total, flagged for
        // `ingestFills()` so a later, larger observation books the increment.
        qty_is_cumulative: true,
      },
    ]);
  });
});

/**
 * #429 — the intervention path. ADR-0007 removed the human approval gate, so
 * an operator watching a position they disliked had no way to cancel a working
 * order or flatten a lot; the only remaining stop was a set of circuit breakers
 * three of which could not fire.
 */
describe('AlpacaBrokerAdapter — intervention path (#429)', () => {
  function adapterWith(client: AlpacaBrokerClient): AlpacaBrokerAdapter {
    return new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      // The one TIF Alpaca accepts for a market order on BOTH venues, and the
      // right semantics for an emergency exit: fill now, leave nothing resting.
      time_in_force: 'ioc',
      client_order_id: 'flatten-key',
    });
    expect(ack.client_order_id).toBe('flatten-key');
    expect(ack.broker_order_ids).toEqual(['flatten-1']);
  });

  // #585: `submitFlatten` receives only a bare `instrument` string — no
  // `asset_class` alongside it on the `BrokerAdapter` interface — so this
  // site cannot ask, unlike `submitBracket`. It falls back to a syntactic
  // rule instead: DEFAULT_UNIVERSE/SMOKE_TEST_UNIVERSE (orchestrator/
  // scheduler.ts, orchestrator/production.ts) spell every crypto instrument
  // as '<BASE>-USD' and every equity as a bare ticker with no separator at
  // all, so a '-USD' suffix unambiguously means crypto for every instrument
  // this adapter is configured to ever see.
  it('converts a dash-form crypto instrument to Alpaca slash form when flattening', async () => {
    const submitMarketOrder = vi.fn().mockResolvedValue({ ...acceptedOrder(), id: 'flatten-1' });
    const adapter = adapterWith(makeClient({ submitMarketOrder }));

    await adapter.submitFlatten('BTC-USD', 'sell', 0.5, 'flatten-key');

    expect(submitMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/USD' }));
  });

  // #517: before this, `fetchNewFills` never learned a flatten's order id at
  // all — `submitFlatten` reached the venue but entered neither `brackets`
  // nor any other worklist the sweep polls, so the fill was invisible no
  // matter what `ingestFills()` did with it. This is that gap's own test,
  // independent of `ingestFills()`'s attribution (covered in
  // `execute.test.ts` against the Simulated adapter): does the SWEEP even
  // see the order.
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
        legs: [], // a flatten is a plain market order — no attached legs.
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
        // #842: Alpaca reports a running per-order total, flagged for
        // `ingestFills()` so a later, larger observation books the increment.
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

    // One tracked flatten, so one `getOrder` call — the second `submitFlatten`
    // overwrote the same map entry rather than adding a second one.
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

    // Resolved through the VENUE, not the local bracket map: that map is
    // populated only by submitBracket in this process, so after a restart it
    // is empty and answering from it would cancel nothing.
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

  /**
   * #983 regression, and the reason the rounding happens at the TOP of
   * `rearmProtectiveLegs` rather than at its submit.
   *
   * `rearmOrderMatches` compares the caller's levels against what the venue
   * holds — and what the venue holds is the ROUNDED copy a previous re-arm
   * sent. Rounding only at the submit leaves that comparison permanently
   * unequal, so a live, correct, matching OCO is CANCELLED and re-placed on
   * every single pass: a needless round-trip that briefly leaves a real
   * position unprotected, for no cause but a trailing decimal.
   */
  it("adopts a resting prior whose venue prices are the ROUNDED form of the caller's (#983)", async () => {
    const getOrderByClientOrderId = vi.fn(async () => ({
      ...acceptedOrder(),
      id: 'rearm-venue-id',
      order_class: 'oco' as const,
      qty: '6',
      // What the venue holds: rounded, because that is what was sent.
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
    }));
    const cancelOrder = vi.fn();
    const submitOcoOrder = vi.fn();
    const adapter = adapterWith(
      makeClient({ getOrderByClientOrderId, cancelOrder, submitOcoOrder }),
    );

    // The caller passes the UNROUNDED levels, exactly as the lot's own
    // bracket multiples produced them.
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

  // #525 follow-up: `cancel()` must also clear a re-armed residual's OCO —
  // it carries `${clientOrderId}:rearm`, a DIFFERENT id from the lot's own,
  // so the lookup above alone can never find it. Left uncancelled, it stays
  // live at the venue and can fire into the flatten below's now-flat
  // position, reintroducing the #516 hazard `cancel()` exists to prevent.
  describe('cancel() also clears a re-armed residual (#525 follow-up)', () => {
    /** A `getOrderByClientOrderId` fake that answers per-id, like the real venue. */
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
          // A MATCHING live prior (#549's adopt-or-place compares qty/levels
          // before adopting), so the rearm below adopts without cancelling.
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
      // The re-arm happened in THIS process, so `rearmedLegs` already has
      // it — the fast, no-network-round-trip path.
      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);
      cancelOrder.mockClear(); // the rearm's own submit isn't a cancel call.

      await adapter.cancel('key-1', 'AAPL');

      // #867: the ORIGINAL bracket's cancel is the LAST destructive act, so a
      // failure anywhere earlier leaves the lot no more exposed than it was.
      expect(sequence).toEqual(['rearm-venue-id', 'bracket-venue-id']);
    });

    it('finds and cancels a re-armed OCO placed before a restart, when rearmedLegs is empty', async () => {
      // A FRESH adapter — never called `rearmProtectiveLegs` in this
      // process, so `rearmedLegs` starts empty. Only the venue lookup by
      // the derived id can find the order a PRIOR process re-armed.
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
          // No 'key-1:rearm' entry — the venue genuinely has no such order,
          // the ordinary case for a lot that was never partially flattened.
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

      // #867: the re-arm is cancelled FIRST, so its failure aborts before
      // the original bracket is touched. `executeExit` reads the throw as
      // "cancelling the held lot's legs failed" and refuses to submit the
      // flatten — which is only the safe answer because the lot still has
      // protection working at the venue, as this assertion pins.
      expect(cancelOrder).not.toHaveBeenCalledWith('bracket-venue-id');
      expect(cancelOrder).toHaveBeenCalledTimes(1);
    });

    // THE #867 DEFECT. Between #546 and #867 the `:rearm` LOOKUP ran AFTER
    // `cancelOrder(bracket)` had already succeeded, and it ran for every lot
    // on every exit — including this one, which never had a re-arm at all.
    // A degraded venue on that lookup therefore threw with the stop and
    // target already gone, `executeExit` refused the flatten, and the lot sat
    // open and naked. Both lookups now happen before either cancel.
    it('does not touch the venue when the :rearm lookup fails — protection stays intact (#867)', async () => {
      const getOrderByClientOrderId = vi.fn(async (clientOrderId: string) => {
        if (clientOrderId === 'key-1:rearm') throw new Error('venue unavailable');
        return { ...acceptedOrder(), id: 'bracket-venue-id' };
      });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const adapter = adapterWith(makeClient({ getOrderByClientOrderId, cancelOrder }));

      await expect(adapter.cancel('key-1', 'AAPL')).rejects.toThrow();

      // The load-bearing assertion: NO cancel went out. The lot's stop and
      // target are still working, so `executeExit`'s refusal of the flatten
      // leaves it exactly as protected as it was before the exit was tried.
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

  // #525: re-arming a residual left by a partial flatten. `executeExit`
  // cancels the lot's ENTIRE bracket before flattening, so unlike a resize
  // there is no live leg left to amend — this submits a fresh
  // protective-legs-only OCO order instead.
  it("re-arms with an entry-less OCO order under a FRESH client order id, never the lot's own", async () => {
    const submitOcoOrder = vi
      .fn()
      .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-1', order_class: 'oco', legs: [] });
    // #549 adopt-or-place: null = the venue authoritatively has no prior
    // re-arm under the deterministic wire id, so this places afresh.
    const getOrderByClientOrderId = vi.fn().mockResolvedValue(null);
    const adapter = adapterWith(makeClient({ submitOcoOrder, getOrderByClientOrderId }));

    await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

    expect(submitOcoOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      // The CLOSING side — the lot is HELD long ('buy'), so the order that
      // reduces it sells.
      side: 'sell',
      qty: '6',
      time_in_force: 'gtc',
      // Never `'key-1'` — that id already named the now-cancelled original
      // bracket (see the method's own doc comment for why reusing it is
      // refused rather than risked).
      client_order_id: 'key-1:rearm',
      order_class: 'oco',
      // #586, VERIFIED wire shape (#550): the take-profit price NESTED under
      // `take_profit`, never top-level — Alpaca rejects the top-level form
      // for every asset class (422 code 40010001, "oco orders require
      // take_profit.limit_price").
      take_profit: { limit_price: '110.00' },
      stop_loss: { stop_price: '95.00' },
    });
  });

  // #549 adopt-or-place: the wire id is deterministic (`${key}:rearm`), so a
  // re-arm that succeeded venue-side before a crash lost its confirmation is
  // ADOPTED by the retry rather than double-submitted (or misread as a fresh
  // failure when the venue rejects the duplicate client order id).
  describe('re-arm adopt-or-place (#549)', () => {
    /** A live prior OCO whose qty/levels match the canonical (6, 95, 110) request. */
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
      const getOrderByClientOrderId = vi.fn().mockResolvedValue(matchingPriorOco());
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(getOrderByClientOrderId).toHaveBeenCalledWith('key-1:rearm');
      expect(submitOcoOrder).not.toHaveBeenCalled();
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    // #549 review: the wire id is per-lot and reused across attempts, so a
    // resting prior sized for a DIFFERENT residual (further exit fills landed
    // between the crashed attempt and this retry) must not be adopted — an
    // oversized stop over-closes into a reverse position (#516's hazard).
    it('cancels and replaces a live prior whose qty no longer matches the residual', async () => {
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-2', order_class: 'oco', legs: [] });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      // Sized for the OLD residual (9), request now wants 6.
      const getOrderByClientOrderId = vi
        .fn()
        .mockResolvedValue({ ...matchingPriorOco(), qty: '9' });
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
      const prior = matchingPriorOco();
      const getOrderByClientOrderId = vi
        .fn()
        .mockResolvedValue({ ...prior, limit_price: undefined });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(cancelOrder).toHaveBeenCalledWith('prior-rearm-oco');
      expect(submitOcoOrder).toHaveBeenCalledTimes(1);
    });

    // #549 review (cycle 2): a partially-consumed prior's fills are EXIT
    // fills — every filled share already closed that much of the position —
    // so its resting remainder equals what that episode still holds, while
    // the caller's residual may be computed off a store that has not
    // ingested those fills yet. Cancel-and-replace sized to that stale
    // figure would over-arm; adoption is the safe answer, like `filled`.
    it('adopts a PARTIALLY_FILLED prior without cancel-and-replace, even when the store-side residual disagrees', async () => {
      const submitOcoOrder = vi.fn();
      const cancelOrder = vi.fn();
      const getOrderByClientOrderId = vi.fn().mockResolvedValue({
        ...matchingPriorOco(),
        // qty 6 with 2 filled: 4 rest, 4 held from this episode — while the
        // request (computed off a store missing those fills) still says 6.
        status: 'partially_filled',
        filled_qty: '2',
      });
      const adapter = adapterWith(
        makeClient({ submitOcoOrder, cancelOrder, getOrderByClientOrderId }),
      );

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      expect(submitOcoOrder).not.toHaveBeenCalled();
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    // #549 review (round 3): `mapOrderState` folds every unrecognized venue
    // status — done_for_day, replaced, stopped — into 'submitted', so a
    // blocklist of dead states would adopt a matching-but-not-resting prior
    // as protection while nothing rests. Adoption is allowlisted on the raw
    // resting statuses; anything else is retired and replaced.
    it('does not adopt a matching prior in an unrecognized status (done_for_day) — cancels and replaces', async () => {
      const submitOcoOrder = vi
        .fn()
        .mockResolvedValue({ ...acceptedOrder(), id: 'rearm-2', order_class: 'oco', legs: [] });
      const cancelOrder = vi.fn().mockResolvedValue(undefined);
      const getOrderByClientOrderId = vi
        .fn()
        .mockResolvedValue({ ...matchingPriorOco(), status: 'done_for_day' });
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
      const getOrderByClientOrderId = vi.fn().mockResolvedValue({
        ...matchingPriorOco(),
        qty: '9',
        status: 'filled',
        filled_qty: '9',
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
      const getOrderByClientOrderId = vi.fn().mockResolvedValue({
        ...acceptedOrder(),
        id: 'prior-rearm-oco',
        client_order_id: 'key-1:rearm',
        order_class: 'oco',
        status: 'canceled',
        legs: [],
      });
      const adapter = adapterWith(makeClient({ submitOcoOrder, getOrderByClientOrderId }));

      await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

      // A cancelled prior protects nothing — the retry submits.
      expect(submitOcoOrder).toHaveBeenCalledTimes(1);
    });
  });

  // #586: a crypto residual never reaches `submitOcoOrder` — the order class
  // itself is rejected for crypto (verified, #550) — and one whose lot the
  // emulation's journal does not know cannot be re-armed on the emulated
  // path either (there is no durable home to write the episode ahead). The
  // contract's required posture is a THROW, which `ingestFills` turns into
  // the #525 fallback alert; a silent no-op would report success for a
  // residual that is still naked.
  it('refuses to re-arm a crypto residual with no journalled emulated bracket (#586)', async () => {
    const submitOcoOrder = vi.fn();
    const adapter = adapterWith(makeClient({ submitOcoOrder }));

    await expect(
      adapter.rearmProtectiveLegs('key-1', 'BTC-USD', 'buy', 0.5, 95, 110),
    ).rejects.toThrow(/no journalled emulated bracket/);
    expect(submitOcoOrder).not.toHaveBeenCalled();
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

    // Tagged under the LOT's OWN idempotency key ('key-1'), not the OCO's
    // wire id ('key-1:rearm') — this is what lets `ingestFills()`'s
    // ordinary per-position routing pick it up with no knowledge a re-arm
    // was ever involved (`rearmedLegs`' doc comment). The take-profit leg IS
    // the top-level order (an OCO's own shape, no 'entry' fill), tagged
    // `'target'`; the stop-loss reports zero filled_qty here so it produces
    // no fill row.
    expect(fills).toEqual([
      {
        client_order_id: 'key-1',
        broker_fill_id: 'rearm-1',
        leg: 'target',
        price: 110,
        qty: 6,
        fee: 0,
        timestamp: new Date(filledAt),
        // #842: Alpaca reports a running per-order total, flagged for
        // `ingestFills()` so a later, larger observation books the increment.
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

  // #585: the venue reports crypto positions under its own slash form —
  // this read-back must convert to dash form before anything above the
  // adapter boundary (Risk's exposure caps, the reconcile diff against
  // `SharedStore`) compares it against the repo's own 'BTC-USD' identity.
  // Nothing above `BrokerAdapter` may ever see Alpaca's wire form.
  it('converts a slash-form crypto position back to dash form', async () => {
    const adapter = adapterWith(
      makeClient({
        getPositions: vi
          .fn()
          .mockResolvedValue([
            { symbol: 'BTC/USD', qty: '0.5', side: 'long', avg_entry_price: '61000' },
          ]),
      }),
    );

    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: 'BTC-USD', qty: 0.5, side: 'buy', avg_entry_price: 61000 },
    ]);
  });

  // #585: a row already reporting dash form (should the venue ever do so)
  // must not be mangled — the read-back conversion is a no-op on input with
  // no slash to convert, not a blind dash re-insertion.
  it('does not double-convert a position already in dash form', async () => {
    const adapter = adapterWith(
      makeClient({
        getPositions: vi
          .fn()
          .mockResolvedValue([
            { symbol: 'BTC-USD', qty: '0.5', side: 'long', avg_entry_price: '61000' },
          ]),
      }),
    );

    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: 'BTC-USD', qty: 0.5, side: 'buy', avg_entry_price: 61000 },
    ]);
  });

  // #585 review (PR #588, Kimi): `fromAlpacaSymbol` is narrowed to a
  // `/USD`-suffix test, mirroring `toAlpacaSymbol`'s own `-USD`-suffix rule
  // on the way out, rather than a broader "contains a slash" one — no
  // equity symbol Alpaca returns contains a `/` today, so this pins that a
  // slash-bearing symbol NOT ending in `/USD` is left alone rather than
  // silently mangled (e.g. `'BTC/GBP'` -> `'BTC/GBP'`, not `'BTC-GBP'` or
  // some other guess this adapter has no basis for).
  it('leaves a slash-bearing symbol that is not /USD-suffixed untouched on read-back', async () => {
    const adapter = adapterWith(
      makeClient({
        getPositions: vi
          .fn()
          .mockResolvedValue([
            { symbol: 'BTC/GBP', qty: '0.5', side: 'long', avg_entry_price: '48000' },
          ]),
      }),
    );

    expect(await adapter.getOpenPositions()).toEqual([
      { instrument: 'BTC/GBP', qty: 0.5, side: 'buy', avg_entry_price: 48000 },
    ]);
  });

  it('drops an unparseable row rather than reporting NaN', async () => {
    // This feeds an exposure comparison, and NaN compares false against
    // everything — a poisoned row would read as "no divergence", the one
    // answer it must never give.
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
      // The only survivor, with an honest null where the price would not parse.
      { instrument: 'TSLA', qty: 4, side: 'buy', avg_entry_price: null },
    ]);
  });
});

/**
 * #524 review (kimi): unpruned `flattens` entries poll every terminal
 * flatten forever, against Alpaca's shared ~200 req/min account budget
 * (`alpaca-http-client.ts`) — a resource leak that grows for the whole
 * 14-day soak (#238). Proved end-to-end through `ExecutionImpl`/
 * `ingestFills()`, not just the adapter in isolation: the requirement is
 * "prune only once the fill is actually ingested", and "ingested" is a
 * claim about the STORE, which only the full pipeline can settle.
 */
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

    // A SECOND, unrelated lot that stays open throughout. Without it,
    // `ingestFills()`'s own "no open positions, return early" guard would
    // make the second poll below call `fetchNewFills` zero times the
    // moment AAPL's lot closes — proving nothing about pruning either way.
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
            // `fixedClock` never advances, so `advanceLot`'s no-lookahead
            // filter (`fill.timestamp <= now`) requires this at or before
            // `NOW`, not after it.
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
    // The pre-flatten cancel of AAPL's own bracket (#516): nothing to
    // clear, so `getOrderByClientOrderId` reports no order and `cancel()`
    // resolves quietly (its own idempotent-by-contract behaviour).
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      mode: 'paper',
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      logger: { log: () => {} },
    };
    const execution = new ExecutionImpl(input);

    await execution.execute(goDecision(aaplEntry));
    await execution.execute(goDecision(tslaEntry));
    await execution.ingestFills(); // fills both entries — nothing to prune yet.

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
          // #793: `executeExit` now refuses to write ahead without one.
          metadata: { ...orderIntent().metadata, exit_reason: 'flatten' },
        }),
      ),
    );
    expect(exitResult.status).toBe('submitted');

    // Poll, then ingest: the flatten sweep observes the order 'filled'
    // (terminal), its fill closes the lot, and ONLY THEN — inside the same
    // call, after `collectFill` has already handed the fill to `fills` —
    // does the adapter prune its own `flattens` entry.
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

    // A THIRD poll: TSLA is still open, so `fetchNewFills` genuinely runs
    // again (not short-circuited by "no open positions") — proving the
    // entry is gone, not merely that nothing asked.
    await execution.ingestFills();

    const flattenOrderCallsAfterSecondPoll = getOrder.mock.calls.filter(
      ([orderId]) => orderId === 'aapl-flatten-order',
    ).length;
    expect(flattenOrderCallsAfterSecondPoll).toBe(1);
  });

  /**
   * #842 END TO END, through the REAL `AlpacaBrokerAdapter`, the REAL
   * `ExecutionImpl`/`ingestFills()` and a REAL sqlite store — not a spy
   * adapter. The invariant this repo's dominant bug class ("tested mechanisms
   * nothing calls") demands be proved at the composition seam rather than in
   * a unit: our persisted `filled_size` for a lot equals the venue's
   * cumulative `filled_qty` for its entry order.
   *
   * `orchestrator/fill-sync.ts` calls exactly this `ingestFills()` on the
   * same `ExecutionImpl`, over the adapter `production.ts` constructs — so
   * there is no intervening layer that could rebuild the `NormalizedFill` and
   * drop the flag between the venue and the store.
   */
  it('follows the venue cumulative across polls instead of freezing at the first observation', async () => {
    const { store } = openTestExecutionStore();
    // Poll 1 sees 50 of 100 filled at 100; poll 2 sees the order terminate
    // CANCELLED at 80, average 100.75 — i.e. the last 30 went off at 102.
    // That last 30 is the increment the defect lost forever: a cancelled
    // order is the venue's final word, so nothing ever offers it again.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      mode: 'paper',
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      logger: { log: () => {} },
    });

    await execution.execute(
      goDecision(orderIntent({ idempotency_key: 'key-aapl-entry', size: 100 })),
    );
    await execution.ingestFills();
    expect((await store.getPosition('key-aapl-entry'))?.filled_size).toBe(50);

    await execution.ingestFills();

    const position = await store.getPosition('key-aapl-entry');
    // Before this ticket: 50 forever. Everything sized off `filled_size` —
    // the exposure caps, flat-by-close's exit (ADR-0014), the realized PnL —
    // was blind to 30 filled shares.
    expect(position?.filled_size).toBe(80);
    expect(position?.avg_entry_price).toBeCloseTo(100.75, 10);
  });

  /**
   * #842 guard 2, END TO END, on an ADVANCING clock — the only shape that
   * discriminates. `collectFill` dates an undated fill at the adapter's own
   * clock read, taken PART WAY THROUGH the sweep; `ingestFills` then drops
   * anything with `timestamp > now`. Read `now` before the sweep, as this
   * function originally did, and under a real (monotonically advancing)
   * clock `now` is ALWAYS the earlier of the two, so the undated fill is
   * discarded on every poll, forever — the exact defect one layer down,
   * invisible to every fixed-clock test in this file because there
   * `observedAt === now` and `<=` holds.
   *
   * Each `now()` here returns a distinct, increasing instant, so nothing
   * about the ordering is left to luck.
   */
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
        // The combination Alpaca's docs decline to rule out.
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
      ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
      mode: 'paper',
      residualExposureAlerts: { postResidualExposureAlert: async () => {} },
      filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
      flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
      flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
      logger: { log: () => {} },
    });

    await execution.execute(
      goDecision(orderIntent({ idempotency_key: 'key-aapl-entry', size: 100 })),
    );
    await execution.ingestFills();

    expect((await store.getPosition('key-aapl-entry'))?.filled_size).toBe(50);
  });

  /**
   * #519/#526 — `resumeFlatten`'s own contract, and the crash-restart
   * property it exists to serve: a FRESH adapter instance's `flattens` map
   * is empty (the in-memory gap `AlpacaBrokerAdapter.flattens`'s doc
   * describes), so without this, `fetchNewFills` polls nothing for a
   * flatten a prior process submitted. `resumeFlatten` re-populates it —
   * the same "re-populating the map" move `getOrder` already makes for
   * `brackets` (see that method's own doc), on a SEPARATE map so a flatten
   * never joins `brackets`' never-pruned worklist (permanent leak) instead
   * of `flattens`' bounded one.
   */
  describe('AlpacaBrokerAdapter.resumeFlatten (#519, #526)', () => {
    it('returns null, Alpaca-authoritatively, when the venue has no such order', async () => {
      const client = makeClient({
        getOrderByClientOrderId: vi.fn().mockResolvedValue(null),
      });
      const adapter = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
        ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
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
        ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
        state,
      });

      await adapter.resumeFlatten('flatten-1', 'AAPL');

      // `getOrder` (the bracket counterpart) DOES call both — see the
      // adapter's own "durable index" tests above. A flatten never should:
      // migration 0019's comment on why half-formed bracket-shaped state for
      // a flatten is the wrong shape.
      expect(saveBracketSpy).not.toHaveBeenCalled();
      expect(recordIdsSpy).not.toHaveBeenCalled();
    });

    it('re-populates the flatten sweep across a restart: a SECOND adapter instance, never told about the flatten directly, still finds and prices its fill via resumeFlatten', async () => {
      // The "venue": one client double shared by both adapter instances, so
      // it is the thing that does NOT forget across the "restart" below —
      // `broker-state-persistence.test.ts`'s own definition of the scenario,
      // applied to a flatten instead of a bracket.
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
      // The ack `first.submitFlatten` below needs — a fresh, unfilled 'accepted'
      // response, distinct from `venueOrder` (the LATER, filled state
      // `getOrderByClientOrderId`/`getOrder` report once the venue has
      // resolved it, which is what `second.resumeFlatten` reads back).
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

      // First process: submits the flatten, in-memory `flattens` map has it.
      const first = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
      });
      await first.submitFlatten('AAPL', 'sell', 10, 'flatten-1');

      // --- restart: a brand-new adapter instance, same client (the venue),
      // `flattens` map empty — the exact gap #526 names.
      const second = new AlpacaBrokerAdapter({
        client,
        rateLimiter: permissiveLimiter(),
        unpricedFillAlerts: recordingAlerts(),
        ocoDoubleFillAlerts: recordingDoubleFillAlerts(),
        logger: recordingLogger(),
        clock: fixedClock,
      });

      // Without resumeFlatten, this would return no fills at all — nothing
      // in `second.flattens` names 'aapl-flatten-order' to poll.
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
