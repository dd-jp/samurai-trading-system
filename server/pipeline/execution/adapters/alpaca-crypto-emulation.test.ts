/**
 * The emulated crypto protective legs (#586), exercised through the
 * `AlpacaBrokerAdapter` seam — `submitBracket` / `fetchNewFills` / `cancel` /
 * `rearmProtectiveLegs` are the only doors production has, so the tests use
 * the same ones.
 *
 * The scripted venue mirrors the #550-verified posture: any advanced order
 * class (`submitOrder`'s bracket, `submitOcoOrder`) throws the way the live
 * API 422s, so a regression back to a native order class for crypto fails
 * here the way it would fail live. Plain orders are accepted and the script
 * fills/fails them per test.
 *
 * The crash-window tests share one `InMemoryBrokerStateStore` between two
 * adapter instances — the store IS the journal, and a second adapter over the
 * same store is a restart. What each one pins is the module's one rule:
 * every transition is journalled BEFORE the venue call it commits to, so the
 * restart resumes from the journal instead of guessing.
 */
import { TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import type { BrokerStateStore } from '../broker-state-store.js';
import { InMemoryBrokerStateStore } from '../broker-state-store.js';
import type { OcoDoubleFillAlert, OcoDoubleFillAlertChannel } from '../oco-double-fill-alert.js';
import type { NativeBracketRequest } from '../types.js';
import { AlpacaBrokerAdapter } from './alpaca-adapter.js';
import type {
  AlpacaClient,
  AlpacaLimitOrderRequest,
  AlpacaOrder,
  AlpacaStopLimitOrderRequest,
} from './alpaca-client.js';

const LOT = 'key-btc-1';

function cryptoBracket(overrides: Partial<NativeBracketRequest> = {}): NativeBracketRequest {
  return {
    client_order_id: LOT,
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    size: 0.5,
    entry: 60_000,
    stop: 57_000,
    target: 66_000,
    time_in_force: 'gtc',
    ...overrides,
  };
}

function recordingDoubleFills(): OcoDoubleFillAlertChannel & {
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

/**
 * The scripted venue. Orders are mutable rows the tests fill or kill;
 * failure flags model the crash windows (a throw from the venue call is
 * indistinguishable, journal-side, from a crash at the same instant — both
 * leave the journalled claim with no venue answer recorded).
 */
class FakeVenue {
  private readonly orders = new Map<string, AlpacaOrder>();
  private readonly byClientId = new Map<string, string>();
  readonly cancelledOrderIds: string[] = [];
  readonly submittedLimit: AlpacaLimitOrderRequest[] = [];
  readonly submittedStopLimit: AlpacaStopLimitOrderRequest[] = [];
  /** Throw on the next plain-limit submit — AFTER the venue recorded the order (a timeout-after-accept). */
  acceptThenThrowNextLimit = false;
  /** Throw on the next plain-limit submit with the venue never seeing it. */
  rejectNextLimit = false;
  /** Throw on the next stop-limit submit with the venue never seeing it. */
  rejectNextStopLimit = false;
  /** Throw on the next cancel (transport failure, order untouched). */
  failNextCancel = false;
  private nextId = 1;

  private accept(request: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: string;
    client_order_id: string;
  }): AlpacaOrder {
    const order: AlpacaOrder = {
      id: `venue-${this.nextId++}`,
      client_order_id: request.client_order_id,
      symbol: request.symbol,
      side: request.side,
      qty: request.qty,
      order_class: '',
      status: 'accepted',
      filled_qty: '0',
      filled_avg_price: null,
      filled_at: null,
    };
    this.orders.set(order.id, order);
    this.byClientId.set(request.client_order_id, order.id);
    return { ...order };
  }

  client(): AlpacaClient {
    return {
      submitOrder: async () => {
        throw new Error(
          '422 {"code":42210000,"message":"crypto orders not allowed for advanced order_class: otoco"}',
        );
      },
      submitOcoOrder: async () => {
        throw new Error(
          '422 {"code":42210000,"message":"crypto orders not allowed for advanced order_class: oco"}',
        );
      },
      submitMarketOrder: async () => {
        throw new Error('FakeVenue: no flatten in these scenarios');
      },
      submitLimitOrder: async (request) => {
        if (this.rejectNextLimit) {
          this.rejectNextLimit = false;
          throw new Error('FakeVenue: limit submit refused before the venue saw it');
        }
        if (this.acceptThenThrowNextLimit) {
          this.acceptThenThrowNextLimit = false;
          this.accept(request);
          throw new Error('FakeVenue: timeout after the venue accepted the order');
        }
        this.submittedLimit.push(request);
        return this.accept(request);
      },
      submitStopLimitOrder: async (request) => {
        if (this.rejectNextStopLimit) {
          this.rejectNextStopLimit = false;
          throw new Error('FakeVenue: stop-limit submit refused before the venue saw it');
        }
        this.submittedStopLimit.push(request);
        return this.accept(request);
      },
      cancelOrder: async (id) => {
        if (this.failNextCancel) {
          this.failNextCancel = false;
          throw new Error('FakeVenue: cancel transport failure');
        }
        this.cancelledOrderIds.push(id);
        const order = this.orders.get(id);
        if (order !== undefined && order.status !== 'filled') order.status = 'canceled';
      },
      getOrder: async (id) => {
        const order = this.orders.get(id);
        if (order === undefined) throw new Error(`FakeVenue: unknown order id '${id}'`);
        return { ...order };
      },
      getOrderByClientOrderId: async (clientOrderId) => {
        const id = this.byClientId.get(clientOrderId);
        if (id === undefined) return null;
        const order = this.orders.get(id);
        return order === undefined ? null : { ...order };
      },
      getPositions: async () => {
        throw new Error('FakeVenue: getPositions not scripted');
      },
      getAccount: async () => {
        throw new Error('FakeVenue: getAccount not scripted');
      },
    };
  }

  fill(clientOrderId: string, price: number, filledAt: string): void {
    const order = this.mustGet(clientOrderId);
    order.status = 'filled';
    order.filled_qty = order.qty;
    order.filled_avg_price = String(price);
    order.filled_at = filledAt;
  }

  /** A partial fill followed by a venue-side terminal state. */
  killPartiallyFilled(clientOrderId: string, qty: number, price: number, filledAt: string): void {
    const order = this.mustGet(clientOrderId);
    order.status = 'canceled';
    order.filled_qty = String(qty);
    order.filled_avg_price = String(price);
    order.filled_at = filledAt;
  }

  status(clientOrderId: string): string {
    return this.mustGet(clientOrderId).status;
  }

  venueId(clientOrderId: string): string {
    return this.mustGet(clientOrderId).id;
  }

  private mustGet(clientOrderId: string): AlpacaOrder {
    const id = this.byClientId.get(clientOrderId);
    const order = id === undefined ? undefined : this.orders.get(id);
    if (order === undefined)
      throw new Error(`FakeVenue: unknown client order id '${clientOrderId}'`);
    return order;
  }
}

function makeAdapter(
  venue: FakeVenue,
  state: BrokerStateStore,
  doubleFills: OcoDoubleFillAlertChannel = recordingDoubleFills(),
): AlpacaBrokerAdapter {
  return new AlpacaBrokerAdapter({
    client: venue.client(),
    rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
    state,
    unpricedFillAlerts: { postUnpricedFillAlert: async () => {} },
    ocoDoubleFillAlerts: doubleFills,
    logger: recordingLogger(),
  });
}

function journalRow(state: BrokerStateStore, clientOrderId: string = LOT) {
  return state.loadBrackets('alpaca').find((row) => row.client_order_id === clientOrderId);
}

describe('AlpacaCryptoLegEmulation — entry fill arms the plain legs', () => {
  it('submits stop_limit + limit legs sized to the fill once the sweep observes the entry filled', async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);

    await adapter.submitBracket(cryptoBracket());
    // Nothing armed yet: the legs wait on the fill, in the journal only.
    expect(venue.submittedStopLimit).toHaveLength(0);
    expect(journalRow(state)?.phase).toBe('pending_entry');

    venue.fill(LOT, 60_000, '2026-01-02T00:00:00Z');
    const fills = await adapter.fetchNewFills(new Date(0));

    // The entry fill came back tagged for ingestFills' ordinary routing.
    expect(fills).toEqual([
      expect.objectContaining({ client_order_id: LOT, leg: 'entry', qty: 0.5, price: 60_000 }),
    ]);
    // The exact leg wire bodies, pinned: plain orders, closing side, gtc,
    // deterministic first-episode client order ids, no order_class anywhere.
    expect(venue.submittedStopLimit).toEqual([
      {
        symbol: 'BTC/USD',
        side: 'sell',
        qty: '0.5',
        stop_price: '57000',
        limit_price: '57000',
        time_in_force: 'gtc',
        client_order_id: `${LOT}:stop`,
      },
    ]);
    expect(venue.submittedLimit.filter((r) => r.client_order_id !== LOT)).toEqual([
      {
        symbol: 'BTC/USD',
        side: 'sell',
        qty: '0.5',
        limit_price: '66000',
        time_in_force: 'gtc',
        client_order_id: `${LOT}:target`,
      },
    ]);
    // Both legs journalled as armed, with their venue ids.
    const row = journalRow(state);
    expect(row?.phase).toBe('armed');
    expect(row?.stop_order_id).toBe(venue.venueId(`${LOT}:stop`));
    expect(row?.target_order_id).toBe(venue.venueId(`${LOT}:target`));
  });

  it('arms a partially-filled-then-cancelled entry to the quantity that actually filled', async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);
    await adapter.submitBracket(cryptoBracket());

    venue.killPartiallyFilled(LOT, 0.2, 60_000, '2026-01-02T00:00:00Z');
    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toEqual([expect.objectContaining({ leg: 'entry', qty: 0.2 })]);
    // The residual is a live position — leaving it naked because the entry
    // died early is the exact failure the emulation exists to remove.
    expect(venue.submittedStopLimit[0]).toMatchObject({ qty: '0.2' });
    expect(journalRow(state)?.phase).toBe('armed');
    expect(journalRow(state)?.armed_qty).toBe(0.2);
  });

  it('resolves an entry that dies with nothing filled — no legs, nothing to protect', async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);
    await adapter.submitBracket(cryptoBracket());

    venue.killPartiallyFilled(LOT, 0, 0, '2026-01-02T00:00:00Z');
    // filled_avg_price '0' with qty 0 never reaches collectFill's guards —
    // a zero filled_qty is simply not a fill.
    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toEqual([]);
    expect(venue.submittedStopLimit).toHaveLength(0);
    expect(journalRow(state)?.phase).toBe('resolved');
  });
});

