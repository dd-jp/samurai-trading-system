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
import { type Clock, TokenBucket, toBrokerFillId } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import { AlpacaBrokerAdapter } from './adapters/alpaca-adapter.js';
import type { AlpacaBrokerClient, AlpacaOrder } from './adapters/alpaca-client.js';
import type { BrokerVenue } from './broker-state-store.js';
import { InMemoryBrokerStateStore } from './broker-state-store.js';
import type { OcoDoubleFillAlertChannel } from './oco-double-fill-alert.js';
import { SqliteBrokerStateStore } from './sqlite-broker-state-store.js';
import type { NativeBracketRequest } from './types.js';
import type { UnpricedFillAlert, UnpricedFillAlertChannel } from './unpriced-fill-alert.js';

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

/** Pacing has its own suites; these are about state, not the wall clock */
function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

/** #298's age-out, stated here rather than inherited from the adapter's default */
const AGE_OUT_MS = 15 * 60_000;
const FIRST_SEEN = new Date(FILL_TS + 60_000);

/** A clock frozen at one instant — each "process" below gets its own */
function fixedClock(now: Date): Clock {
  return { now: () => now };
}

/** The operator escalation port (#298), recording what reached a human */
function recordingAlerts(): UnpricedFillAlertChannel & { readonly posted: UnpricedFillAlert[] } {
  const posted: UnpricedFillAlert[] = [];
  return {
    posted,
    postUnpricedFillAlert: async (alert) => {
      posted.push(alert);
    },
  };
}

/** #586's required seam — nothing in these cases can double-fill */
function noopDoubleFillAlerts(): OcoDoubleFillAlertChannel {
  return { postOcoDoubleFillAlert: async () => {} };
}

const tempDirs: string[] = [];
const openDbs: StoreHandle[] = [];

/** A real file, for the reason in the file header */
function openFileStore(): { path: string; db: StoreHandle } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-broker-state-'));
  tempDirs.push(dir);
  const path = join(dir, 'samurai-test.sqlite');
  return { path, db: reopen(path) };
}

