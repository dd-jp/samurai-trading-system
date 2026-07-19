import { describe, expect, it } from 'vitest';
import type { ClosedTrade } from '../shared/types.js';
import { FixtureSetupStore } from '../trader/fixture-setup-store.js';
import { onTradeClose } from './on-trade-close.js';
import type { OnTradeCloseInput } from './types.js';

const VECTOR = { debate_features: [0.7, 1, 1, 0.1], market_features: [0.3, 0.5] };

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
    // initial risk = |100 - 90| * 10 = 100, so realized_pnl_net 200 => R = 2.
    realized_pnl_net: 200,
    fees_total: 1,
    opened_at: new Date('2026-07-01T10:00:00Z'),
    closed_at: new Date('2026-07-02T10:00:00Z'),
    close_reason: 'target',
    ...overrides,
  };
}

describe('onTradeClose', () => {
  it('labels the setup store with the correctly computed R, joined by debate_id', () => {
    const store = new FixtureSetupStore();
    store.writeSetup('debate-1', VECTOR, new Date('2026-07-01T09:00:00Z'));
    const trade = makeTrade();
    const input: OnTradeCloseInput = { setup_store: store };

    onTradeClose(trade, 'trace-1', input);

    const neighbors = store.findNeighbors(VECTOR, trade.closed_at);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]?.r_multiple).toBe(2);
    expect(neighbors[0]?.closed_at).toEqual(trade.closed_at);
  });

  it('does not appear as a precedent before its close_at (point-in-time)', () => {
    const store = new FixtureSetupStore();
    store.writeSetup('debate-1', VECTOR, new Date('2026-07-01T09:00:00Z'));
    const trade = makeTrade();
    onTradeClose(trade, 'trace-1', { setup_store: store });

    const before = store.findNeighbors(VECTOR, new Date('2026-07-01T10:00:00Z'));
    expect(before).toHaveLength(0);
  });

  it('skips labelling when initial risk is zero (undefined R)', () => {
    const store = new FixtureSetupStore();
    store.writeSetup('debate-1', VECTOR, new Date('2026-07-01T09:00:00Z'));
    const trade = makeTrade({ entry: 100, stop: 100 });

    onTradeClose(trade, 'trace-1', { setup_store: store });

    expect(store.findNeighbors(VECTOR, trade.closed_at)).toHaveLength(0);
  });

  it('a scale-in position: each per-lot ClosedTrade labels its own setup entry', () => {
    const store = new FixtureSetupStore();
    store.writeSetup('debate-1', VECTOR, new Date('2026-07-01T09:00:00Z'));
    store.writeSetup('debate-2', VECTOR, new Date('2026-07-01T09:05:00Z'));

    const firstLot = makeTrade({
      idempotency_key: 'key-1',
      debate_id: 'debate-1',
      entry: 100,
      stop: 90,
      filled_size: 10,
      realized_pnl_net: 200, // R = 2
      closed_at: new Date('2026-07-02T10:00:00Z'),
    });
    const secondLot = makeTrade({
      idempotency_key: 'key-2',
      debate_id: 'debate-2',
      entry: 105,
      stop: 95,
      filled_size: 5,
      realized_pnl_net: -25, // initial risk = 50, R = -0.5
      closed_at: new Date('2026-07-02T11:00:00Z'),
    });

    onTradeClose(firstLot, 'trace-1', { setup_store: store });
    onTradeClose(secondLot, 'trace-2', { setup_store: store });

    const asOf = new Date('2026-07-02T12:00:00Z');
    const neighbors = store.findNeighbors(VECTOR, asOf);
    expect(neighbors).toHaveLength(2);
    expect(neighbors.map((n) => n.r_multiple).sort()).toEqual([-0.5, 2]);
  });

  it('throws (via the store) rather than double-labelling the same debate_id', () => {
    const store = new FixtureSetupStore();
    store.writeSetup('debate-1', VECTOR, new Date('2026-07-01T09:00:00Z'));
    const trade = makeTrade();

    onTradeClose(trade, 'trace-1', { setup_store: store });

    expect(() => onTradeClose(trade, 'trace-1', { setup_store: store })).toThrow();
  });
});