describe('AlpacaCryptoLegEmulation — the OCO edge', () => {
  async function armedAdapter(venue: FakeVenue, state: BrokerStateStore) {
    const adapter = makeAdapter(venue, state);
    await adapter.submitBracket(cryptoBracket());
    venue.fill(LOT, 60_000, '2026-01-02T00:00:00Z');
    await adapter.fetchNewFills(new Date(0));
    return adapter;
  }

  it('cancels the surviving take-profit when the stop fills, journalling the claim first', async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = await armedAdapter(venue, state);

    venue.fill(`${LOT}:stop`, 57_000, '2026-01-02T00:01:00Z');
    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toContainEqual(
      expect.objectContaining({ client_order_id: LOT, leg: 'stop', price: 57_000 }),
    );
    expect(venue.cancelledOrderIds).toContain(venue.venueId(`${LOT}:target`));
    expect(venue.status(`${LOT}:target`)).toBe('canceled');
    expect(journalRow(state)?.phase).toBe('resolved');
  });

  it("journals 'cancelling_sibling' BEFORE the cancel call, and a restart retries it", async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = await armedAdapter(venue, state);

    venue.fill(`${LOT}:target`, 66_000, '2026-01-02T00:01:00Z');
    venue.failNextCancel = true;
    await adapter.fetchNewFills(new Date(0));

    // The proof of the write-ahead: the cancel THREW, yet the journal already
    // says a sibling cancel is owed — a crash at the same instant leaves the
    // same row, which is exactly what migration 0022 exists to record.
    expect(journalRow(state)?.phase).toBe('cancelling_sibling');
    expect(venue.status(`${LOT}:stop`)).toBe('accepted');

    // The restart: a fresh adapter over the same journal.
    const restarted = makeAdapter(venue, state);
    await restarted.fetchNewFills(new Date(0));

    expect(venue.cancelledOrderIds).toContain(venue.venueId(`${LOT}:stop`));
    expect(journalRow(state)?.phase).toBe('resolved');
  });

  it('books BOTH fills and alerts — never hides — when both legs filled inside one poll window', async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const doubleFills = recordingDoubleFills();
    const adapter = makeAdapter(venue, state, doubleFills);
    await adapter.submitBracket(cryptoBracket());
    venue.fill(LOT, 60_000, '2026-01-02T00:00:00Z');
    await adapter.fetchNewFills(new Date(0));

    // The accepted double-fill window (#586) materialised: the market traded
    // through both prices between polls.
    venue.fill(`${LOT}:stop`, 57_000, '2026-01-02T00:01:00Z');
    venue.fill(`${LOT}:target`, 66_000, '2026-01-02T00:01:30Z');
    const fills = await adapter.fetchNewFills(new Date(0));

    expect(fills).toContainEqual(expect.objectContaining({ leg: 'stop' }));
    expect(fills).toContainEqual(expect.objectContaining({ leg: 'target' }));
    expect(doubleFills.posted).toEqual([
      expect.objectContaining({
        client_order_id: LOT,
        instrument: 'BTC-USD',
        stop_order_id: venue.venueId(`${LOT}:stop`),
        target_order_id: venue.venueId(`${LOT}:target`),
      }),
    ]);
    expect(journalRow(state)?.phase).toBe('resolved');

    // Once per observation, not once per poll.
    await adapter.fetchNewFills(new Date(0));
    expect(doubleFills.posted).toHaveLength(1);
  });
});

