/**
 * Cross-restart rehydration of adapter state (#287, closing #294/#295).
 *
 * Every "restart" here is a genuinely fresh adapter instance built over the
 * SAME database FILE. That is not incidental: `openSharedStore(':memory:')`
 * hands each connection its own private database, so a two-instance test on
 * `:memory:` would build instance B over an empty store and pass while proving
 * nothing at all. Temp files it is.
 *
 * The discriminating assertion for the acceptance case is not "the legs exist
 * after the restart" — it is that the venue was asked to CREATE each leg at
 * most once across BOTH instances. Double-arming a live lot is the failure
 * this whole ticket exists to make impossible, and it looks identical to
 * success in any assertion that only counts final state.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenBucket } from '../shared/index.js';
import { type SharedStore as Db, openSharedStore } from '../shared/store/index.js';
import { AlpacaBrokerAdapter } from './adapters/alpaca-adapter.js';
import type { AlpacaClient, AlpacaOrder } from './adapters/alpaca-client.js';
import { CcxtBrokerAdapter, type CcxtBrokerClient, type CcxtOrder } from './ccxt-adapter.js';
import { IbkrBrokerAdapter, type IbkrBrokerClient, type IbkrExecution } from './ibkr-adapter.js';
import { SqliteBrokerStateStore } from './sqlite-broker-state-store.js';
import type { NativeBracketRequest } from './types.js';

const FILL_TS = new Date('2026-07-15T14:00:00Z').getTime();
const FILL_TIME = '2026-07-15T14:00:00.000Z';
const SINCE = new Date('2026-07-15T00:00:00Z');

const REQUEST: NativeBracketRequest = {
  client_order_id: 'idem-1',
  instrument: 'BTC/USD',
  asset_class: 'crypto',
  side: 'buy',
  size: 2,
  entry: 100,
  stop: 90,
  target: 120,
  time_in_force: 'GTC',
};

const STOCK_REQUEST: NativeBracketRequest = {
  ...REQUEST,
  instrument: 'AAPL',
  asset_class: 'stocks',
};

/** Pacing has its own suites; these are about state, not the wall clock. */
function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

const tempDirs: string[] = [];
const openDbs: Db[] = [];

/** A real file, for the reason in the file header. */
function openFileStore(): { path: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-broker-state-'));
  tempDirs.push(dir);
  const path = join(dir, 'samurai-test.sqlite');
  return { path, db: reopen(path) };
}