/** A NEW connection over the same file — the "restart" */
function reopen(path: string): StoreHandle {
  const db = openSharedStore(path);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

// Alpaca — the bracket index is a cache, but a load-bearing one

function alpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'parent-1',
    // Alpaca reports the symbol on the bracket PARENT and not on its legs, so
    // it is the only source for the instrument an unpriced-fill alert names
    symbol: 'AAPL',
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
    } as unknown as AlpacaBrokerClient;

    const first = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(db),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: noopDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    await first.submitBracket(STOCK_REQUEST);

    // The lot is `partially_filled`, so `reconcile()` skips it and never calls
    // `getOrder` to warm the cache. Without the journal, `fetchNewFills` would
    // iterate an empty map and report "no new fills" forever
    const second = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(reopen(path)),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: noopDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    const fills = await second.fetchNewFills(SINCE);

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'idem-1', leg: 'entry' });
  });

  it('recovers a bracket whose journal write never happened, via the venue lookup', async () => {
    // PR #310 review (deepseek): "a crash between `submitOrder` and
    // `saveBracket` leaves an orphaned order at the broker with no local cache
    // entry". The order IS at the venue and the journal row is missing — but
    // for Alpaca that window is closed by an interlock rather than by a
    // placeholder row, and this test is the proof
    //
    // `execute()` writes the lot `pending` BEFORE calling the broker
    // (execute.ts) and only advances it to `submitted` AFTER `submitBracket`
    // RETURNS. So a missing journal row implies `submitBracket` did not
    // return, which implies the lot is still `pending`, which is in-flight
    // (reconcile.ts `IN_FLIGHT_ORDER_STATES`) — and startup reconcile runs before the first
    // fill poll. Alpaca's `getOrder` answers from the VENUE by client order
    // id, needing no local state, so it repopulates both cache and journal
    const { path, db } = openFileStore();
    const order = alpacaOrder();
    const client = {
      submitOrder: vi.fn(async () => order),
      getOrder: vi.fn(async () => order),
      getOrderByClientOrderId: vi.fn(async () => order),
    } as unknown as AlpacaBrokerClient;

    // The venue call lands; the journal write is what dies
    const dyingState = new SqliteBrokerStateStore(db);
    vi.spyOn(dyingState, 'saveBracket').mockImplementation(() => {
      throw new Error('simulated DB failure after the order reached the venue');
    });
    const first = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: dyingState,
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: noopDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    await expect(first.submitBracket(STOCK_REQUEST)).rejects.toThrow(/simulated DB failure/);

    // Nothing was journalled — the reviewer's premise, reproduced
    expect(new SqliteBrokerStateStore(db).loadBrackets('alpaca')).toEqual([]);

    // restart
    const second = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(reopen(path)),
      unpricedFillAlerts: recordingAlerts(),
      ocoDoubleFillAlerts: noopDoubleFillAlerts(),
      logger: recordingLogger(),
    });
    expect(await second.fetchNewFills(SINCE)).toEqual([]);

    // Startup reconcile settles the still-`pending` lot, which for Alpaca is a
    // direct venue query. That single call restores the cache AND the journal.
    await second.getOrder('idem-1', 'AAPL');

    expect(await second.fetchNewFills(SINCE)).toHaveLength(1);
    expect(new SqliteBrokerStateStore(db).loadBrackets('alpaca')[0]?.entry_order_id).toBe(
      'parent-1',
    );
  });

  it('keeps the unpriced-fill age-out clock running across a restart (#298)', async () => {
    // The durability requirement, and the reason the clock is a table rather
    // than a field on the adapter: a 14-day unattended soak (#238) contains
    // restarts, and an in-process clock resets to zero on every one of them
    // A fill the venue will never price would then be re-observed as "brand
    // new" forever and age out never — passing every in-process test while
    // failing the only scenario the ticket is about
    const { path, db } = openFileStore();
    const unpriced = alpacaOrder({
      status: 'filled',
      filled_qty: '1',
      filled_avg_price: null,
      filled_at: FILL_TIME,
    });
    const client = {
      submitOrder: vi.fn(async () => unpriced),
      getOrder: vi.fn(async () => unpriced),
      getOrderByClientOrderId: vi.fn(async () => unpriced),
    } as unknown as AlpacaBrokerClient;

    const firstAlerts = recordingAlerts();
    const first = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(db),
      unpricedFillAlerts: firstAlerts,
      ocoDoubleFillAlerts: noopDoubleFillAlerts(),
      logger: recordingLogger(),
      unpricedFillAgeOutMs: AGE_OUT_MS,
      clock: fixedClock(FIRST_SEEN),
    });
    await first.submitBracket(STOCK_REQUEST);

    // First process: the anomaly is seen and recorded, and is not yet old
    await first.fetchNewFills(SINCE).catch(() => undefined);
    expect(firstAlerts.posted).toEqual([]);

    // restart
    // A genuinely fresh adapter over the same database file: new bracket map,
    // new everything, and a clock reading one threshold later
    const secondAlerts = recordingAlerts();
    const second = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(reopen(path)),
      unpricedFillAlerts: secondAlerts,
      ocoDoubleFillAlerts: noopDoubleFillAlerts(),
      logger: recordingLogger(),
      unpricedFillAgeOutMs: AGE_OUT_MS,
      clock: fixedClock(new Date(FIRST_SEEN.getTime() + AGE_OUT_MS)),
    });

    // On its FIRST sweep — not merely eventually. A restart that restarted the
    // clock would instead have to wait out another full threshold here, which
    // is exactly the bug, and "it alerts eventually" would not catch it
    await second.fetchNewFills(SINCE).catch(() => undefined);

    expect(secondAlerts.posted).toMatchObject([
      {
        venue: 'alpaca',
        client_order_id: 'idem-1',
        broker_fill_id: toBrokerFillId('parent-1'),
        leg: 'entry',
        instrument: 'AAPL',
        qty: 1,
        // Stamped by the FIRST process, read back by the second
        first_seen_at: FIRST_SEEN,
        unpriced_for_ms: AGE_OUT_MS,
      },
    ]);
  });
});