describe('AlpacaCryptoLegEmulation — crash-restart resumes from the journal', () => {
  it("journals 'submitting' BEFORE the entry call, and a restart adopts the order a timeout hid", async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);

    venue.acceptThenThrowNextLimit = true;
    // `sanitizeBrokerError` replaces the venue's message wholesale (H1) —
    // what reaches the caller is the credential-safe named-operation form.
    await expect(adapter.submitBracket(cryptoBracket())).rejects.toThrow(
      'alpaca submitBracket failed',
    );

    // The row survived the throw — a crash in the same window leaves the
    // identical journal, which is the entire point of the write-ahead.
    const row = journalRow(state);
    expect(row?.phase).toBe('submitting');
    expect(row?.entry_order_id).toBeNull();
    expect(row?.request?.stop).toBe(57_000);

    const restarted = makeAdapter(venue, state);
    await restarted.fetchNewFills(new Date(0)); // resolveSubmitting adopts the live order
    expect(journalRow(state)?.phase).toBe('pending_entry');
    expect(journalRow(state)?.entry_order_id).toBe(venue.venueId(LOT));

    // …and the adopted bracket continues to a normal arm.
    venue.fill(LOT, 60_000, '2026-01-02T00:00:00Z');
    await restarted.fetchNewFills(new Date(0));
    expect(journalRow(state)?.phase).toBe('armed');
  });

  it("resolves a 'submitting' row the venue authoritatively never saw", async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);

    venue.rejectNextLimit = true;
    await expect(adapter.submitBracket(cryptoBracket())).rejects.toThrow(
      'alpaca submitBracket failed',
    );
    expect(journalRow(state)?.phase).toBe('submitting');

    const restarted = makeAdapter(venue, state);
    await restarted.fetchNewFills(new Date(0));
    expect(journalRow(state)?.phase).toBe('resolved');
  });

  it("journals 'arming' BEFORE the leg calls, and a restart adopts the placed leg and places the missing one", async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);
    await adapter.submitBracket(cryptoBracket());
    venue.fill(LOT, 60_000, '2026-01-02T00:00:00Z');

    // The stop-leg placement dies; the target leg landed (Promise.all).
    venue.rejectNextStopLimit = true;
    await adapter.fetchNewFills(new Date(0)).catch(() => undefined);
    const row = journalRow(state);
    expect(row?.phase).toBe('arming');
    expect(row?.arming_qty).toBe(0.5);

    const restarted = makeAdapter(venue, state);
    await restarted.fetchNewFills(new Date(0));

    const armed = journalRow(state);
    expect(armed?.phase).toBe('armed');
    expect(armed?.stop_order_id).toBe(venue.venueId(`${LOT}:stop`));
    expect(armed?.target_order_id).toBe(venue.venueId(`${LOT}:target`));
    // The recovery ADOPTED the already-placed target rather than doubling it:
    // one target order ever reached the venue.
    expect(
      venue.submittedLimit.filter((request) => request.client_order_id === `${LOT}:target`),
    ).toHaveLength(1);
  });
});