/** A NEW connection over the same file — the "restart". */
function reopen(path: string): Db {
  const db = openSharedStore(path);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ccxt — the emulated bracket, where the persisted state IS the truth
// ---------------------------------------------------------------------------

interface CcxtFake {
  client: CcxtBrokerClient;
  orders: Map<string, CcxtOrder>;
  createOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
  /** Leg placements the venue was asked to make, by client order id. */
  placedLegIds: string[];
  /**
   * The crash injector: which leg placements die before the venue records
   * them. `'stop'` is the sharpest case — the pair half-lands, so a naive
   * recovery double-arms the leg that DID land.
   */
  failLegPlacement: { value: 'none' | 'all' | 'stop' };
  /** When set, the client-order-id lookup throws instead of answering. */
  lookupFails: { value: boolean };
}

function makeCcxtFake(): CcxtFake {
  const orders = new Map<string, CcxtOrder>();
  const placedLegIds: string[] = [];
  const failLegPlacement: CcxtFake['failLegPlacement'] = { value: 'none' };
  const lookupFails = { value: false };

  const createOrder = vi.fn<CcxtBrokerClient['createOrder']>(
    async (_symbol, _type, _side, _amount, _price, params) => {
      const clientOrderId = String(params?.clientOrderId);
      const isLeg = clientOrderId !== REQUEST.client_order_id;

      if (isLeg) {
        placedLegIds.push(clientOrderId);
        const dies =
          failLegPlacement.value === 'all' ||
          (failLegPlacement.value === 'stop' && clientOrderId.includes(':stop'));
        if (dies) {
          // The process dying mid-`Promise.all` and the venue refusing the
          // order are indistinguishable from inside the adapter; this is the
          // cheaper way to stop it before it can record the leg ids.
          throw new Error('simulated crash before the leg landed');
        }
      }

      const order: CcxtOrder = {
        id: `venue-${clientOrderId}`,
        status: 'open',
        filled: 0,
        average: undefined,
        timestamp: FILL_TS,
        fee: undefined,
      };
      orders.set(order.id, order);
      return order;
    },
  );

  const cancelOrder = vi.fn<CcxtBrokerClient['cancelOrder']>(async (id) => {
    const order = orders.get(id);
    if (order !== undefined) orders.set(id, { ...order, status: 'canceled' });
    return undefined;
  });

  const fetchOrder = vi.fn<CcxtBrokerClient['fetchOrder']>(async (id) => {
    const order = orders.get(id);
    if (order === undefined) throw new Error(`test fake has no order ${id}`);
    return order;
  });

  const fetchOrderByClientOrderId = vi.fn<CcxtBrokerClient['fetchOrderByClientOrderId']>(
    async (clientOrderId) => {
      if (lookupFails.value) throw new Error('venue unreachable');
      return orders.get(`venue-${clientOrderId}`) ?? null;
    },
  );

  return {
    client: { createOrder, cancelOrder, fetchOrder, fetchOrderByClientOrderId },
    orders,
    createOrder,
    cancelOrder,
    placedLegIds,
    failLegPlacement,
    lookupFails,
  };
}

/** Mark the entry as fully filled, as the venue would once it trades. */
function fillEntry(fake: CcxtFake, qty = REQUEST.size): void {
  const id = `venue-${REQUEST.client_order_id}`;
  fake.orders.set(id, {
    id,
    status: 'closed',
    filled: qty,
    average: 100,
    timestamp: FILL_TS,
    fee: { cost: 0.26 },
  });
}

function ccxtAdapter(fake: CcxtFake, db: Db): CcxtBrokerAdapter {
  return new CcxtBrokerAdapter(fake.client, permissiveLimiter(), new SqliteBrokerStateStore(db));
}

function bracketRow(db: Db, clientOrderId = REQUEST.client_order_id) {
  return db
    .prepare('SELECT * FROM broker_brackets WHERE venue = ? AND client_order_id = ?')
    .get('ccxt', clientOrderId) as
    | { phase: string; stop_order_id: string | null; arming_qty: number | null }
    | undefined;
}

describe('ccxt emulated bracket across a restart', () => {
  it('finishes arming a bracket whose process died between the entry fill and the legs, without double-arming', async () => {
    const { path, db } = openFileStore();
    const fake = makeCcxtFake();

    // --- process A: submit, entry fills, then die mid-arm ------------------
    const first = ccxtAdapter(fake, db);
    await first.submitBracket(REQUEST);
    fillEntry(fake);
    fake.failLegPlacement.value = 'stop';
    // The message is sanitized on the way out (`sanitizeBrokerError`), so the
    // assertion is on the operation, not the fake's wording.
    await expect(first.syncBrackets()).rejects.toThrow(/armStopLeg|armTargetLeg/);

    // The claim was written BEFORE the venue was called, which is what makes
    // the recovery below possible at all.
    expect(bracketRow(db)?.phase).toBe('arming');
    expect(bracketRow(db)?.arming_qty).toBe(2);

    // --- process B: a brand-new adapter over the same file -----------------
    fake.failLegPlacement.value = 'none';
    const second = ccxtAdapter(fake, reopen(path));

    await second.syncBrackets();

    expect(bracketRow(db)?.phase).toBe('armed');
    expect(bracketRow(db)?.stop_order_id).toBe('venue-idem-1:stop');

    // THE assertion, and the reason this test exists. Process A's TARGET leg
    // did land at the venue before the process died; process B must adopt it,
    // not place a second one. A lot carrying two live take-profits is the
    // double-arm this ticket exists to make impossible, and it is invisible to
    // any assertion that only looks at final state.
    expect(fake.placedLegIds.filter((id) => id === 'idem-1:target')).toHaveLength(1);

    // The STOP leg never landed (A threw before the venue recorded it), so B
    // placed it — under the SAME client order id A used, which is the id the
    // venue would have rejected had A's call in fact landed. That reuse is
    // what `arm_attempt` being durable and NOT incremented per placement buys.
    expect(fake.placedLegIds.filter((id) => id === 'idem-1:stop')).toHaveLength(2);
    expect(new Set(fake.placedLegIds)).toEqual(new Set(['idem-1:stop', 'idem-1:target']));
  });

  it('adopts a leg the dead process DID place rather than placing a second one', async () => {
    const { path, db } = openFileStore();
    const fake = makeCcxtFake();

    const first = ccxtAdapter(fake, db);
    await first.submitBracket(REQUEST);
    fillEntry(fake);

    // The stop lands at the venue; the target placement is what kills the
    // process. This is the dangerous window: the venue holds a live stop the
    // adapter has no record of.
    let placements = 0;
    fake.createOrder.mockImplementation(async (_s, _t, _side, _amount, _price, params) => {
      const clientOrderId = String(params?.clientOrderId);
      fake.placedLegIds.push(clientOrderId);
      placements += 1;
      const order: CcxtOrder = {
        id: `venue-${clientOrderId}`,
        status: 'open',
        filled: 0,
        average: undefined,
        timestamp: FILL_TS,
        fee: undefined,
      };
      fake.orders.set(order.id, order);
      if (placements > 1) throw new Error('simulated crash before the second leg landed');
      return order;
    });

    // The message is sanitized on the way out (`sanitizeBrokerError`), so the
    // assertion is on the operation, not the fake's wording.
    await expect(first.syncBrackets()).rejects.toThrow(/armStopLeg|armTargetLeg/);
    expect(bracketRow(db)?.phase).toBe('arming');

    // --- restart -----------------------------------------------------------
    const before = [...fake.placedLegIds];
    fake.createOrder.mockImplementation(async (_s, _t, _side, _amount, _price, params) => {
      const clientOrderId = String(params?.clientOrderId);
      fake.placedLegIds.push(clientOrderId);
      const order: CcxtOrder = {
        id: `venue-${clientOrderId}`,
        status: 'open',
        filled: 0,
        average: undefined,
        timestamp: FILL_TS,
        fee: undefined,
      };
      fake.orders.set(order.id, order);
      return order;
    });

    const second = ccxtAdapter(fake, reopen(path));
    await second.syncBrackets();

    expect(bracketRow(db)?.phase).toBe('armed');

    // Only the legs the venue did NOT already hold were placed again. Both
    // legs were reported live by the fake (the failing call still registered
    // its order), so the restart placed nothing.
    expect(fake.placedLegIds).toEqual(before);
  });

  it('refuses to place a leg it cannot confirm absent, leaving the bracket visibly arming', async () => {
    const { path, db } = openFileStore();
    const fake = makeCcxtFake();

    const first = ccxtAdapter(fake, db);
    await first.submitBracket(REQUEST);
    fillEntry(fake);
    fake.failLegPlacement.value = 'all';
    await expect(first.syncBrackets()).rejects.toThrow();

    // --- restart, but the venue cannot answer the lookup -------------------
    fake.failLegPlacement.value = 'none';
    fake.lookupFails.value = true;
    const placedBefore = fake.placedLegIds.length;
    const second = ccxtAdapter(fake, reopen(path));

    await expect(second.syncBrackets()).rejects.toThrow(/venue unreachable|could not be advanced/);

    // Not armed, and — the point — not double-armed either. An adapter that
    // cannot tell whether the leg is already live must place nothing.
    expect(bracketRow(db)?.phase).toBe('arming');
    expect(fake.placedLegIds).toHaveLength(placedBefore);
  });

  it('refuses to adopt a leg the venue holds in a terminal state', async () => {
    const { path, db } = openFileStore();
    const fake = makeCcxtFake();

    const first = ccxtAdapter(fake, db);
    await first.submitBracket(REQUEST);
    fillEntry(fake);
    fake.failLegPlacement.value = 'stop';
    await expect(first.syncBrackets()).rejects.toThrow();

    // The target leg landed pre-crash and was then cancelled out-of-band.
    // Adopting its dead id would mark the bracket `armed` while the lot has at
    // most one live protective leg — the very failure this ticket removes.
    const target = fake.orders.get('venue-idem-1:target') as CcxtOrder;
    fake.orders.set('venue-idem-1:target', { ...target, status: 'canceled' });

    fake.failLegPlacement.value = 'none';
    const second = ccxtAdapter(fake, reopen(path));

    await expect(second.syncBrackets()).rejects.toThrow(/terminal state 'canceled'/);
    expect(bracketRow(db)?.phase).toBe('arming');
  });

  it('one stuck bracket does not starve another bracket´s OCO cancel', async () => {
    const { db } = openFileStore();
    const fake = makeCcxtFake();

    // Bracket A gets stuck mid-arm; bracket B is armed and about to stop out.
    const first = ccxtAdapter(fake, db);
    await first.submitBracket(REQUEST);
    fillEntry(fake);
    fake.failLegPlacement.value = 'all';
    await expect(first.syncBrackets()).rejects.toThrow();

    fake.failLegPlacement.value = 'none';
    const other = { ...REQUEST, client_order_id: 'idem-2' };
    await first.submitBracket(other);
    fake.orders.set('venue-idem-2', {
      id: 'venue-idem-2',
      status: 'closed',
      filled: 2,
      average: 100,
      timestamp: FILL_TS,
      fee: { cost: 0.26 },
    });

    fake.lookupFails.value = true; // keeps bracket A stuck
    await expect(first.syncBrackets()).rejects.toThrow();

    // B advanced despite A throwing — per-bracket isolation.
    const rowB = db
      .prepare('SELECT phase FROM broker_brackets WHERE venue = ? AND client_order_id = ?')
      .get('ccxt', 'idem-2') as { phase: string };
    expect(rowB.phase).toBe('armed');
    expect(bracketRow(db)?.phase).toBe('arming');
  });

  it('delivers a fill the dead process observed but never had drained (#295)', async () => {
    const { path, db } = openFileStore();
    const fake = makeCcxtFake();

    const first = ccxtAdapter(fake, db);
    await first.submitBracket(REQUEST);
    fillEntry(fake);
    await first.syncBrackets();

    // The entry fill was observed and journalled, but nothing drained it —
    // `ingestFills()` never ran before the process died. Nothing re-derives
    // an entry fill for an ALREADY-ARMED bracket, so without the journal it
    // would be lost and the lot would sit at filled_size 0.
    const second = ccxtAdapter(fake, reopen(path));
    const fills = await second.fetchNewFills(SINCE);

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      client_order_id: 'idem-1',
      leg: 'entry',
      qty: 2,
      price: 100,
    });
  });

  it('still dedups a resubmitted client order id after a restart', async () => {
    const { path, db } = openFileStore();
    const fake = makeCcxtFake();

    await ccxtAdapter(fake, db).submitBracket(REQUEST);
    const entryPlacements = fake.createOrder.mock.calls.length;

    const second = ccxtAdapter(fake, reopen(path));
    const ack = await second.submitBracket(REQUEST);

    // A second entry against a lot that already has one is the worst outcome
    // the dedup exists to prevent, and it is exactly what a cold map allows.
    expect(fake.createOrder.mock.calls).toHaveLength(entryPlacements);
    expect(ack.broker_order_ids).toEqual(['venue-idem-1']);
  });

  it('answers getOrder for a bracket it only knows from the journal', async () => {
    const { path, db } = openFileStore();
    const fake = makeCcxtFake();

    await ccxtAdapter(fake, db).submitBracket(REQUEST);

    const second = ccxtAdapter(fake, reopen(path));
    const order = await second.getOrder('idem-1', 'BTC/USD');

    // Before #287 this threw, and `reconcile()` recorded every ccxt lot as
    // `undetermined` after any restart.
    expect(order).toMatchObject({ client_order_id: 'idem-1', order_state: 'submitted' });
  });
});

