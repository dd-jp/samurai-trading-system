import type { ClosedTrade, Fill, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../shared/store/index.js';
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
    broker_fill_id: toBrokerFillId('fill-1'),
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
    lot_held_quantities: [
      { idempotency_key: 'key-lot-1', held: 10 },
      { idempotency_key: 'key-lot-2', held: 15 },
    ],
    exit_reason: 'flatten',
    decision_price: null,
    quote_bid: null,
    quote_ask: null,
    quote_mid: null,
    quote_observed_at: null,
    modelled_cost_breakdown: null,
    ...overrides,
  };
}

function overwriteJournalColumn(
  db: StoreHandle,
  column: 'lot_idempotency_keys' | 'lot_held_quantities' | 'modelled_cost_breakdown_json',
  idempotency_key: string,
  raw: string | null,
): void {
  const sql =
    column === 'lot_idempotency_keys'
      ? 'UPDATE flatten_submissions SET lot_idempotency_keys = ? WHERE idempotency_key = ?'
      : column === 'lot_held_quantities'
        ? 'UPDATE flatten_submissions SET lot_held_quantities = ? WHERE idempotency_key = ?'
        : 'UPDATE flatten_submissions SET modelled_cost_breakdown_json = ? WHERE idempotency_key = ?';
  db.prepare(sql).run(raw, idempotency_key);
}

function overwritePositionCostBreakdown(
  db: StoreHandle,
  idempotency_key: string,
  raw: string | null,
): void {
  db.prepare(
    'UPDATE open_positions SET modelled_cost_breakdown_json = ? WHERE idempotency_key = ?',
  ).run(raw, idempotency_key);
}

function readFlattenRow(
  db: StoreHandle,
  idempotency_key: string,
):
  | {
      status: string;
      order_state: string | null;
      broker_order_ids: string | null;
      resolved_at: string | null;
    }
  | undefined {
  return db
    .prepare(
      'SELECT status, order_state, broker_order_ids, resolved_at FROM flatten_submissions WHERE idempotency_key = ?',
    )
    .get(idempotency_key) as
    | {
        status: string;
        order_state: string | null;
        broker_order_ids: string | null;
        resolved_at: string | null;
      }
    | undefined;
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
    modelled_cost_charged: true,
    ...overrides,
  };
}