describe('AlpacaCryptoLegEmulation — cancel and re-arm', () => {
  it('cancel() kills the entry AND both emulated legs — no parent order does it for us', async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);
    await adapter.submitBracket(cryptoBracket());
    venue.fill(LOT, 60_000, '2026-01-02T00:00:00Z');
    await adapter.fetchNewFills(new Date(0));

    await adapter.cancel(LOT, 'BTC-USD');

    expect(venue.cancelledOrderIds).toEqual(
      expect.arrayContaining([
        venue.venueId(LOT),
        venue.venueId(`${LOT}:stop`),
        venue.venueId(`${LOT}:target`),
      ]),
    );
    expect(venue.status(`${LOT}:stop`)).toBe('canceled');
    expect(venue.status(`${LOT}:target`)).toBe('canceled');
    expect(journalRow(state)?.phase).toBe('resolved');
  });

  it('re-arms a residual as two plain legs on a fresh journalled episode, and its OCO edge still fires', async () => {
    const venue = new FakeVenue();
    const state = new InMemoryBrokerStateStore();
    const adapter = makeAdapter(venue, state);
    await adapter.submitBracket(cryptoBracket());
    venue.fill(LOT, 60_000, '2026-01-02T00:00:00Z');
    await adapter.fetchNewFills(new Date(0));
    // The production sequence: executeExit cancels the whole bracket before
    // its flatten; the flatten then fills only partially.
    await adapter.cancel(LOT, 'BTC-USD');

    await adapter.rearmProtectiveLegs(LOT, 'BTC-USD', 'buy', 0.2, 57_000, 66_000);

    // Fresh-episode ids (`:r1`), residual sizing, plain orders again.
    expect(venue.submittedStopLimit[1]).toEqual({
      symbol: 'BTC/USD',
      side: 'sell',
      qty: '0.2',
      stop_price: '57000',
      limit_price: '57000',
      time_in_force: 'gtc',
      client_order_id: `${LOT}:stop:r1`,
    });
    const row = journalRow(state);
    expect(row?.phase).toBe('armed');
    expect(row?.arm_attempt).toBe(1);
    expect(row?.armed_qty).toBe(0.2);

    // The re-armed pair keeps the one-cancels-other promise, tagged under
    // the LOT's own key so ingestFills routes them with no extra knowledge.
    venue.fill(`${LOT}:target:r1`, 66_000, '2026-01-02T01:00:00Z');
    const fills = await adapter.fetchNewFills(new Date(0));
    expect(fills).toContainEqual(
      expect.objectContaining({ client_order_id: LOT, leg: 'target', qty: 0.2 }),
    );
    expect(venue.cancelledOrderIds).toContain(venue.venueId(`${LOT}:stop:r1`));
    expect(journalRow(state)?.phase).toBe('resolved');
  });
});
