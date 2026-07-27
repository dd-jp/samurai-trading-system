import { describe, expect, it } from 'vitest';
import { openSharedStore, type SharedStore } from '../shared/store/open-shared-store.js';
import type { ClosedTrade } from '../shared/types.js';
import { SqliteClosedTradeStore } from './sqlite-closed-trade-store.js';

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'key-1',
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    realized_pnl_net: 200,
    fees_total: 1,
    opened_at: new Date('2026-07-18T10:00:00Z'),
    closed_at: new Date('2026-07-18T20:00:00Z'),
    close_reason: 'target',
    ...overrides,
  };
}

/** closed_trades' sole writer is Execution — this mirrors that INSERT purely for test seeding. */
function insertClosedTrade(db: SharedStore, trade: ClosedTrade): void {
  db.prepare(
    `INSERT INTO closed_trades (
       idempotency_key, debate_id, instrument, asset_class, side,
       entry, stop, filled_size, realized_pnl_net, fees_total,
       opened_at, closed_at, close_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trade.idempotency_key,
    trade.debate_id,
    trade.instrument,
    trade.asset_class,
    trade.side,
    trade.entry,
    trade.stop,
    trade.filled_size,
    trade.realized_pnl_net,
    trade.fees_total,
    trade.opened_at.toISOString(),
    trade.closed_at.toISOString(),
    trade.close_reason,
  );
}

describe('SqliteClosedTradeStore.getClosedTradesBetween', () => {
  it('reads a real row written by another writer (Execution), round-tripped exactly', () => {
    const db = openSharedStore(':memory:');
    const trade = makeTrade();
    insertClosedTrade(db, trade);
    const store = new SqliteClosedTradeStore(db);

    expect(
      store.getClosedTradesBetween(
        new Date('2026-07-18T00:00:00Z'),
        new Date('2026-07-19T00:00:00Z'),
      ),
    ).toEqual([trade]);
  });

  it('is half-open at the start: excludes a trade closed exactly at `from`', () => {
    const db = openSharedStore(':memory:');
    const from = new Date('2026-07-18T20:00:00Z');
    insertClosedTrade(db, makeTrade({ closed_at: from }));
    const store = new SqliteClosedTradeStore(db);

    expect(store.getClosedTradesBetween(from, new Date('2026-07-19T00:00:00Z'))).toEqual([]);
  });

  it('is inclusive at the end: includes a trade closed exactly at `to`', () => {
    const db = openSharedStore(':memory:');
    const to = new Date('2026-07-18T20:00:00Z');
    const trade = makeTrade({ closed_at: to });
    insertClosedTrade(db, trade);
    const store = new SqliteClosedTradeStore(db);

    expect(store.getClosedTradesBetween(new Date('2026-07-18T00:00:00Z'), to)).toEqual([trade]);
  });

  it('excludes a trade closed outside the window entirely', () => {
    const db = openSharedStore(':memory:');
    insertClosedTrade(db, makeTrade({ closed_at: new Date('2026-07-01T00:00:00Z') }));
    const store = new SqliteClosedTradeStore(db);

    expect(
      store.getClosedTradesBetween(
        new Date('2026-07-18T00:00:00Z'),
        new Date('2026-07-19T00:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('has no write surface — the class exposes only the read-only ClosedTradeStore port', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteClosedTradeStore(db);

    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store))).toEqual([
      'constructor',
      'getClosedTradesBetween',
    ]);
  });
});