// ---------------------------------------------------------------------------
// IBKR — durable leg index (#295) + the order-status lookup (#294)
// ---------------------------------------------------------------------------

const IBKR_IDS = { parentOrderId: 'p1', stopOrderId: 's1', takeProfitOrderId: 't1' };

const EXECUTION: IbkrExecution = {
  execId: 'e1',
  orderId: 's1',
  price: 89.5,
  shares: 10,
  commission: 1,
  time: FILL_TIME,
};

function makeIbkrFake(executions: IbkrExecution[] = []) {
  const placeBracketOrder = vi.fn<IbkrBrokerClient['placeBracketOrder']>(async () => IBKR_IDS);
  const fetchExecutions = vi.fn<IbkrBrokerClient['fetchExecutions']>(async () => executions);
  const fetchOrderStatus = vi.fn<IbkrBrokerClient['fetchOrderStatus']>(async (clientOrderId) => ({
    clientOrderId,
    parentOrderId: IBKR_IDS.parentOrderId,
    stopOrderId: IBKR_IDS.stopOrderId,
    takeProfitOrderId: IBKR_IDS.takeProfitOrderId,
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

function ibkrAdapter(client: IbkrBrokerClient, db: Db): IbkrBrokerAdapter {
  return new IbkrBrokerAdapter(client, permissiveLimiter(), new SqliteBrokerStateStore(db));
}

describe('IbkrBrokerAdapter across a restart', () => {
  it('claims its own executions after a restart instead of dropping them as another account´s', async () => {
    const { path, db } = openFileStore();
    const fake = makeIbkrFake([EXECUTION]);

    await ibkrAdapter(fake.client, db).submitBracket(STOCK_REQUEST);

    const second = ibkrAdapter(fake.client, reopen(path));
    const fills = await second.fetchNewFills(SINCE);

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'idem-1', leg: 'stop', qty: 10 });
  });

  it('still dedups a resubmitted client order id after a restart', async () => {
    const { path, db } = openFileStore();
    const fake = makeIbkrFake();

    await ibkrAdapter(fake.client, db).submitBracket(STOCK_REQUEST);
    await ibkrAdapter(fake.client, reopen(path)).submitBracket(STOCK_REQUEST);

    expect(fake.placeBracketOrder).toHaveBeenCalledTimes(1);
  });
});

describe('IbkrBrokerAdapter.getOrder', () => {
  it('reports the venue´s account of the order instead of throwing (#294)', async () => {
    const { db } = openFileStore();
    const fake = makeIbkrFake();
    fake.fetchOrderStatus.mockResolvedValue({
      clientOrderId: 'idem-1',
      parentOrderId: 'p1',
      stopOrderId: 's1',
      takeProfitOrderId: 't1',
      status: 'Filled',
      filledQuantity: 10,
    });

    const order = await ibkrAdapter(fake.client, db).getOrder('idem-1');

    expect(order).toEqual({
      client_order_id: 'idem-1',
      broker_order_ids: ['p1', 's1', 't1'],
      order_state: 'filled',
      filled_qty: 10,
    });
  });

  it('passes the venue´s authoritative "no such order" through as null', async () => {
    const { db } = openFileStore();
    const fake = makeIbkrFake();
    fake.fetchOrderStatus.mockResolvedValue(null);

    await expect(ibkrAdapter(fake.client, db).getOrder('idem-1')).resolves.toBeNull();
  });

  it('throws (never returns null) when the client cannot reach TWS', async () => {
    const { db } = openFileStore();
    const fake = makeIbkrFake();
    fake.fetchOrderStatus.mockRejectedValue(new Error('TWS socket closed'));

    // The null contract is narrow on purpose: reconcile reads null as "never
    // placed" and marks the lot rejected, so ignorance must throw.
    await expect(ibkrAdapter(fake.client, db).getOrder('idem-1')).rejects.toThrow();
  });

  it('reads a partially filled parent as partially_filled', async () => {
    const { db } = openFileStore();
    const fake = makeIbkrFake();
    fake.fetchOrderStatus.mockResolvedValue({
      clientOrderId: 'idem-1',
      parentOrderId: 'p1',
      stopOrderId: 's1',
      takeProfitOrderId: 't1',
      status: 'Submitted',
      filledQuantity: 4,
    });

    const order = await ibkrAdapter(fake.client, db).getOrder('idem-1');

    expect(order?.order_state).toBe('partially_filled');
  });

  it('reads TWS "Inactive" as submitted, never rejected', async () => {
    const { db } = openFileStore();
    const fake = makeIbkrFake();
    fake.fetchOrderStatus.mockResolvedValue({
      clientOrderId: 'idem-1',
      parentOrderId: 'p1',
      stopOrderId: null,
      takeProfitOrderId: null,
      status: 'Inactive',
      filledQuantity: 0,
    });

    // IBKR uses Inactive for both "rejected" and "not working right now".
    // Writing a live pending order off as rejected leaves a real position
    // nobody is watching; deferring a dead one costs a sweep.
    const order = await ibkrAdapter(fake.client, db).getOrder('idem-1');

    expect(order?.order_state).toBe('submitted');
    expect(order?.broker_order_ids).toEqual(['p1']);
  });

  it('rehydrates the leg index from the lookup, so the next fill sweep claims it', async () => {
    const { path, db } = openFileStore();
    const fake = makeIbkrFake([EXECUTION]);

    // A bracket this process never submitted — the post-restart reconcile case.
    const adapter = ibkrAdapter(fake.client, db);
    expect(await adapter.fetchNewFills(SINCE)).toEqual([]);

    await adapter.getOrder('idem-1');

    expect(await adapter.fetchNewFills(SINCE)).toHaveLength(1);
    // And it survives the NEXT restart too, because the lookup journalled it.
    const next = ibkrAdapter(fake.client, reopen(path));
    expect(await next.fetchNewFills(SINCE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Alpaca — the bracket index is a cache, but a load-bearing one
// ---------------------------------------------------------------------------

function alpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'parent-1',
    status: 'partially_filled',
    filled_qty: '1',
    filled_avg_price: '100',
    filled_at: FILL_TIME,
    legs: [
      {
        id: 'leg-stop',
        type: 'stop',
        status: 'new',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      },
      {
        id: 'leg-target',
        type: 'limit',
        status: 'new',
        filled_qty: '0',
        filled_avg_price: null,
        filled_at: null,
      },
    ],
    ...overrides,
  } as AlpacaOrder;
}

describe('AlpacaBrokerAdapter across a restart', () => {
  it('keeps polling fills for a lot that was already filling when the process died (#295)', async () => {
    const { path, db } = openFileStore();
    const order = alpacaOrder();
    const client = {
      submitOrder: vi.fn(async () => order),
      getOrder: vi.fn(async () => order),
      getOrderByClientOrderId: vi.fn(async () => order),
    } as unknown as AlpacaClient;

    const first = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(db),
    });
    await first.submitBracket(STOCK_REQUEST);

    // The lot is `partially_filled`, so `reconcile()` skips it and never calls
    // `getOrder` to warm the cache. Without the journal, `fetchNewFills` would
    // iterate an empty map and report "no new fills" forever.
    const second = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(reopen(path)),
    });
    const fills = await second.fetchNewFills(SINCE);

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'idem-1', leg: 'entry' });
  });
});

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

