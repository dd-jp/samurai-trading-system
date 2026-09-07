import type { ClosedTrade } from '../../shared/index.js';
import { openClosedTradeStore } from './sqlite-store-harness.js';

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
    modelled_cost_charged: true,
    ...overrides,
  };
}

describe('SqliteClosedTradeStore.getClosedTradesBetween', () => {
  it('reads a real row written by another writer (Execution), round-tripped exactly', () => {
    const trade = makeTrade();
    const store = openClosedTradeStore([trade]);

    expect(
      store.getClosedTradesBetween(
        new Date('2026-07-18T00:00:00Z'),
        new Date('2026-07-19T00:00:00Z'),
      ),
    ).toEqual([trade]);
  });

  it('is half-open at the start: excludes a trade closed exactly at `from`', () => {
    const from = new Date('2026-07-18T20:00:00Z');
    const store = openClosedTradeStore([makeTrade({ closed_at: from })]);

    expect(store.getClosedTradesBetween(from, new Date('2026-07-19T00:00:00Z'))).toEqual([]);
  });

  it('is inclusive at the end: includes a trade closed exactly at `to`', () => {
    const to = new Date('2026-07-18T20:00:00Z');
    const trade = makeTrade({ closed_at: to });
    const store = openClosedTradeStore([trade]);

    expect(store.getClosedTradesBetween(new Date('2026-07-18T00:00:00Z'), to)).toEqual([trade]);
  });

  it('excludes a trade closed outside the window entirely', () => {
    const store = openClosedTradeStore([
      makeTrade({ closed_at: new Date('2026-07-01T00:00:00Z') }),
    ]);

    expect(
      store.getClosedTradesBetween(
        new Date('2026-07-18T00:00:00Z'),
        new Date('2026-07-19T00:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('has no write surface — the class exposes only the read-only ClosedTradeStore port', () => {
    const store = openClosedTradeStore();

    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store))).toEqual([
      'constructor',
      'getClosedTradesBetween',
    ]);
  });
});