function makeStore(): { db: StoreHandle; store: SqliteExecutionStore } {
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

  describe('#1001: submit-time quote and decision price columns', () => {
    it('round-trips a full open_positions snapshot — decision_price, quote bid/ask/mid/observed_at, modelled_cost_breakdown', async () => {
      const { store } = makeStore();
      const quoteObservedAt = new Date('2026-07-20T13:59:30Z');
      await store.writeAheadPosition(
        makePosition({
          decision_price: 100.25,
          quote_bid: 100.1,
          quote_ask: 100.4,
          quote_mid: 100.25,
          quote_observed_at: quoteObservedAt,
          modelled_cost_breakdown: {
            spread_cost: 0.1,
            commission: 0.2,
            slippage: 0.05,
            market_impact: 0.01,
          },
          modelled_protective_exit_cost_breakdown: {
            spread_cost: 0.3,
            commission: 0.4,
            slippage: 0.15,
            market_impact: 0.02,
          },
        }),
      );

      const [position] = await store.getOpenPositions();
      expect(position?.decision_price).toBe(100.25);
      expect(position?.quote_bid).toBe(100.1);
      expect(position?.quote_ask).toBe(100.4);
      expect(position?.quote_mid).toBe(100.25);
      expect(position?.quote_observed_at).toEqual(quoteObservedAt);
      expect(position?.modelled_cost_breakdown).toEqual({
        spread_cost: 0.1,
        commission: 0.2,
        slippage: 0.05,
        market_impact: 0.01,
      });
      expect(position?.modelled_protective_exit_cost_breakdown).toEqual({
        spread_cost: 0.3,
        commission: 0.4,
        slippage: 0.15,
        market_impact: 0.02,
      });
    });

    it('reads back a legacy/best-effort-failed open_positions row (every new field absent) with no error', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      const [position] = await store.getOpenPositions();
      expect(position?.modelled_protective_exit_cost_breakdown).toBeUndefined();
      expect(position?.decision_price).toBeUndefined();
      expect(position?.quote_bid).toBeUndefined();
      expect(position?.quote_ask).toBeUndefined();
      expect(position?.quote_mid).toBeUndefined();
      expect(position?.quote_observed_at).toBeUndefined();
      expect(position?.modelled_cost_breakdown).toBeUndefined();
    });

    it('round-trips a full flatten_submissions snapshot — decision_price, quote bid/ask/mid/observed_at, modelled_cost_breakdown', async () => {
      const { db, store } = makeStore();
      const quoteObservedAt = new Date('2026-07-20T13:59:30Z');
      await store.writeAheadFlatten(
        makeFlattenWriteAhead({
          decision_price: 99.9,
          quote_bid: 99.8,
          quote_ask: 100.0,
          quote_mid: 99.9,
          quote_observed_at: quoteObservedAt,
          modelled_cost_breakdown: {
            spread_cost: 0.2,
            commission: 0.3,
            slippage: 0.1,
            market_impact: 0.02,
          },
        }),
      );

      const row = db
        .prepare(
          `SELECT decision_price, quote_bid, quote_ask, quote_mid, quote_observed_at
             FROM flatten_submissions WHERE idempotency_key = ?`,
        )
        .get('flatten-1') as {
        decision_price: number | null;
        quote_bid: number | null;
        quote_ask: number | null;
        quote_mid: number | null;
        quote_observed_at: string | null;
      };
      expect(row.decision_price).toBe(99.9);
      expect(row.quote_bid).toBe(99.8);
      expect(row.quote_ask).toBe(100.0);
      expect(row.quote_mid).toBe(99.9);
      expect(row.quote_observed_at).toBe(quoteObservedAt.toISOString());

      const attribution = await store.getFlattenAttribution('flatten-1');
      expect(attribution?.modelled_cost_breakdown).toEqual({
        spread_cost: 0.2,
        commission: 0.3,
        slippage: 0.1,
        market_impact: 0.02,
      });
    });

    it('reads back a flatten_submissions row written with every new field null, with no error', async () => {
      const { store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead());

      const attribution = await store.getFlattenAttribution('flatten-1');
      expect(attribution?.modelled_cost_breakdown).toBeNull();
    });

    describe('corrupted modelled_cost_breakdown_json degrades to null instead of throwing', () => {
      const CORRUPT_VALUES: ReadonlyArray<readonly [string, string]> = [
        ['not valid JSON at all', '{not json'],
        ['truncated JSON', '{"spread_cost":0.1,"commi'],
        ['a JSON array, not an object', '[0.1, 0.2, 0.05, 0.01]'],
        ['a JSON scalar', '42'],
        ['JSON null', 'null'],
        ['an object missing a component', '{"spread_cost":0.1,"commission":0.2,"slippage":0.05}'],
        [
          'an object whose component is a string',
          '{"spread_cost":"0.1","commission":0.2,"slippage":0.05,"market_impact":0.01}',
        ],
        [
          'an object whose component is null',
          '{"spread_cost":null,"commission":0.2,"slippage":0.05,"market_impact":0.01}',
        ],
      ];

      for (const [label, raw] of CORRUPT_VALUES) {
        it(`getFlattenAttribution returns null modelled_cost_breakdown for ${label}`, async () => {
          const { db, store } = makeStore();
          await store.writeAheadFlatten(
            makeFlattenWriteAhead({
              modelled_cost_breakdown: {
                spread_cost: 0.2,
                commission: 0.3,
                slippage: 0.1,
                market_impact: 0.02,
              },
            }),
          );
          overwriteJournalColumn(db, 'modelled_cost_breakdown_json', 'flatten-1', raw);

          const attribution = await store.getFlattenAttribution('flatten-1');
          expect(attribution?.lot_idempotency_keys).toEqual(['key-lot-1', 'key-lot-2']);
          expect(attribution?.modelled_cost_breakdown).toBeNull();
        });

        it(`fromOpenPositionRow leaves modelled_cost_breakdown absent for ${label}`, async () => {
          const { db, store } = makeStore();
          await store.writeAheadPosition(
            makePosition({
              modelled_cost_breakdown: {
                spread_cost: 0.1,
                commission: 0.2,
                slippage: 0.05,
                market_impact: 0.01,
              },
            }),
          );
          overwritePositionCostBreakdown(db, 'key-1', raw);

          const [position] = await store.getOpenPositions();
          expect(position?.idempotency_key).toBe('key-1');
          expect(position?.modelled_cost_breakdown).toBeUndefined();
        });
      }

      it('rejects a non-finite component even though it parses as a number', async () => {
        const { db, store } = makeStore();
        await store.writeAheadFlatten(makeFlattenWriteAhead());
        overwriteJournalColumn(
          db,
          'modelled_cost_breakdown_json',
          'flatten-1',
          '{"spread_cost":1e999,"commission":0.2,"slippage":0.05,"market_impact":0.01}',
        );

        expect(
          (await store.getFlattenAttribution('flatten-1'))?.modelled_cost_breakdown,
        ).toBeNull();
      });

      it('still accepts a well-formed breakdown — the guard rejects corruption, not the happy path', async () => {
        const { store } = makeStore();
        await store.writeAheadFlatten(
          makeFlattenWriteAhead({
            modelled_cost_breakdown: {
              spread_cost: 0.2,
              commission: 0.3,
              slippage: 0.1,
              market_impact: 0.02,
            },
          }),
        );

        expect((await store.getFlattenAttribution('flatten-1'))?.modelled_cost_breakdown).toEqual({
          spread_cost: 0.2,
          commission: 0.3,
          slippage: 0.1,
          market_impact: 0.02,
        });
      });
    });
  });

  describe('applyLotAdvance', () => {
    it('persists fills with hasFill/getFills dedup and round-trip against real rows', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());

      expect(
        await store.hasFill({ idempotency_key: 'key-1', broker_fill_id: toBrokerFillId('fill-1') }),
      ).toBe(false);
      await store.applyLotAdvance({ idempotency_key: 'key-1', fills: [makeFill()] });
      expect(
        await store.hasFill({ idempotency_key: 'key-1', broker_fill_id: toBrokerFillId('fill-1') }),
      ).toBe(true);

      const fills = await store.getFills('key-1');
      expect(fills).toHaveLength(1);
      expect(fills[0]).toMatchObject({ broker_fill_id: toBrokerFillId('fill-1'), qty: 5 });
    });

    it('matches the full (idempotency_key, broker_fill_id) primary key, not the id alone (#1320)', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-1' }));
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-2' }));

      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [
          makeFill({ idempotency_key: 'key-1', broker_fill_id: toBrokerFillId('shared-id') }),
        ],
      });

      expect(
        await store.hasFill({
          idempotency_key: 'key-2',
          broker_fill_id: toBrokerFillId('shared-id'),
        }),
      ).toBe(false);
      expect(
        await store.hasFill({
          idempotency_key: 'key-1',
          broker_fill_id: toBrokerFillId('shared-id'),
        }),
      ).toBe(true);

      await store.applyLotAdvance({
        idempotency_key: 'key-2',
        fills: [
          makeFill({ idempotency_key: 'key-2', broker_fill_id: toBrokerFillId('shared-id') }),
        ],
      });
      expect(
        await store.hasFill({
          idempotency_key: 'key-2',
          broker_fill_id: toBrokerFillId('shared-id'),
        }),
      ).toBe(true);
    });

    it('preserves cost_breakdown for Simulated-adapter fills and omits it otherwise', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [
          makeFill({
            broker_fill_id: toBrokerFillId('fill-sim'),
            cost_breakdown: {
              spread_cost: 0.1,
              commission: 0.2,
              slippage: 0.05,
              market_impact: 0.01,
            },
          }),
          makeFill({ broker_fill_id: toBrokerFillId('fill-real') }),
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

    it('round-trips fee_currency verbatim, and omits it for an adapter that reports none', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [
          makeFill({ broker_fill_id: toBrokerFillId('fill-gbp'), fee_currency: 'GBP' }),
          makeFill({ broker_fill_id: toBrokerFillId('fill-usd'), fee_currency: 'USD' }),
          makeFill({ broker_fill_id: toBrokerFillId('fill-none') }),
        ],
      });

      const [gbp, usd, none] = await store.getFills('key-1');
      expect(gbp?.fee_currency).toBe('GBP');
      expect(usd?.fee_currency).toBe('USD');
      expect(none?.fee_currency).toBeUndefined();
    });

    it('returns fills in ingestion order', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition());
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [
          makeFill({ broker_fill_id: toBrokerFillId('fill-a') }),
          makeFill({ broker_fill_id: toBrokerFillId('fill-b') }),
        ],
      });
      await store.applyLotAdvance({
        idempotency_key: 'key-1',
        fills: [makeFill({ broker_fill_id: toBrokerFillId('fill-c') })],
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

      await expect(
        store.applyLotAdvance({
          idempotency_key: 'key-1',
          fills: [makeFill({ broker_fill_id: toBrokerFillId('fill-after-close') })],
          position_update: { filled_size: 5, avg_entry_price: 100, order_state: 'closed' },
          closed_trade: makeClosedTrade(),
        }),
      ).rejects.toThrow();

      expect(
        await store.hasFill({
          idempotency_key: 'key-1',
          broker_fill_id: toBrokerFillId('fill-after-close'),
        }),
      ).toBe(false);
      const [position] = await store.getOpenPositions();
      expect(position?.filled_size).toBe(0);
    });
  });

  describe('writeAheadFlatten / getFlattenAttribution (#517, #571)', () => {
    it('round-trips the lot identity through the journal, in the order it was written', async () => {
      const { store } = makeStore();

      await store.writeAheadFlatten(makeFlattenWriteAhead());

      expect((await store.getFlattenAttribution('flatten-1'))?.lot_idempotency_keys).toEqual([
        'key-lot-1',
        'key-lot-2',
      ]);
    });

    it('round-trips each lot’s held quantity, paired with its own key', async () => {
      const { store } = makeStore();

      await store.writeAheadFlatten(makeFlattenWriteAhead());

      expect((await store.getFlattenAttribution('flatten-1'))?.lot_held_quantities).toEqual([
        { idempotency_key: 'key-lot-1', held: 10 },
        { idempotency_key: 'key-lot-2', held: 15 },
      ]);
    });

    it('journals a zero held quantity rather than dropping the lot that holds nothing', async () => {
      const { store } = makeStore();

      await store.writeAheadFlatten(
        makeFlattenWriteAhead({
          size: 10,
          lot_held_quantities: [
            { idempotency_key: 'key-lot-1', held: 10 },
            { idempotency_key: 'key-lot-2', held: 0 },
          ],
        }),
      );

      const attribution = await store.getFlattenAttribution('flatten-1');
      expect(attribution?.lot_idempotency_keys).toEqual(['key-lot-1', 'key-lot-2']);
      expect(attribution?.lot_held_quantities).toEqual([
        { idempotency_key: 'key-lot-1', held: 10 },
        { idempotency_key: 'key-lot-2', held: 0 },
      ]);
    });

    it('returns null for a key that names no flatten submission', async () => {
      const { store } = makeStore();

      expect(await store.getFlattenAttribution('never-submitted')).toBeNull();
    });

    it('returns null, not a parse error, for a pre-migration row with no lot identity recorded', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-legacy' }));
      overwriteJournalColumn(db, 'lot_idempotency_keys', 'flatten-legacy', null);

      expect(await store.getFlattenAttribution('flatten-legacy')).toBeNull();
    });

    it('returns the lot keys with a null held-quantity list for a pre-0021 row', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-pre-0021' }));
      overwriteJournalColumn(db, 'lot_held_quantities', 'flatten-pre-0021', null);

      expect(await store.getFlattenAttribution('flatten-pre-0021')).toEqual({
        lot_idempotency_keys: ['key-lot-1', 'key-lot-2'],
        lot_held_quantities: null,
        exit_reason: 'flatten',
        instrument: 'AAPL',
        side: 'sell',
        modelled_cost_breakdown: null,
        size: 25,
      });
    });
  });

  describe('getFlattenAttribution — corrupted rows (#524 review, #571)', () => {
    it('throws, naming the idempotency_key, when the stored value is not valid JSON', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-corrupt' }));
      overwriteJournalColumn(db, 'lot_idempotency_keys', 'flatten-corrupt', '{not json');

      await expect(store.getFlattenAttribution('flatten-corrupt')).rejects.toThrow(
        /flatten-corrupt' is not valid JSON/,
      );
    });

    it('throws, naming the idempotency_key, when the stored JSON is not an array of strings', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(
        makeFlattenWriteAhead({ idempotency_key: 'flatten-wrong-shape' }),
      );
      overwriteJournalColumn(
        db,
        'lot_idempotency_keys',
        'flatten-wrong-shape',
        JSON.stringify({ not: 'an array' }),
      );

      await expect(store.getFlattenAttribution('flatten-wrong-shape')).rejects.toThrow(
        /flatten-wrong-shape' is not a JSON array of strings/,
      );
    });

    it('throws for an array containing a non-string entry', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-mixed' }));
      overwriteJournalColumn(
        db,
        'lot_idempotency_keys',
        'flatten-mixed',
        JSON.stringify(['key-1', 42]),
      );

      await expect(store.getFlattenAttribution('flatten-mixed')).rejects.toThrow('flatten-mixed');
    });

    it('never quotes the corrupted raw value in the thrown error', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-secret' }));
      const poison = '{"leaked-marker-xyz": true';
      overwriteJournalColumn(db, 'lot_idempotency_keys', 'flatten-secret', poison);

      await expect(store.getFlattenAttribution('flatten-secret')).rejects.not.toThrow(
        /leaked-marker-xyz/,
      );
    });

    it('throws, naming the idempotency_key, when the held quantities are not valid JSON', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-held-bad' }));
      overwriteJournalColumn(db, 'lot_held_quantities', 'flatten-held-bad', '{not json');

      await expect(store.getFlattenAttribution('flatten-held-bad')).rejects.toThrow(
        /lot_held_quantities for 'flatten-held-bad' is not valid JSON/,
      );
    });

    it('throws when a held quantity is not a finite non-negative number', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-held-nan' }));
      overwriteJournalColumn(
        db,
        'lot_held_quantities',
        'flatten-held-nan',
        JSON.stringify([10, 'fifteen']),
      );

      await expect(store.getFlattenAttribution('flatten-held-nan')).rejects.toThrow(
        'flatten-held-nan',
      );
    });

    it('throws on a negative held quantity rather than treating it as no share', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-held-neg' }));
      overwriteJournalColumn(
        db,
        'lot_held_quantities',
        'flatten-held-neg',
        JSON.stringify([10, -15]),
      );

      await expect(store.getFlattenAttribution('flatten-held-neg')).rejects.toThrow(
        'flatten-held-neg',
      );
    });

    it.each([
      ['shorter than', [10]],
      ['longer than', [10, 15, 20]],
    ])('throws when the held quantities are %s the lot keys', async (_label, quantities) => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-held-len' }));
      overwriteJournalColumn(
        db,
        'lot_held_quantities',
        'flatten-held-len',
        JSON.stringify(quantities),
      );

      await expect(store.getFlattenAttribution('flatten-held-len')).rejects.toThrow(
        'flatten-held-len',
      );
    });

    it('never quotes the corrupted raw held quantities in the thrown error', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(
        makeFlattenWriteAhead({ idempotency_key: 'flatten-held-leak' }),
      );
      const poison = '{"leaked-marker-abc": true';
      overwriteJournalColumn(db, 'lot_held_quantities', 'flatten-held-leak', poison);

      await expect(store.getFlattenAttribution('flatten-held-leak')).rejects.not.toThrow(
        /leaked-marker-abc/,
      );
    });
  });

  describe('getUnresolvedFlattens / recordFlattenOrderStateObserved / markFlattenFillsSwept (#519, #526)', () => {
    it('finds a row still at "submitting"', async () => {
      const { store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-stuck' }));

      const unresolved = await store.getUnresolvedFlattens();

      expect(unresolved).toEqual([
        {
          idempotency_key: 'flatten-stuck',
          instrument: 'AAPL',
          status: 'submitting',
          submitted_at: OPENED_AT,
          order_state: null,
          cancel_attempted_at: null,
          terminal_unswept_checked_at: null,
        },
      ]);
    });

    it('finds an acked row whose fills have not been swept yet', async () => {
      const { store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-acked' }));
      await store.resolveFlattenSubmitted(
        'flatten-acked',
        { order_state: 'submitted', broker_order_ids: ['order-1'] },
        OPENED_AT,
      );

      const unresolved = await store.getUnresolvedFlattens();

      expect(unresolved).toEqual([
        {
          idempotency_key: 'flatten-acked',
          instrument: 'AAPL',
          status: 'submitted',
          submitted_at: OPENED_AT,
          order_state: 'submitted',
          cancel_attempted_at: null,
          terminal_unswept_checked_at: null,
        },
      ]);
    });

    it('carries the last venue-cancel attempt onto the rows the scan returns, without releasing the row', async () => {
      const { store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-wedged' }));
      const attemptedAt = new Date(OPENED_AT.getTime() + 60_000);

      await store.markFlattenCancelAttempted('flatten-wedged', attemptedAt);

      expect(await store.getUnresolvedFlattens()).toEqual([
        {
          idempotency_key: 'flatten-wedged',
          instrument: 'AAPL',
          status: 'submitting',
          submitted_at: OPENED_AT,
          order_state: null,
          cancel_attempted_at: attemptedAt,
          terminal_unswept_checked_at: null,
        },
      ]);
    });

    it('refuses a cancel-attempt mark for a flatten that does not exist', async () => {
      const { store } = makeStore();

      await expect(store.markFlattenCancelAttempted('no-such-flatten', OPENED_AT)).rejects.toThrow(
        /no flatten_submissions row/,
      );
    });

    it('excludes a row once markFlattenFillsSwept has run — the bound migration 0023 exists for', async () => {
      const { store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-swept' }));
      await store.resolveFlattenSubmitted(
        'flatten-swept',
        { order_state: 'submitted', broker_order_ids: ['order-1'] },
        OPENED_AT,
      );
      await store.markFlattenFillsSwept('flatten-swept', OPENED_AT);

      expect(await store.getUnresolvedFlattens()).toEqual([]);
    });

    it('excludes a row resolved to "error" — terminal, so it blocks nothing', async () => {
      const { store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-error' }));
      await store.resolveFlattenError('flatten-error', 'cancel failed', OPENED_AT);

      expect(await store.getUnresolvedFlattens()).toEqual([]);
    });

    it('recordFlattenOrderStateObserved updates order_state/broker_order_ids without touching resolved_at or status', async () => {
      const { db, store } = makeStore();
      await store.writeAheadFlatten(makeFlattenWriteAhead({ idempotency_key: 'flatten-refresh' }));
      await store.resolveFlattenSubmitted(
        'flatten-refresh',
        { order_state: 'submitted', broker_order_ids: ['order-1'] },
        OPENED_AT,
      );
      const beforeRow = readFlattenRow(db, 'flatten-refresh');

      await store.recordFlattenOrderStateObserved('flatten-refresh', {
        order_state: 'filled',
        broker_order_ids: ['order-1', 'order-1-fill'],
      });

      const afterRow = readFlattenRow(db, 'flatten-refresh');
      expect(afterRow?.order_state).toBe('filled');
      expect(afterRow?.broker_order_ids).toBe(JSON.stringify(['order-1', 'order-1-fill']));
      expect(afterRow?.status).toBe(beforeRow?.status);
      expect(afterRow?.resolved_at).toBe(beforeRow?.resolved_at);
    });

    it('markFlattenFillsSwept throws naming the key when no such row exists', async () => {
      const { store } = makeStore();

      await expect(store.markFlattenFillsSwept('never-submitted', OPENED_AT)).rejects.toThrow(
        'never-submitted',
      );
    });

    it('recordFlattenOrderStateObserved throws naming the key when no such row exists', async () => {
      const { store } = makeStore();

      await expect(
        store.recordFlattenOrderStateObserved('never-submitted', {
          order_state: 'filled',
          broker_order_ids: [],
        }),
      ).rejects.toThrow('never-submitted');
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
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('e1'),
            leg: 'entry',
            qty: 4,
          }),
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('e2'),
            leg: 'entry',
            qty: 6,
          }),
        ],
      });
      await store.applyLotAdvance({
        idempotency_key: 'key-lot-2',
        fills: [
          makeFill({
            idempotency_key: 'key-lot-2',
            broker_fill_id: toBrokerFillId('e3'),
            leg: 'entry',
            qty: 15,
          }),
        ],
      });

      const sizes = await store.getEntryFillSizes([
        'key-lot-1',
        'key-lot-2',
        'key-lot-never-filled',
      ]);

      expect(sizes.get('key-lot-1')).toBe(10);
      expect(sizes.get('key-lot-2')).toBe(15);
      expect(sizes.has('key-lot-never-filled')).toBe(false);
    });

    it('excludes exit-leg fills from the sum', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-lot-1' }));
      await store.applyLotAdvance({
        idempotency_key: 'key-lot-1',
        fills: [
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('e1'),
            leg: 'entry',
            qty: 10,
          }),
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('x1'),
            leg: 'exit',
            qty: 4,
          }),
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

  describe('getExitFillSizes (#568 — the closing-leg mirror, what held quantity subtracts)', () => {
    it('sums every CLOSING leg per lot and excludes the entry, omitting a lot with none', async () => {
      const { store } = makeStore();
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-lot-1' }));
      await store.writeAheadPosition(makePosition({ idempotency_key: 'key-lot-2' }));
      await store.applyLotAdvance({
        idempotency_key: 'key-lot-1',
        fills: [
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('e1'),
            leg: 'entry',
            qty: 10,
          }),
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('x1'),
            leg: 'exit',
            qty: 4,
          }),
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('x2'),
            leg: 'stop',
            qty: 1,
          }),
          makeFill({
            idempotency_key: 'key-lot-1',
            broker_fill_id: toBrokerFillId('x3'),
            leg: 'target',
            qty: 2,
          }),
        ],
      });
      await store.applyLotAdvance({
        idempotency_key: 'key-lot-2',
        fills: [
          makeFill({
            idempotency_key: 'key-lot-2',
            broker_fill_id: toBrokerFillId('e2'),
            leg: 'entry',
            qty: 15,
          }),
        ],
      });

      const sizes = await store.getExitFillSizes(['key-lot-1', 'key-lot-2', 'key-lot-unknown']);

      expect(sizes.get('key-lot-1')).toBe(7);
      expect(sizes.has('key-lot-2')).toBe(false);
      expect(sizes.has('key-lot-unknown')).toBe(false);
    });

    it('returns an empty Map for an empty key list', async () => {
      const { store } = makeStore();

      expect(await store.getExitFillSizes([])).toEqual(new Map());
    });
  });

  describe('arm scoping (#753)', () => {
    function makeArmedStores(): {
      db: StoreHandle;
      live: SqliteExecutionStore;
      control: SqliteExecutionStore;
    } {
      const db = openSharedStore(':memory:');
      return {
        db,
        live: new SqliteExecutionStore(db),
        control: new SqliteExecutionStore(db, 'control'),
      };
    }

    function armsOf(db: StoreHandle, table: 'open_positions' | 'closed_trades'): string[] {
      return (
        db.prepare(`SELECT idempotency_key, arm FROM ${table} ORDER BY idempotency_key`).all() as {
          idempotency_key: string;
          arm: string;
        }[]
      ).map((row) => `${row.idempotency_key}=${row.arm}`);
    }

    it('stamps the closed-trade record with the writing instance’s arm', async () => {
      const { db, live, control } = makeArmedStores();

      await live.writeAheadPosition(makePosition({ idempotency_key: 'live-key' }));
      await control.writeAheadPosition(makePosition({ idempotency_key: 'control-key' }));
      await live.applyLotAdvance({
        idempotency_key: 'live-key',
        fills: [],
        closed_trade: makeClosedTrade({ idempotency_key: 'live-key' }),
      });
      await control.applyLotAdvance({
        idempotency_key: 'control-key',
        fills: [],
        closed_trade: makeClosedTrade({ idempotency_key: 'control-key' }),
      });

      expect(armsOf(db, 'closed_trades')).toEqual(['control-key=control', 'live-key=live']);
      expect(armsOf(db, 'open_positions')).toEqual(['control-key=control', 'live-key=live']);

      const controlKeys = db
        .prepare(`SELECT idempotency_key FROM closed_trades WHERE arm = 'control'`)
        .all() as { idempotency_key: string }[];
      expect(controlKeys.map((row) => row.idempotency_key)).toEqual(['control-key']);
    });

    it('keeps each arm’s open book invisible to the other', async () => {
      const { live, control } = makeArmedStores();

      await live.writeAheadPosition(makePosition({ idempotency_key: 'live-key' }));
      await control.writeAheadPosition(makePosition({ idempotency_key: 'control-key' }));

      expect((await live.getOpenPositions()).map((p) => p.idempotency_key)).toEqual(['live-key']);
      expect((await control.getOpenPositions()).map((p) => p.idempotency_key)).toEqual([
        'control-key',
      ]);
    });

    it('keeps each arm’s unresolved flattens invisible to the other reconcile pass', async () => {
      const { live, control } = makeArmedStores();

      for (const [store, prefix] of [
        [live, 'live'],
        [control, 'control'],
      ] as const) {
        await store.writeAheadFlatten(
          makeFlattenWriteAhead({ idempotency_key: `${prefix}-submitting`, instrument: 'AAPL' }),
        );
        await store.writeAheadFlatten(
          makeFlattenWriteAhead({
            idempotency_key: `${prefix}-submitted-unswept`,
            instrument: 'TSLA',
          }),
        );
        await store.resolveFlattenSubmitted(
          `${prefix}-submitted-unswept`,
          { order_state: 'submitted', broker_order_ids: [`${prefix}-order-1`] },
          OPENED_AT,
        );
      }

      expect((await live.getUnresolvedFlattens()).map((r) => r.idempotency_key).sort()).toEqual([
        'live-submitted-unswept',
        'live-submitting',
      ]);
      expect((await control.getUnresolvedFlattens()).map((r) => r.idempotency_key).sort()).toEqual([
        'control-submitted-unswept',
        'control-submitting',
      ]);
    });

    it('defaults to the live arm, so every pre-#753 row and caller is unchanged', async () => {
      const { db, store } = makeStore();
      await store.writeAheadPosition(makePosition());

      expect(armsOf(db, 'open_positions')).toEqual(['key-1=live']);
    });
  });

  describe('sizing capital ceiling stamp (#1112)', () => {
    function ceilingsOf(
      db: StoreHandle,
      table: 'open_positions' | 'closed_trades',
    ): (number | null)[] {
      return (
        db
          .prepare(`SELECT sizing_capital_ceiling FROM ${table} ORDER BY idempotency_key`)
          .all() as { sizing_capital_ceiling: number | null }[]
      ).map((row) => row.sizing_capital_ceiling);
    }

    it('stamps both tables with the ceiling the constructor was given', async () => {
      const db = openSharedStore(':memory:');
      const store = new SqliteExecutionStore(db, 'live', 1_000);

      await store.writeAheadPosition(makePosition({ idempotency_key: 'ceiling-key' }));
      await store.applyLotAdvance({
        idempotency_key: 'ceiling-key',
        fills: [],
        closed_trade: makeClosedTrade({ idempotency_key: 'ceiling-key' }),
      });

      expect(ceilingsOf(db, 'open_positions')).toEqual([1_000]);
      expect(ceilingsOf(db, 'closed_trades')).toEqual([1_000]);
    });

    it('stamps NULL when no ceiling is given — the true pre-#1112 and backtest state, not a placeholder', async () => {
      const { db, store } = makeStore();
      await store.writeAheadPosition(makePosition());

      expect(ceilingsOf(db, 'open_positions')).toEqual([null]);
    });

    it('a window mixing a declared ceiling with none is a real, queryable property', async () => {
      const db = openSharedStore(':memory:');
      const unclamped = new SqliteExecutionStore(db);
      const clamped = new SqliteExecutionStore(db, 'live', 1_000);

      await unclamped.writeAheadPosition(makePosition({ idempotency_key: 'pre-fix' }));
      await unclamped.applyLotAdvance({
        idempotency_key: 'pre-fix',
        fills: [],
        closed_trade: makeClosedTrade({ idempotency_key: 'pre-fix' }),
      });
      await clamped.writeAheadPosition(makePosition({ idempotency_key: 'post-fix' }));
      await clamped.applyLotAdvance({
        idempotency_key: 'post-fix',
        fills: [],
        closed_trade: makeClosedTrade({ idempotency_key: 'post-fix' }),
      });

      const distinctCeilings = db
        .prepare(
          'SELECT DISTINCT sizing_capital_ceiling FROM closed_trades ORDER BY sizing_capital_ceiling',
        )
        .all() as { sizing_capital_ceiling: number | null }[];
      expect(distinctCeilings).toHaveLength(2);
    });
  });

  describe('modelled cost charged stamp (#1121, migration 0049)', () => {
    function chargedFlagOf(db: StoreHandle, idempotency_key: string): number {
      return (
        db
          .prepare('SELECT modelled_cost_charged FROM closed_trades WHERE idempotency_key = ?')
          .get(idempotency_key) as { modelled_cost_charged: number }
      ).modelled_cost_charged;
    }

    it('stamps a live-arm closed trade as 1 when the trade says it was charged', async () => {
      const { db, store } = makeStore();
      await store.writeAheadPosition(makePosition({ idempotency_key: 'live-key' }));
      await store.applyLotAdvance({
        idempotency_key: 'live-key',
        fills: [],
        closed_trade: makeClosedTrade({ idempotency_key: 'live-key' }),
      });

      expect(chargedFlagOf(db, 'live-key')).toBe(1);
    });

    it('stamps a control-arm closed trade as 1 too — the control was never the defect', async () => {
      const db = openSharedStore(':memory:');
      const store = new SqliteExecutionStore(db, 'control');
      await store.writeAheadPosition(makePosition({ idempotency_key: 'control-key' }));
      await store.applyLotAdvance({
        idempotency_key: 'control-key',
        fills: [],
        closed_trade: makeClosedTrade({ idempotency_key: 'control-key' }),
      });

      expect(chargedFlagOf(db, 'control-key')).toBe(1);
    });

    it('stamps 0 when the closed trade reports it was NOT charged', async () => {
      const { db, store } = makeStore();
      await store.writeAheadPosition(makePosition({ idempotency_key: 'uncharged' }));
      await store.applyLotAdvance({
        idempotency_key: 'uncharged',
        fills: [],
        closed_trade: makeClosedTrade({
          idempotency_key: 'uncharged',
          modelled_cost_charged: false,
        }),
      });

      expect(chargedFlagOf(db, 'uncharged')).toBe(0);
    });
  });
});
