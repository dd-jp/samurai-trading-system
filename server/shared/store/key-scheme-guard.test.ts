import { describe, expect, it } from 'vitest';
import {
  assertNoStaleKeyScheme,
  findStaleKeySchemeLots,
  openSharedStore,
  type StoreHandle,
  TERMINAL_ORDER_STATES,
} from './index.js';

/**
 * Rows only need the columns the guard reads plus the NOT NULLs; every other
 * value is filler. `key_scheme` is passed explicitly rather than left to the
 * migration's default so each test states which side of the cutover it means.
 */
function insertLot(
  db: StoreHandle,
  lot: {
    key: string;
    instrument?: string;
    order_state: string;
    key_scheme: number;
    opened_at?: string;
  },
): void {
  db.prepare(
    `INSERT INTO open_positions (
       idempotency_key, debate_id, instrument, asset_class, side, intent_type,
       requested_size, filled_size, avg_entry_price, stop, target, order_state,
       broker_order_ids, opened_at, decision_timestamp, key_scheme
     ) VALUES (?, 'debate-1', ?, 'stocks', 'buy', 'entry',
       1, 1, 100, 95, 110, ?, '[]', ?, '2026-08-14T09:00:00.000Z', ?)`,
  ).run(
    lot.key,
    lot.instrument ?? '3USL',
    lot.order_state,
    lot.opened_at ?? '2026-08-14T09:00:00.000Z',
    lot.key_scheme,
  );
}

describe('key-scheme guard (#686)', () => {
  it('passes on an empty store', () => {
    const db = openSharedStore(':memory:');

    expect(findStaleKeySchemeLots(db)).toEqual([]);
    expect(() => assertNoStaleKeyScheme(db)).not.toThrow();
  });

  it('defaults rows written by this build to the post-#686 scheme', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO open_positions (
         idempotency_key, debate_id, instrument, asset_class, side, intent_type,
         requested_size, filled_size, avg_entry_price, stop, target, order_state,
         broker_order_ids, opened_at, decision_timestamp
       ) VALUES ('k', 'd', '3USL', 'stocks', 'buy', 'entry',
         1, 1, 100, 95, 110, 'filled', '[]', '2026-08-14T09:00:00.000Z',
         '2026-08-14T09:00:00.000Z')`,
    ).run();

    // The migration's DEFAULT is 2, so a row inserted without naming the column
    // is post-cutover. If this ever reads 1, every new lot blocks startup.
    expect(db.prepare('SELECT key_scheme FROM open_positions').get()).toEqual({ key_scheme: 2 });
    expect(() => assertNoStaleKeyScheme(db)).not.toThrow();
  });

  it('blocks a non-terminal lot carrying a pre-#686 key', () => {
    const db = openSharedStore(':memory:');
    insertLot(db, { key: 'stale-1', order_state: 'filled', key_scheme: 1 });

    expect(findStaleKeySchemeLots(db)).toEqual([
      { idempotency_key: 'stale-1', instrument: '3USL', order_state: 'filled' },
    ]);
    expect(() => assertNoStaleKeyScheme(db)).toThrow(/1 in-flight position/);
  });

  it('names the offending lots and how to drain them', () => {
    const db = openSharedStore(':memory:');
    insertLot(db, { key: 'stale-1', instrument: '3LDE', order_state: 'submitted', key_scheme: 1 });

    // The message is the whole remedy — nothing downstream repairs this — so
    // the instrument, the state and the drain instruction all have to be in it.
    expect(() => assertNoStaleKeyScheme(db)).toThrow(/3LDE \(submitted\) stale-1/);
    expect(() => assertNoStaleKeyScheme(db)).toThrow(/flatten the book/);
  });

  it.each(TERMINAL_ORDER_STATES)('ignores a pre-#686 lot in %s', (state) => {
    const db = openSharedStore(':memory:');
    insertLot(db, { key: `stale-${state}`, order_state: state, key_scheme: 1 });

    // A terminal lot is harmless: nothing will replay a decision for it. This
    // is what makes the guard a one-time drain rather than a permanent block.
    expect(findStaleKeySchemeLots(db)).toEqual([]);
    expect(() => assertNoStaleKeyScheme(db)).not.toThrow();
  });

  it('reports oldest-first and truncates past ten', () => {
    const db = openSharedStore(':memory:');
    for (let i = 0; i < 12; i += 1) {
      insertLot(db, {
        key: `stale-${i}`,
        order_state: 'filled',
        key_scheme: 1,
        // Descending inserts, so a store that returned insertion order rather
        // than `opened_at` order would fail the first-key assertion below.
        opened_at: `2026-08-${String(28 - i).padStart(2, '0')}T09:00:00.000Z`,
      });
    }

    const stale = findStaleKeySchemeLots(db);
    expect(stale).toHaveLength(12);
    expect(stale[0]?.idempotency_key).toBe('stale-11');
    expect(() => assertNoStaleKeyScheme(db)).toThrow(/\.\.\.and 2 more/);
  });
});
