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
import { type Clock, TokenBucket } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { type SharedStore as Db, openSharedStore } from '../../shared/store/index.js';
import { AlpacaBrokerAdapter } from './adapters/alpaca-adapter.js';
import type { AlpacaBrokerClient, AlpacaOrder } from './adapters/alpaca-client.js';
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

/** Pacing has its own suites; these are about state, not the wall clock. */
function permissiveLimiter(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

/** #298's age-out, stated here rather than inherited from the adapter's default. */
const AGE_OUT_MS = 15 * 60_000;
const FIRST_SEEN = new Date(FILL_TS + 60_000);

/** A clock frozen at one instant — each "process" below gets its own. */
function fixedClock(now: Date): Clock {
  return { now: () => now };
}

/** The operator escalation port (#298), recording what reached a human. */
function recordingAlerts(): UnpricedFillAlertChannel & { readonly posted: UnpricedFillAlert[] } {
  const posted: UnpricedFillAlert[] = [];
  return {
    posted,
    postUnpricedFillAlert: async (alert) => {
      posted.push(alert);
    },
  };
}

/** #586's required seam — nothing in these cases can double-fill. */
function noopDoubleFillAlerts(): OcoDoubleFillAlertChannel {
  return { postOcoDoubleFillAlert: async () => {} };
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
// Alpaca — the bracket index is a cache, but a load-bearing one
// ---------------------------------------------------------------------------

function alpacaOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  return {
    id: 'parent-1',
    // Alpaca reports the symbol on the bracket PARENT and not on its legs, so
    // it is the only source for the instrument an unpriced-fill alert names.
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
    // iterate an empty map and report "no new fills" forever.
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
    // placeholder row, and this test is the proof.
    //
    // `execute()` writes the lot `pending` BEFORE calling the broker
    // (execute.ts) and only advances it to `submitted` AFTER `submitBracket`
    // RETURNS. So a missing journal row implies `submitBracket` did not
    // return, which implies the lot is still `pending`, which is in-flight
    // (reconcile.ts `IN_FLIGHT`) — and startup reconcile runs before the first
    // fill poll. Alpaca's `getOrder` answers from the VENUE by client order
    // id, needing no local state, so it repopulates both cache and journal.
    const { path, db } = openFileStore();
    const order = alpacaOrder();
    const client = {
      submitOrder: vi.fn(async () => order),
      getOrder: vi.fn(async () => order),
      getOrderByClientOrderId: vi.fn(async () => order),
    } as unknown as AlpacaBrokerClient;

    // The venue call lands; the journal write is what dies.
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

    // Nothing was journalled — the reviewer's premise, reproduced.
    expect(new SqliteBrokerStateStore(db).loadBrackets('alpaca')).toEqual([]);

    // --- restart ------------------------------------------------------------
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
    // restarts, and an in-process clock resets to zero on every one of them.
    // A fill the venue will never price would then be re-observed as "brand
    // new" forever and age out never — passing every in-process test while
    // failing the only scenario the ticket is about.
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

    // First process: the anomaly is seen and recorded, and is not yet old.
    await first.fetchNewFills(SINCE).catch(() => undefined);
    expect(firstAlerts.posted).toEqual([]);

    // --- restart -------------------------------------------------------------
    // A genuinely fresh adapter over the same database file: new bracket map,
    // new everything, and a clock reading one threshold later.
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
    // is exactly the bug, and "it alerts eventually" would not catch it.
    await second.fetchNewFills(SINCE).catch(() => undefined);

    expect(secondAlerts.posted).toMatchObject([
      {
        venue: 'alpaca',
        client_order_id: 'idem-1',
        broker_fill_id: 'parent-1',
        leg: 'entry',
        instrument: 'AAPL',
        qty: 1,
        // Stamped by the FIRST process, read back by the second.
        first_seen_at: FIRST_SEEN,
        unpriced_for_ms: AGE_OUT_MS,
      },
    ]);
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
    store.saveBracket({ ...base, venue: 'saxo', entry_order_id: 'e-saxo' });

    expect(store.loadBrackets('ccxt')).toHaveLength(1);
    expect(store.loadBrackets('ibkr')[0]?.entry_order_id).toBe('e-ibkr');
    expect(store.loadBrackets('saxo')[0]?.entry_order_id).toBe('e-saxo');
    expect(store.loadBrackets('alpaca')).toEqual([]);
  });

  it("accepts 'saxo' on every venue-checked table (migration 0048)", () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.saveObservedFill('saxo', {
      client_order_id: 'k',
      broker_fill_id: 'bf',
      leg: 'entry',
      price: 10,
      qty: 1,
      fee: 0.008,
      timestamp: new Date('2026-09-05T09:00:00Z'),
    });
    store.recordUnpricedFill(
      'saxo',
      { client_order_id: 'k', broker_fill_id: 'bf', leg: 'entry', instrument: '3USL', qty: 1 },
      new Date('2026-09-05T09:00:00Z'),
    );

    expect(store.loadObservedFills('saxo')).toHaveLength(1);
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

/**
 * Puts a row in `fills`, which is what "ingestFills() has consumed this" means
 * to the prune. Written with SQL rather than through `ingestFills()` itself:
 * the retention rule is about the LEDGER's contents, and driving a whole
 * ingest pass here would test the ingest path instead of the rule.
 */
function ingest(db: Db, idempotencyKey: string, brokerFillId: string): void {
  db.prepare(
    `INSERT INTO fills (idempotency_key, broker_fill_id, leg, price, qty, fee, timestamp)
     VALUES (?, ?, 'entry', 100, 1, 0.1, ?)`,
  ).run(idempotencyKey, brokerFillId, FILL_TIME);
}

describe('pruneIngestedObservedFills (#313)', () => {
  const OBSERVED = {
    client_order_id: 'lot-prune-1',
    broker_fill_id: 'bf-prune-1',
    leg: 'entry' as const,
    price: 100,
    qty: 1,
    fee: 0.1,
    timestamp: new Date(FILL_TS),
  };

  it('drops a queue row once ingestFills has consumed it, and leaves the rest', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.saveObservedFill('ccxt', OBSERVED);
    store.saveObservedFill('ccxt', {
      ...OBSERVED,
      client_order_id: 'lot-prune-2',
      broker_fill_id: 'bf-prune-2',
    });

    // Nothing ingested yet: this is exactly the state a crash must preserve,
    // so the prune must not touch it.
    expect(store.pruneIngestedObservedFills('ccxt')).toBe(0);
    expect(store.loadObservedFills('ccxt')).toHaveLength(2);

    ingest(db, 'lot-prune-1', 'bf-prune-1');

    expect(store.pruneIngestedObservedFills('ccxt')).toBe(1);
    expect(store.loadObservedFills('ccxt').map((fill) => fill.broker_fill_id)).toEqual([
      'bf-prune-2',
    ]);
  });

  it('leaves a re-offered pruned fill still deduplicated', () => {
    // The failure the ticket names, and the reason pruning looked dangerous.
    // It is not: dedup never lived in `broker_observed_fills`. `ingestFills`
    // gates on `hasFill`, which reads `fills` — a permanent ledger the prune
    // does not touch — so a venue re-offering a pruned fill is caught exactly
    // as it was before the row went.
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.saveObservedFill('ccxt', OBSERVED);
    ingest(db, 'lot-prune-1', 'bf-prune-1');
    expect(store.pruneIngestedObservedFills('ccxt')).toBe(1);
    expect(store.loadObservedFills('ccxt')).toEqual([]);

    // The dedup gate still answers yes with the queue row gone. This is the
    // assertion the whole retention rule rests on.
    const stillKnown = db.prepare('SELECT 1 FROM fills WHERE broker_fill_id = ?').get('bf-prune-1');
    expect(stillKnown).toBeDefined();
  });

  it('is scoped to one venue', () => {
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    store.saveObservedFill('ccxt', OBSERVED);
    store.saveObservedFill('ibkr', OBSERVED);
    ingest(db, 'lot-prune-1', 'bf-prune-1');

    expect(store.pruneIngestedObservedFills('ccxt')).toBe(1);
    expect(store.loadObservedFills('ibkr')).toHaveLength(1);
  });

  it("does not let one venue's ingested fill prune another venue's uningested row", () => {
    // `broker_fill_id` is VENUE-ASSIGNED, so two venues can hand out the same
    // id string, and `fills` has no venue column to tell them apart. A prune
    // matching on `broker_fill_id` alone would therefore let ibkr's ingested
    // fill delete ccxt's queue row for a fill nobody has consumed — losing it
    // if the process died before the next poll, which is the exact crash this
    // queue exists to survive.
    //
    // The two rows share an id and differ in lot, which is what makes this
    // discriminating: the earlier scoping test gives both venues the SAME lot,
    // so it cannot tell whose row the ledger entry accounted for.
    const { db } = openFileStore();
    const store = new SqliteBrokerStateStore(db);

    const sharedId = 'bf-collision';
    store.saveObservedFill('ibkr', {
      ...OBSERVED,
      client_order_id: 'lot-ibkr',
      broker_fill_id: sharedId,
    });
    store.saveObservedFill('ccxt', {
      ...OBSERVED,
      client_order_id: 'lot-ccxt',
      broker_fill_id: sharedId,
    });

    // Only IBKR's has been ingested.
    ingest(db, 'lot-ibkr', sharedId);

    // ccxt's row must survive: nothing has consumed it.
    expect(store.pruneIngestedObservedFills('ccxt')).toBe(0);
    expect(store.loadObservedFills('ccxt')).toHaveLength(1);

    // ...and ibkr's must still go, so the fix did not simply stop pruning.
    expect(store.pruneIngestedObservedFills('ibkr')).toBe(1);
    expect(store.loadObservedFills('ibkr')).toEqual([]);
  });
});
