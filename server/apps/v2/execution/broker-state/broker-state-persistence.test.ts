import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeBracketRequest } from '../../../../shared/index.js';
import { type Clock, TokenBucket, toBrokerFillId } from '../../../../shared/index.js';
import { recordingLogger } from '../../../../shared/recording-logger.js';
import { openSharedStore, type StoreHandle } from '../../../../shared/store/index.js';
import { AlpacaBrokerAdapter } from '../alpaca/alpaca-adapter.js';
import type { AlpacaBrokerClient, AlpacaOrder } from '../alpaca/alpaca-client.js';
import type { UnpricedFillAlert, UnpricedFillAlertChannel } from '../alpaca/unpriced-fill-alert.js';
import type { BrokerVenue } from './broker-state-store.js';
import { InMemoryBrokerStateStore } from './broker-state-store.js';
import { SqliteBrokerStateStore } from './sqlite-broker-state-store.js';

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

function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

const AGE_OUT_MS = 15 * 60_000;
const FIRST_SEEN = new Date(FILL_TS + 60_000);

function fixedClock(now: Date): Clock {
  return { now: () => now };
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

const tempDirs: string[] = [];
const openDbs: StoreHandle[] = [];

function openFileStore(): { path: string; db: StoreHandle } {
  const dir = mkdtempSync(join(tmpdir(), 'samurai-broker-state-'));
  tempDirs.push(dir);
  const path = join(dir, 'samurai-test.sqlite');
  return { path, db: reopen(path) };
}

function reopen(path: string): StoreHandle {
  const db = openSharedStore(path);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function alpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'parent-1',
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
      logger: recordingLogger(),
    });
    await first.submitBracket(STOCK_REQUEST);

    const second = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(reopen(path)),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    const fills = await second.fetchNewFills(SINCE);

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ client_order_id: 'idem-1', leg: 'entry' });
  });

  it('recovers a bracket whose journal write never happened, via the venue lookup', async () => {
    const { path, db } = openFileStore();
    const order = alpacaOrder();
    const client = {
      submitOrder: vi.fn(async () => order),
      getOrder: vi.fn(async () => order),
      getOrderByClientOrderId: vi.fn(async () => order),
    } as unknown as AlpacaBrokerClient;

    const dyingState = new SqliteBrokerStateStore(db);
    vi.spyOn(dyingState, 'saveBracket').mockImplementation(() => {
      throw new Error('simulated DB failure after the order reached the venue');
    });
    const first = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: dyingState,
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    await expect(first.submitBracket(STOCK_REQUEST)).rejects.toThrow(/simulated DB failure/);

    expect(new SqliteBrokerStateStore(db).loadBrackets('alpaca')).toEqual([]);

    const second = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(reopen(path)),
      unpricedFillAlerts: recordingAlerts(),
      logger: recordingLogger(),
    });
    expect(await second.fetchNewFills(SINCE)).toEqual([]);

    await second.getOrder('idem-1', 'AAPL');

    expect(await second.fetchNewFills(SINCE)).toHaveLength(1);
    expect(new SqliteBrokerStateStore(db).loadBrackets('alpaca')[0]?.entry_order_id).toBe(
      'parent-1',
    );
  });

  it('keeps the unpriced-fill age-out clock running across a restart (#298)', async () => {
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
      logger: recordingLogger(),
      unpricedFillAgeOutMs: AGE_OUT_MS,
      clock: fixedClock(FIRST_SEEN),
    });
    await first.submitBracket(STOCK_REQUEST);

    await first.fetchNewFills(SINCE).catch(() => undefined);
    expect(firstAlerts.posted).toEqual([]);

    const secondAlerts = recordingAlerts();
    const second = new AlpacaBrokerAdapter({
      client,
      rateLimiter: permissiveLimiter(),
      state: new SqliteBrokerStateStore(reopen(path)),
      unpricedFillAlerts: secondAlerts,
      logger: recordingLogger(),
      unpricedFillAgeOutMs: AGE_OUT_MS,
      clock: fixedClock(new Date(FIRST_SEEN.getTime() + AGE_OUT_MS)),
    });

    await second.fetchNewFills(SINCE).catch(() => undefined);

    expect(secondAlerts.posted).toMatchObject([
      {
        venue: 'alpaca',
        client_order_id: 'idem-1',
        broker_fill_id: toBrokerFillId('parent-1'),
        leg: 'entry',
        instrument: 'AAPL',
        qty: 1,
        first_seen_at: FIRST_SEEN,
        unpriced_for_ms: AGE_OUT_MS,
      },
    ]);
  });
});

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
