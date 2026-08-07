import type { ClosedTrade, Fill, OpenPosition } from '../shared/index.js';
import { type SharedStore as Db, openSharedStore } from '../shared/store/index.js';
import { SqliteExecutionStore } from './sqlite-shared-store.js';

const OPENED_AT = new Date('2026-07-20T14:00:00Z');
const DECISION_AT = new Date('2026-07-20T13:55:00Z');

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 95,
    target: 110,
    order_state: 'pending',
    broker_order_ids: [],
    opened_at: OPENED_AT,
    decision_timestamp: DECISION_AT,
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
}

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    idempotency_key: 'key-1',
    broker_fill_id: 'fill-1',
    leg: 'entry',
    price: 100,
    qty: 5,
    fee: 1,
    timestamp: new Date('2026-07-20T15:00:00Z'),
    ...overrides,
  };
}

function makeFlattenWriteAhead(
  overrides: Partial<Parameters<SqliteExecutionStore['writeAheadFlatten']>[0]> = {},
): Parameters<SqliteExecutionStore['writeAheadFlatten']>[0] {
  return {
    idempotency_key: 'flatten-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'sell',
    size: 25,
    submitted_at: OPENED_AT,
    lot_idempotency_keys: ['key-lot-1', 'key-lot-2'],
    ...overrides,
  };
}

function makeClosedTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 95,
    filled_size: 10,
    realized_pnl_net: 50,
    fees_total: 2,
    opened_at: OPENED_AT,
    closed_at: new Date('2026-07-20T16:00:00Z'),
    close_reason: 'target',
    ...overrides,
  };
}

function makeStore(): { db: Db; store: SqliteExecutionStore } {
  const db = openSharedStore(':memory:');
  return { db, store: new SqliteExecutionStore(db) };
}

