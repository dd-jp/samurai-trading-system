import type { CostModel } from '../../cost-model-backtest/index.js';
import type { MarketDataService } from '../../market-data-service/index.js';
import type { OrderIntent } from '../../shared/index.js';
import { type Clock, TokenBucket } from '../../shared/index.js';
import type { VerdictDecision } from '../../verdict/index.js';
import { BrokerError } from '../broker-error.js';
import { InMemoryBrokerStateStore } from '../broker-state-store.js';
import { ExecutionImpl } from '../execute.js';
import { openTestExecutionStore } from '../sqlite-store-harness.js';
import type { ExecutionConfig, ExecutionInput, NativeBracketRequest } from '../types.js';
import type { UnpricedFillAlert, UnpricedFillAlertChannel } from '../unpriced-fill-alert.js';
import { AlpacaBrokerAdapter, DEFAULT_UNPRICED_FILL_AGE_OUT_MS } from './alpaca-adapter.js';
import type { AlpacaClient, AlpacaOrder } from './alpaca-client.js';

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

function makeClient(overrides: Partial<AlpacaClient> = {}): AlpacaClient {
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
    });

    await adapter.submitBracket(makeBracket());

    expect(client.submitOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      side: 'buy',
      qty: '100',
      limit_price: '100',
      time_in_force: 'day',
      client_order_id: 'key-aapl-1355',
      order_class: 'bracket',
      take_profit: { limit_price: '110' },
      stop_loss: { stop_price: '95' },
    });
  });

  it('acks with the parent + attached OCO leg ids and a submitted state', async () => {
    const adapter = new AlpacaBrokerAdapter({
      client: makeClient(),
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
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
      },
    ]);
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
    });

    const error = await adapter.submitBracket(makeBracket()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).message).toBe(
      'alpaca submitBracket failed (status 403, code forbidden)',
    );
    expect((error as BrokerError).message).not.toContain(secret);
    expect('cause' in (error as BrokerError)).toBe(false);
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
    client: AlpacaClient;
    state?: InMemoryBrokerStateStore;
    ageOutMs?: number;
  }): Promise<AlpacaBrokerAdapter> {
    const adapter = new AlpacaBrokerAdapter({
      client: options.client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: options.alerts,
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
  function adapterWith(client: AlpacaClient): AlpacaBrokerAdapter {
    return new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      unpricedFillAlerts: recordingAlerts(),
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

    it('cancels BOTH the original bracket and the re-armed OCO, original first', async () => {
      const sequence: string[] = [];
      const getOrderByClientOrderId = vi.fn(
        byClientOrderId({
          'key-1': { ...acceptedOrder(), id: 'bracket-venue-id' },
          'key-1:rearm': { ...acceptedOrder(), id: 'rearm-venue-id' },
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

      expect(sequence).toEqual(['bracket-venue-id', 'rearm-venue-id']);
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

      // The original bracket's cancel still went out (this method's
      // existing behaviour is unchanged), but the overall call rejects —
      // `executeExit` reads this as "cancelling the held lot's legs
      // failed" and refuses to submit the flatten at all, exactly as it
      // does when the ORIGINAL cancel fails.
      expect(cancelOrder).toHaveBeenCalledWith('bracket-venue-id');
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
    const adapter = adapterWith(makeClient({ submitOcoOrder }));

    await adapter.rearmProtectiveLegs('key-1', 'AAPL', 'buy', 6, 95, 110);

    expect(submitOcoOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      // The CLOSING side — the lot is HELD long ('buy'), so the order that
      // reduces it sells.
      side: 'sell',
      qty: '6',
      limit_price: '110',
      time_in_force: 'gtc',
      // Never `'key-1'` — that id already named the now-cancelled original
      // bracket (see the method's own doc comment for why reusing it is
      // refused rather than risked).
      client_order_id: 'key-1:rearm',
      order_class: 'oco',
      stop_loss: { stop_price: '95' },
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
    const adapter = adapterWith(makeClient({ submitOcoOrder, getOrder }));
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
});
