import { TokenBucket } from '../../shared/index.js';
import { BrokerError } from '../broker-error.js';
import type { NativeBracketRequest } from '../types.js';
import { AlpacaBrokerAdapter } from './alpaca-adapter.js';
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
    ...overrides,
  };
}

describe('AlpacaBrokerAdapter.submitBracket', () => {
  it('submits a native bracket order carrying entry + target + stop', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });

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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });

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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
    await adapter.submitBracket(makeBracket());

    expect(await adapter.fetchNewFills(filledAt)).toHaveLength(1);
    expect(await adapter.fetchNewFills(new Date(filledAt.getTime() + 1))).toHaveLength(0);
  });

  it('an unrecognized client order id yields no fills to poll', async () => {
    const client = makeClient();
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });

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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter });

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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });

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
  it('refuses to book a filled quantity Alpaca reports no average price for', async () => {
    // The alternative — recording price 0 — is a phantom fill that corrupts
    // realized PnL, the R-multiple and the feedback loop's weighting. Same
    // posture as the ccxt adapter's `toFill`.
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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
    await adapter.submitBracket(makeBracket());

    // The only bracket is the bad one, so nothing is lost by throwing — and an
    // empty array here would read as "no new fills", which is a different fact.
    const error = await adapter.fetchNewFills(new Date(0)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringMatching(/reports filled_qty 100 but no filled_avg_price/),
    });
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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
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
    const adapter = new AlpacaBrokerAdapter({ client, rateLimiter: permissiveLimiter() });
    await adapter.submitBracket(makeBracket({ client_order_id: 'poisoned-lot' }));
    await adapter.submitBracket(makeBracket({ client_order_id: 'healthy-lot' }));

    const fills = await adapter.fetchNewFills(new Date(0));

    // The healthy lot still ingests; the poisoned one contributes nothing and
    // is retried next sweep (dedup on broker_fill_id makes that free).
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'healthy-lot', qty: 50, price: 100.02 });
  });
});