describe('SqliteExecutionStore', () => {
  describe('writeAheadPosition / findByKey', () => {
    it('persists a pending row before any broker call, findable by key', async () => {
      const { store } = makeStore();
      expect(await store.findByKey('key-1')).toBe(false);

      await store.writeAheadPosition(makePosition());

      expect(await store.findByKey('key-1')).toBe(true);
      const [position] = await store.getOpenPositions();
      expect(position).toMatchObject({ idempotency_key: 'key-1', order_state: 'pending' });
    });

    it('a crash before ack leaves a recoverable orphan row for a fresh store instance over the same file', async () => {
      // Use a real file path (not :memory:) so "crash" (opening a NEW handle)
      // is meaningfully different from re-reading the same in-process db.
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const tmpDb = path.join(
        os.tmpdir(),
        `samurai-execution-store-test-${process.pid}-${Date.now()}.sqlite`,
      );
      const cleanup = () => {
        for (const suffix of ['', '-wal', '-shm']) {
          if (fs.existsSync(tmpDb + suffix)) fs.rmSync(tmpDb + suffix);
        }
      };
      cleanup();

      try {
        const db1 = openSharedStore(tmpDb);
        const store1 = new SqliteExecutionStore(db1);
        await store1.writeAheadPosition(makePosition());
        db1.close();

        const db2 = openSharedStore(tmpDb);
        const store2 = new SqliteExecutionStore(db2);
        const [orphan] = await store2.getOpenPositions();
        expect(orphan).toMatchObject({ idempotency_key: 'key-1', order_state: 'pending' });
        db2.close();
      } finally {
        cleanup();
      }
    });
  });

  describe('updatePositionState', () => {
    it('transitions pending -> submitted, persisting broker_order_ids', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      await store.updatePositionState('key-1', {
        order_state: 'submitted',
        broker_order_ids: ['key-1:entry', 'key-1:stop'],
      });

      const [position] = await store.getOpenPositions();
      expect(position).toMatchObject({
        order_state: 'submitted',
        broker_order_ids: ['key-1:entry', 'key-1:stop'],
      });
    });

    it('throws when there is no write-ahead record for the key', async () => {
      const { store } = makeStore();
      await expect(
        store.updatePositionState('missing', { order_state: 'submitted', broker_order_ids: [] }),
      ).rejects.toThrow(/no write-ahead record/);
    });
  });

  describe('getOpenPositions', () => {
    it('excludes terminal-state lots (closed/cancelled/rejected/expired)', async () => {
      const { store } = makeStore();
      const states = [
        'pending',
        'submitted',
        'closed',
        'cancelled',
        'rejected',
        'expired',
      ] as const;
      for (const [index, state] of states.entries()) {
        await store.writeAheadPosition(makePosition({ idempotency_key: `key-${index}` }));
        await store.updatePositionState(`key-${index}`, {
          order_state: state,
          broker_order_ids: [],
        });
      }

      const open = await store.getOpenPositions();
      expect(open.map((p) => p.idempotency_key).sort()).toEqual(['key-0', 'key-1']);
    });

    it('two different db instances never share state — physical paper/live isolation', async () => {
      const { store: storeA } = makeStore();
      const { store: storeB } = makeStore();

      await storeA.writeAheadPosition(makePosition());

      expect(await storeA.getOpenPositions()).toHaveLength(1);
      expect(await storeB.getOpenPositions()).toHaveLength(0);
    });

    /**
     * Simulates a lot written before migration 0004 added conviction/
     * converged — an INSERT that omits both columns entirely, so SQLite
     * applies the ALTER TABLE ... DEFAULT. conviction defaults to 1 (not 0)
     * specifically so a legacy lot's unknown true conviction can never look
     * like it "rose materially" against a live debate's confidence (capped
     * at 1.0) — it reads back as unable to scale-in, not eager to.
     */
    it('backfills a pre-migration row to conviction=1, converged=false — never spuriously scale-in eligible', async () => {
      const { db, store } = makeStore();
      db.prepare(
        `INSERT INTO open_positions (
           idempotency_key, debate_id, instrument, asset_class, side, intent_type,
           requested_size, filled_size, avg_entry_price, stop, target,
           order_state, broker_order_ids, opened_at, decision_timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'legacy-key',
        'debate-legacy',
        'AAPL',
        'stocks',
        'buy',
        'entry',
        10,
        10,
        100,
        95,
        110,
        'filled',
        '[]',
        OPENED_AT.toISOString(),
        DECISION_AT.toISOString(),
      );

      const [legacy] = await store.getOpenPositions();
      expect(legacy?.conviction).toBe(1);
      expect(legacy?.converged).toBe(false);
    });
  });

  describe('applyLotAdvance', () => {
    it('persists fills with hasFill/getFills dedup and round-trip against real rows', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      expect(await store.hasFill('fill-1')).toBe(false);
      await store.applyLotAdvance({ idempotency_key: 'key-1', fills: [makeFill()] });
      expect(await store.hasFill('fill-1')).toBe(true);

      const fills = await store.getFills('key-1');
      expect(fills).toHaveLength(1);
      expect(fills[0]).toMatchObject({ broker_fill_id: 'fill-1', qty: 5 });
    });

    it('preserves cost_breakdown for Simulated-adapter fills and omits it otherwise', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [
          makeFill({
            broker_fill_id: 'fill-sim',
            cost_breakdown: {
              spread_cost: 0.1,
              commission: 0.2,
              slippage: 0.05,
              market_impact: 0.01,
            },
          }),
          makeFill({ broker_fill_id: 'fill-real' }),
        ],
      });

      const [sim, real] = await store.getFills('key-1');
      expect(sim?.cost_breakdown).toEqual({
        spread_cost: 0.1,
        commission: 0.2,
        slippage: 0.05,
        market_impact: 0.01,
      });
      expect(real?.cost_breakdown).toBeUndefined();
    });

    it('returns fills in ingestion order', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [makeFill({ broker_fill_id: 'fill-a' }), makeFill({ broker_fill_id: 'fill-b' })],
      });
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [makeFill({ broker_fill_id: 'fill-c' })],
      });

      const fills = await store.getFills('key-1');
      expect(fills.map((f) => f.broker_fill_id)).toEqual(['fill-a', 'fill-b', 'fill-c']);
    });

    it('persists the fill-driven lot state alongside the fills', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [makeFill()],
        position_update: {
          filled_size: 5,
          avg_entry_price: 100,
          order_state: 'partially_filled',
        },
      });

      const [position] = await store.getOpenPositions();
      expect(position).toMatchObject({
        filled_size: 5,
        avg_entry_price: 100,
        order_state: 'partially_filled',
      });
    });

    it('writes the realized record exactly once; a second close for the same lot is rejected', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [],
        closed_trade: makeClosedTrade(),
      });
      await expect(
        store.applyLotAdvance({
          idempotency_key: 'key-1',
          fills: [],
          closed_trade: makeClosedTrade(),
        }),
      ).rejects.toThrow();
    });

    it('is atomic: when the close is rejected, the same advance leaves no fill rows behind', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [],
        closed_trade: makeClosedTrade(),
      });

      // Re-advance carrying both a new fill and a (duplicate) close: the close
      // rejection must roll the fill back too, or a crash-shaped partial write
      // becomes persistable state.
      await expect(
        store.applyLotAdvance({
          idempotency_key: 'key-1',
          fills: [makeFill({ broker_fill_id: 'fill-after-close' })],
          position_update: { filled_size: 5, avg_entry_price: 100, order_state: 'closed' },
          closed_trade: makeClosedTrade(),
        }),
      ).rejects.toThrow();

      expect(await store.hasFill('fill-after-close')).toBe(false);
      const [position] = await store.getOpenPositions();
      expect(position?.filled_size).toBe(0);
    });
  });

  describe('writeAheadFlatten / getFlattenLotKeys (#517)', () => {
    it('round-trips the lot identity through the journal, in the order it was written', async () => {
      const { store } = makeStore();

      await store.writeAheadFlatten(makeFlattenWriteAhead());

      expect(await store.getFlattenLotKeys('flatten-1')).toEqual(['key-lot-1', 'key-lot-2']);
    });

    it('returns null for a key that names no flatten submission', async () => {
      const { store } = makeStore();

      expect(await store.getFlattenLotKeys('never-submitted')).toBeNull();
    });

    // A flatten journalled before migration 0020 added the column has NULL
    // there, not an empty JSON array — `ingestFills()` (#517) must read that
    // as "cannot attribute", not throw trying to `JSON.parse(null)`.
    it('returns null, not a parse error, for a pre-migration row with no lot identity recorded', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-legacy' }));
      db.prepare(
        'UPDATE flatten_submissions SET lot_idempotency_keys = NULL WHERE idempotency_key = ?',
      ).run('flatten-legacy');

      expect(await store.getFlattenLotKeys('flatten-legacy')).toBeNull();
    });
  });

  // Review feedback on #524 (kimi): the same unvalidated-cast defect class
  // #509 closed repo-wide, freshly reintroduced by #517 if left unguarded.
  describe('getFlattenLotKeys — corrupted rows (#524 review)', () => {
    it('throws, naming the idempotency_key, when the stored value is not valid JSON', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-corrupt' }));
      db.prepare(
        'UPDATE flatten_submissions SET lot_idempotency_keys = ? WHERE idempotency_key = ?',
      ).run('{not json', 'flatten-corrupt');

      await expect(store.getFlattenLotKeys('flatten-corrupt')).rejects.toThrow(
        /flatten-corrupt' is not valid JSON/,
      );
    });

    it('throws, naming the idempotency_key, when the stored JSON is not an array of strings', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(
        makeFlattenWriteAhead({ idempotency_key: 'flatten-wrong-shape' }),
      );
      db.prepare(
        'UPDATE flatten_submissions SET lot_idempotency_keys = ? WHERE idempotency_key = ?',
      ).run(JSON.stringify({ not: 'an array' }), 'flatten-wrong-shape');

      await expect(store.getFlattenLotKeys('flatten-wrong-shape')).rejects.toThrow(
        /flatten-wrong-shape' is not a JSON array of strings/,
      );
    });

    it('throws for an array containing a non-string entry', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-mixed' }));
      db.prepare(
        'UPDATE flatten_submissions SET lot_idempotency_keys = ? WHERE idempotency_key = ?',
      ).run(JSON.stringify(['key-1', 42]), 'flatten-mixed');

      await expect(store.getFlattenLotKeys('flatten-mixed')).rejects.toThrow('flatten-mixed');
    });

    // The error must name the corrupt row so the failure is diagnosable at
    // the source — but never quote the corrupted value itself: since #507 an
    // uncaught throw here is durably recorded to `audit_log`, and the raw
    // column content is untrusted in exactly the way that record must not
    // carry.
    it('never quotes the corrupted raw value in the thrown error', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-secret' }));
      const poison = '{"leaked-marker-xyz": true';
      db.prepare(
        'UPDATE flatten_submissions SET lot_idempotency_keys = ? WHERE idempotency_key = ?',
      ).run(poison, 'flatten-secret');

      await expect(store.getFlattenLotKeys('flatten-secret')).rejects.not.toThrow(
        /leaked-marker-xyz/,
      );
    });
  });

  describe('getEntryFillSizes (#524 review — batch read, replacing one getFills call per lot)', () => {
    it("sums each named lot's entry fills in one call, omitting a lot with none", async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-lot-1' }));
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-lot-2' }));
      await store.applyLotAdvance({
        idempotency_key: 'key-lot-1',
        fills: [
          makeFill({ idempotency_key: 'key-lot-1', broker_fill_id: 'e1', leg: 'entry', qty: 4 }),
          makeFill({ idempotency_key: 'key-lot-1', broker_fill_id: 'e2', leg: 'entry', qty: 6 }),
        ],
      });
      await store.applyLotAdvance({
        idempotency_key: 'key-lot-2',
        fills: [
          makeFill({ idempotency_key: 'key-lot-2', broker_fill_id: 'e3', leg: 'entry', qty: 15 }),
        ],
      });

      const sizes = await store.getEntryFillSizes([
        'key-lot-1',
        'key-lot-2',
        'key-lot-never-filled',
      ]);

      expect(sizes.get('key-lot-1')).toBe(10);
      expect(sizes.get('key-lot-2')).toBe(15);
      // Absent, not present at 0 — mirrors `DashboardQueryStore.getMarks`'
      // own "missing is absent" answer, the shape this method follows.
      expect(sizes.has('key-lot-never-filled')).toBe(false);
    });

    it('excludes exit-leg fills from the sum', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-lot-1' }));
      await store.applyLotAdvance({
        idempotency_key: 'key-lot-1',
        fills: [
          makeFill({ idempotency_key: 'key-lot-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
          makeFill({ idempotency_key: 'key-lot-1', broker_fill_id: 'x1', leg: 'exit', qty: 4 }),
        ],
      });

      const sizes = await store.getEntryFillSizes(['key-lot-1']);

      expect(sizes.get('key-lot-1')).toBe(10);
    });

    it('returns an empty Map for an empty key list', async () => {
      const { store } = makeStore();

      expect(await store.getEntryFillSizes([])).toEqual(new Map());
    });
  });
});