describe('SqliteBrokerStateStore', () => {
  it('scopes every read to one venue', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);
    const base = {
      client_order_id: 'shared-key',
      phase: 'armed' as const,
      entry_order_id: 'e',
      stop_order_id: null,
      target_order_id: null,
      request: null,
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    };

    store.saveBracket({ ...base, venue: 'ccxt' });
    store.saveBracket({ ...base, venue: 'ibkr', entry_order_id: 'e-ibkr' });

    expect(store.loadBrackets('ccxt')).toHaveLength(1);
    expect(store.loadBrackets('ibkr')[0]?.entry_order_id).toBe('e-ibkr');
    expect(store.loadBrackets('alpaca')).toEqual([]);
  });

  it('never blanks a request a submit recorded when a venue lookup follows', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.saveBracket({
      venue: 'alpaca',
      client_order_id: 'idem-1',
      phase: 'armed',
      entry_order_id: 'parent-1',
      stop_order_id: null,
      target_order_id: null,
      request: {
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'buy',
        size: 10,
        entry: 100,
        stop: 90,
        target: 120,
        time_in_force: 'GTC',
      },
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });

    // The rehydration path knows the ids and not the request; it must not
    // overwrite what the submit already knew.
    store.recordBracketOrderIds('alpaca', 'idem-1', {
      entry_order_id: 'parent-1',
      stop_order_id: 'leg-stop',
      target_order_id: 'leg-target',
    });

    const [record] = store.loadBrackets('alpaca');
    expect(record?.request?.instrument).toBe('AAPL');
    expect(record?.stop_order_id).toBe('leg-stop');
  });

  it('never forgets a venue order id a submit recorded when a later lookup omits it', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.saveBracket({
      venue: 'ibkr',
      client_order_id: 'idem-1',
      phase: 'armed',
      entry_order_id: 'p1',
      stop_order_id: 's1',
      target_order_id: 't1',
      request: null,
      armed_qty: null,
      arming_qty: null,
      arm_attempt: 0,
    });

    // The venue has since cancelled the children and no longer reports them.
    // Blanking the ids would drop them from IBKR's `legs` reverse index on the
    // next restart, and executions already booked under them would go
    // unclaimed — #295 reinstated by the fix that was meant to close it.
    store.recordBracketOrderIds('ibkr', 'idem-1', {
      entry_order_id: 'p1',
      stop_order_id: null,
      target_order_id: null,
    });

    const [record] = store.loadBrackets('ibkr');
    expect(record?.stop_order_id).toBe('s1');
    expect(record?.target_order_id).toBe('t1');
  });

  it('reports no request at all rather than a half-populated one', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.recordBracketOrderIds('ibkr', 'idem-1', {
      entry_order_id: 'p1',
      stop_order_id: null,
      target_order_id: null,
    });

    expect(store.loadBrackets('ibkr')[0]?.request).toBeNull();
  });

  it('is idempotent on re-observing the same fill', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);
    const fill = {
      client_order_id: 'idem-1',
      broker_fill_id: 'venue-idem-1',
      leg: 'entry' as const,
      price: 100,
      qty: 1,
      fee: 0.1,
      timestamp: new Date(FILL_TS),
    };

    store.saveObservedFill('ccxt', fill);
    // The feed re-offers the same aggregate order with a grown quantity.
    store.saveObservedFill('ccxt', { ...fill, qty: 2 });

    const loaded = store.loadObservedFills('ccxt');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.qty).toBe(2);
    expect(loaded[0]?.timestamp).toEqual(new Date(FILL_TS));
  });
});