// The store itself

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

    store.saveBracket({ ...base, venue: 'alpaca' });
    store.saveBracket({ ...base, venue: 'saxo', entry_order_id: 'e-saxo' });

    expect(store.loadBrackets('alpaca')).toHaveLength(1);
    expect(store.loadBrackets('alpaca')[0]?.entry_order_id).toBe('e');
    expect(store.loadBrackets('saxo')).toHaveLength(1);
    expect(store.loadBrackets('saxo')[0]?.entry_order_id).toBe('e-saxo');
  });

  it("rejects 'ccxt'/'ibkr' on broker_brackets and broker_unpriced_fills (migration 0055 dropped both venues)", () => {
    const { db } = openFileStore();

    expect(() =>
      db
        .prepare(
          `INSERT INTO broker_brackets (venue, client_order_id, phase, arm_attempt, updated_at)
           VALUES ('ccxt', 'k', 'armed', 0, '2026-09-09T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db
        .prepare(
          `INSERT INTO broker_unpriced_fills (
             venue, client_order_id, broker_fill_id, leg, instrument, qty, first_seen_at, last_seen_at
           ) VALUES ('ibkr', 'k', 'f', 'entry', 'AAPL', 1, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("accepts 'saxo' on broker_unpriced_fills (migration 0048)", () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.recordUnpricedFill(
      'saxo',
      {
        client_order_id: 'k',
        broker_fill_id: toBrokerFillId('bf'),
        leg: 'entry',
        instrument: '3USL',
        qty: 1,
      },
      new Date('2026-09-05T09:00:00Z'),
    );

    expect(store.loadUnpricedFills('saxo')).toHaveLength(1);
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
    // overwrite what the submit already knew
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
      venue: 'saxo',
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

    // The venue has since cancelled the children and no longer reports them
    // Blanking the ids would drop them from the adapter's own order-id index
    // on the next restart, and executions already booked under them would go
    // unclaimed — #295 reinstated by the fix that was meant to close it
    store.recordBracketOrderIds('saxo', 'idem-1', {
      entry_order_id: 'p1',
      stop_order_id: null,
      target_order_id: null,
    });

    const [record] = store.loadBrackets('saxo');
    expect(record?.stop_order_id).toBe('s1');
    expect(record?.target_order_id).toBe('t1');
  });

  it('reports no request at all rather than a half-populated one', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.recordBracketOrderIds('saxo', 'idem-1', {
      entry_order_id: 'p1',
      stop_order_id: null,
      target_order_id: null,
    });

    expect(store.loadBrackets('saxo')[0]?.request).toBeNull();
  });
});

describe('InMemoryBrokerStateStore.loadUnpricedFills ordering (#1340)', () => {
  const unpriced = (clientOrderId: string, brokerFillId: string) => ({
    client_order_id: clientOrderId,
    broker_fill_id: brokerFillId,
    leg: 'entry' as const,
    instrument: '3USL',
    qty: 1,
  });

  it('returns rows oldest-first even when seenAt is non-monotonic across inserts', () => {
    // Recorded out of clock order: `late` is inserted first (earlier Map
    // position) but its `first_seen_at` is LATER than `early`'s. Insertion
    // order and clock order disagree here, which is exactly the case the
    // interface doc's "oldest first" promise, and Map iteration order alone,
    // do not agree on
    const store = new InMemoryBrokerStateStore();
    store.recordUnpricedFill(
      'alpaca',
      unpriced('lot-late', 'bf-late'),
      new Date('2026-09-05T12:00:00Z'),
    );
    store.recordUnpricedFill(
      'alpaca',
      unpriced('lot-early', 'bf-early'),
      new Date('2026-09-05T09:00:00Z'),
    );

    expect(store.loadUnpricedFills('alpaca').map((row) => row.client_order_id)).toEqual([
      'lot-early',
      'lot-late',
    ]);
  });

  it('breaks a first_seen_at tie by insertion order, mirroring SQL rowid', () => {
    // Three rows share one `first_seen_at`. The SQL implementation's tiebreak
    // is `rowid`, i.e. the order rows were physically inserted; the double's
    // faithful analogue is Map insertion order, since `recordUnpricedFill`'s
    // upsert (`Map.set` on an existing key) leaves a row's position exactly
    // where SQLite's `ON CONFLICT DO UPDATE` leaves its rowid — untouched
    const store = new InMemoryBrokerStateStore();
    const tie = new Date('2026-09-05T09:00:00Z');
    store.recordUnpricedFill('alpaca', unpriced('lot-first', 'bf-1'), tie);
    store.recordUnpricedFill('alpaca', unpriced('lot-second', 'bf-2'), tie);
    store.recordUnpricedFill('alpaca', unpriced('lot-third', 'bf-3'), tie);

    expect(store.loadUnpricedFills('alpaca').map((row) => row.client_order_id)).toEqual([
      'lot-first',
      'lot-second',
      'lot-third',
    ]);
  });

  it('keeps a re-observed row at its original insertion position for the tiebreak', () => {
    // `lot-a` is re-observed (upserted) AFTER `lot-b` is first recorded, at the
    // same first_seen_at. If the upsert moved `lot-a` to the end of Map
    // iteration order, the tiebreak would silently stop mirroring rowid, and
    // this would return ['lot-b', 'lot-a'] instead
    const store = new InMemoryBrokerStateStore();
    const tie = new Date('2026-09-05T09:00:00Z');
    store.recordUnpricedFill('alpaca', unpriced('lot-a', 'bf-a'), tie);
    store.recordUnpricedFill('alpaca', unpriced('lot-b', 'bf-b'), tie);
    store.recordUnpricedFill('alpaca', unpriced('lot-a', 'bf-a'), tie);

    expect(store.loadUnpricedFills('alpaca').map((row) => row.client_order_id)).toEqual([
      'lot-a',
      'lot-b',
    ]);
  });
});

describe('loadUnpricedFills ordering parity: InMemory vs Sqlite (#1358)', () => {
  interface SeedOp {
    venue: BrokerVenue;
    clientOrderId: string;
    brokerFillId: string;
    seenAt: Date;
  }

  const observation = (clientOrderId: string, brokerFillId: string) => ({
    client_order_id: clientOrderId,
    broker_fill_id: brokerFillId,
    leg: 'entry' as const,
    instrument: '3USL',
    qty: 1,
  });

  /**
   * Seeds a fresh in-memory double and a fresh SQLite store — a real
   * `better-sqlite3` handle, migrated same as production — with the same
   * ops in the same order, so any order divergence between the two
   * implementations is the ONLY thing that can move the assertion
   */
  function seedBoth(ops: readonly SeedOp[]): {
    inMemory: InMemoryBrokerStateStore;
    sqlite: SqliteBrokerStateStore;
  } {
    const inMemory = new InMemoryBrokerStateStore();
    const db = openSharedStore(':memory:');
    openDbs.push(db);
    const sqlite = new SqliteBrokerStateStore(db);
    for (const op of ops) {
      const row = observation(op.clientOrderId, op.brokerFillId);
      inMemory.recordUnpricedFill(op.venue, row, op.seenAt);
      sqlite.recordUnpricedFill(op.venue, row, op.seenAt);
    }
    return { inMemory, sqlite };
  }

  function bothOrders(
    stores: { inMemory: InMemoryBrokerStateStore; sqlite: SqliteBrokerStateStore },
    venue: BrokerVenue,
  ): { inMemory: string[]; sqlite: string[] } {
    return {
      inMemory: stores.inMemory.loadUnpricedFills(venue).map((row) => row.client_order_id),
      sqlite: stores.sqlite.loadUnpricedFills(venue).map((row) => row.client_order_id),
    };
  }

  it('orders distinct rows by monotonic seenAt, identically on both stores', () => {
    const stores = seedBoth([
      {
        venue: 'alpaca',
        clientOrderId: 'lot-1',
        brokerFillId: 'bf-1',
        seenAt: new Date('2026-09-05T09:00:00Z'),
      },
      {
        venue: 'alpaca',
        clientOrderId: 'lot-2',
        brokerFillId: 'bf-2',
        seenAt: new Date('2026-09-05T09:01:00Z'),
      },
      {
        venue: 'alpaca',
        clientOrderId: 'lot-3',
        brokerFillId: 'bf-3',
        seenAt: new Date('2026-09-05T09:02:00Z'),
      },
    ]);

    expect(bothOrders(stores, 'alpaca')).toEqual({
      inMemory: ['lot-1', 'lot-2', 'lot-3'],
      sqlite: ['lot-1', 'lot-2', 'lot-3'],
    });
  });

  it('orders by first_seen_at, not insertion order, when seenAt is non-monotonic, identically on both stores', () => {
    const stores = seedBoth([
      {
        venue: 'alpaca',
        clientOrderId: 'lot-late',
        brokerFillId: 'bf-late',
        seenAt: new Date('2026-09-05T12:00:00Z'),
      },
      {
        venue: 'alpaca',
        clientOrderId: 'lot-early',
        brokerFillId: 'bf-early',
        seenAt: new Date('2026-09-05T09:00:00Z'),
      },
    ]);

    expect(bothOrders(stores, 'alpaca')).toEqual({
      inMemory: ['lot-early', 'lot-late'],
      sqlite: ['lot-early', 'lot-late'],
    });
  });

  it('breaks a first_seen_at tie by physical insertion order, identically on both stores', () => {
    // Ids run in DESCENDING alphabetical order (zebra, mango, apple) —
    // client_order_id is part of the table's primary key, so a planner that
    // seeks that index would sort ties ASCENDING alphabetically instead of
    // by insertion, giving ['lot-apple', 'lot-mango', 'lot-zebra']. Ascending
    // ids would let that divergence hide behind agreement with insertion order
    const tie = new Date('2026-09-05T09:00:00Z');
    const stores = seedBoth([
      { venue: 'alpaca', clientOrderId: 'lot-zebra', brokerFillId: 'bf-1', seenAt: tie },
      { venue: 'alpaca', clientOrderId: 'lot-mango', brokerFillId: 'bf-2', seenAt: tie },
      { venue: 'alpaca', clientOrderId: 'lot-apple', brokerFillId: 'bf-3', seenAt: tie },
    ]);

    expect(bothOrders(stores, 'alpaca')).toEqual({
      inMemory: ['lot-zebra', 'lot-mango', 'lot-apple'],
      sqlite: ['lot-zebra', 'lot-mango', 'lot-apple'],
    });
  });

  it('leaves a re-observed row at its original tiebreak position, identically on both stores', () => {
    // `lot-zebra` is re-observed (upserted) AFTER `lot-apple` is first
    // recorded, at the same first_seen_at — the upsert must not move it to
    // the end. `zebra`/`apple` (not `a`/`b`) so an alphabetical tiebreak
    // would visibly disagree with the asserted insertion order
    const tie = new Date('2026-09-05T09:00:00Z');
    const stores = seedBoth([
      { venue: 'alpaca', clientOrderId: 'lot-zebra', brokerFillId: 'bf-z', seenAt: tie },
      { venue: 'alpaca', clientOrderId: 'lot-apple', brokerFillId: 'bf-a', seenAt: tie },
      { venue: 'alpaca', clientOrderId: 'lot-zebra', brokerFillId: 'bf-z', seenAt: tie },
    ]);

    expect(bothOrders(stores, 'alpaca')).toEqual({
      inMemory: ['lot-zebra', 'lot-apple'],
      sqlite: ['lot-zebra', 'lot-apple'],
    });
  });

  it('keeps each venue in its own order when two venues are interleaved, identically on both stores', () => {
    // The `WHERE venue = ?` predicate must not disturb the surviving rows'
    // relative order for the venue actually loaded. `alpaca-zebra` and
    // `alpaca-apple` additionally tie on `first_seen_at` and run reverse-
    // alphabetical, so the predicate is exercised alongside the tiebreak too
    // — not just against distinct-seenAt rows the predicate could pass
    // through unchanged either way
    const tie = new Date('2026-09-05T09:02:00Z');
    const stores = seedBoth([
      {
        venue: 'alpaca',
        clientOrderId: 'alpaca-1',
        brokerFillId: 'bf-1',
        seenAt: new Date('2026-09-05T09:00:00Z'),
      },
      {
        venue: 'saxo',
        clientOrderId: 'saxo-1',
        brokerFillId: 'bf-1',
        seenAt: new Date('2026-09-05T09:01:00Z'),
      },
      { venue: 'alpaca', clientOrderId: 'alpaca-zebra', brokerFillId: 'bf-2', seenAt: tie },
      { venue: 'alpaca', clientOrderId: 'alpaca-apple', brokerFillId: 'bf-3', seenAt: tie },
      {
        venue: 'saxo',
        clientOrderId: 'saxo-2',
        brokerFillId: 'bf-2',
        seenAt: new Date('2026-09-05T09:03:00Z'),
      },
    ]);

    expect(bothOrders(stores, 'alpaca')).toEqual({
      inMemory: ['alpaca-1', 'alpaca-zebra', 'alpaca-apple'],
      sqlite: ['alpaca-1', 'alpaca-zebra', 'alpaca-apple'],
    });
    expect(bothOrders(stores, 'saxo')).toEqual({
      inMemory: ['saxo-1', 'saxo-2'],
      sqlite: ['saxo-1', 'saxo-2'],
    });
  });
});
