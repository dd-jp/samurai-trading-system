import { describe, expect, it } from 'vitest';
import { type SharedStore as Db, openSharedStore } from '../shared/store/open-shared-store.js';
import type { ClosedTrade, Fill, OpenPosition } from '../shared/types.js';
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
  });

  describe('fills', () => {
    it('hasFill/writeFill/getFills dedup and round-trip against real persisted rows', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      expect(await store.hasFill('fill-1')).toBe(false);
      await store.writeFill(makeFill());
      expect(await store.hasFill('fill-1')).toBe(true);

      const fills = await store.getFills('key-1');
      expect(fills).toHaveLength(1);
      expect(fills[0]).toMatchObject({ broker_fill_id: 'fill-1', qty: 5 });
    });

    it('preserves cost_breakdown for Simulated-adapter fills and omits it otherwise', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());
      await store.writeFill(
        makeFill({
          broker_fill_id: 'fill-sim',
          cost_breakdown: {
            spread_cost: 0.1,
            commission: 0.2,
            slippage: 0.05,
            market_impact: 0.01,
          },
        }),
      );
      await store.writeFill(makeFill({ broker_fill_id: 'fill-real' }));

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
      await store.writeFill(makeFill({ broker_fill_id: 'fill-a' }));
      await store.writeFill(makeFill({ broker_fill_id: 'fill-b' }));
      await store.writeFill(makeFill({ broker_fill_id: 'fill-c' }));

      const fills = await store.getFills('key-1');
      expect(fills.map((f) => f.broker_fill_id)).toEqual(['fill-a', 'fill-b', 'fill-c']);
    });
  });

  describe('updatePositionFill', () => {
    it('persists a fill-driven advance of the lot', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      await store.updatePositionFill('key-1', {
        filled_size: 5,
        avg_entry_price: 100,
        order_state: 'partially_filled',
      });

      const [position] = await store.getOpenPositions();
      expect(position).toMatchObject({
        filled_size: 5,
        avg_entry_price: 100,
        order_state: 'partially_filled',
      });
    });
  });

  describe('writeClosedTrade', () => {
    it('writes the realized record exactly once; a second write for the same lot is rejected', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      await store.writeClosedTrade(makeClosedTrade());
      await expect(store.writeClosedTrade(makeClosedTrade())).rejects.toThrow();
    });
  });
});
