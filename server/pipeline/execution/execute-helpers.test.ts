import { describe, expect, it } from 'vitest';
import type { OrderIntent } from '../../shared/index.js';
import {
  bracketFor,
  divergedLotRefusal,
  entryFillRequest,
  exitRefusal,
  openPositionFor,
  protectiveExitFillRequest,
  submitSnapshotOf,
  withoutNulls,
} from './execute.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const BREAKDOWN = { spread_cost: 1, commission: 2, slippage: 3, market_impact: 4 };

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'key-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 10,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T13:55:00Z'),
    decided_at: new Date('2026-07-15T13:55:00Z'),
    metadata: {
      debate_id: 'debate-1',
      conviction: 0.7,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
    },
    ...overrides,
  };
}

function entryIntent(): OrderIntent & { intent_type: 'entry' } {
  return intent() as OrderIntent & { intent_type: 'entry' };
}

function exitIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return intent({ intent_type: 'exit', side: 'sell', ...overrides });
}

const SNAPSHOT = submitSnapshotOf(
  100,
  { bid: 99, ask: 101, observed_at: NOW },
  { entry: BREAKDOWN, protective_exit: null },
);

describe('withoutNulls', () => {
  it('drops null fields and keeps every other value, including zero and false', () => {
    expect(withoutNulls({ a: null, b: 0, c: false, d: 'x' })).toEqual({ b: 0, c: false, d: 'x' });
  });
});

describe('submitSnapshotOf', () => {
  it('derives the mid from a two-sided quote', () => {
    expect(SNAPSHOT).toEqual({
      decision_price: 100,
      quote_bid: 99,
      quote_ask: 101,
      quote_mid: 100,
      quote_observed_at: NOW,
      modelled_cost_breakdown: BREAKDOWN,
      modelled_protective_exit_cost_breakdown: null,
    });
  });

  it.each([
    [{ bid: null, ask: 101, observed_at: null }],
    [{ bid: 99, ask: null, observed_at: null }],
  ])('leaves the mid null for a one-sided quote %j', (quote) => {
    expect(
      submitSnapshotOf(null, quote, { entry: null, protective_exit: null }).quote_mid,
    ).toBeNull();
  });
});

describe('bracketFor', () => {
  it('copies the order onto a native bracket keyed by the idempotency key', () => {
    expect(bracketFor(intent())).toEqual({
      client_order_id: 'key-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      size: 10,
      entry: 100,
      stop: 95,
      target: 110,
      time_in_force: 'day',
    });
  });
});

describe('openPositionFor', () => {
  it('writes a pending, unfilled lot carrying only the snapshot fields that were read', () => {
    const position = openPositionFor(entryIntent(), NOW, SNAPSHOT);
    expect(position).toEqual({
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
      opened_at: NOW,
      decision_timestamp: new Date('2026-07-15T13:55:00Z'),
      conviction: 0.7,
      converged: true,
      decision_price: 100,
      quote_bid: 99,
      quote_ask: 101,
      quote_mid: 100,
      quote_observed_at: NOW,
      modelled_cost_breakdown: BREAKDOWN,
    });
    expect(position).not.toHaveProperty('modelled_protective_exit_cost_breakdown');
  });
});

describe('entryFillRequest', () => {
  it('prices an entry as a limit at the entry price', () => {
    expect(entryFillRequest(intent())).toEqual({
      instrument: 'AAPL',
      side: 'buy',
      size: 10,
      order_type: 'limit',
      limit_price: 100,
      idempotency_key: 'key-1',
    });
  });

  it('prices an exit as a market order with no limit price', () => {
    expect(entryFillRequest(exitIntent())).toEqual({
      instrument: 'AAPL',
      side: 'sell',
      size: 10,
      order_type: 'market',
      idempotency_key: 'key-1',
    });
  });
});

describe('protectiveExitFillRequest', () => {
  it.each([
    ['buy', 'sell'],
    ['sell', 'buy'],
  ] as const)('closes a %s entry with a %s market order', (side, closing) => {
    expect(protectiveExitFillRequest(intent({ side }))).toEqual({
      instrument: 'AAPL',
      side: closing,
      size: 10,
      order_type: 'market',
      idempotency_key: 'key-1',
    });
  });
});

describe('exitRefusal', () => {
  const held = [{ idempotency_key: 'lot-1', held: 10 }];

  it('accepts a closing-side exit for exactly the held quantity', () => {
    expect(exitRefusal(exitIntent(), 'buy', held)).toBeUndefined();
  });

  it('refuses a lot that records more closed than opened before any other check', () => {
    expect(
      exitRefusal(exitIntent({ side: 'buy' }), 'buy', [{ idempotency_key: 'lot-1', held: -1 }]),
    ).toBe(
      "exit intent for 'AAPL' refused: lot 'lot-1' records more closed quantity than it ever opened (held -1)",
    );
  });

  it.each([
    ['buy', 'buy', 'sell'],
    ['sell', 'sell', 'buy'],
  ] as const)('refuses a %s exit against %s-side lots', (side, heldSide, closing) => {
    expect(exitRefusal(exitIntent({ side }), heldSide, held)).toBe(
      `exit intent side '${side}' does not match the closing side '${closing}' implied by the held lot(s)' side ('${heldSide}') for 'AAPL'`,
    );
  });

  it('refuses a size that is not the held quantity', () => {
    expect(exitRefusal(exitIntent({ size: 9 }), 'buy', held)).toBe(
      "exit intent size 9 does not match the held quantity 10 for 'AAPL'",
    );
  });

  it('refuses a diverged lot set after the size check passes', () => {
    const order = exitIntent();
    order.metadata.lot_held_quantities = [{ idempotency_key: 'lot-1', held: 7 }];
    expect(exitRefusal(order, 'buy', held)).toBe(
      "exit intent for 'AAPL' refused: lot 'lot-1' now holds 10 but the intent recorded 7 — the covered lot set has diverged since the Trader keyed this exit",
    );
  });
});

describe('divergedLotRefusal', () => {
  const held = [
    { idempotency_key: 'lot-1', held: 4 },
    { idempotency_key: 'lot-2', held: 6 },
  ];

  it('passes when the intent recorded no lot set', () => {
    expect(divergedLotRefusal(exitIntent(), held)).toBeUndefined();
  });

  it('passes when every recorded lot still holds what was recorded', () => {
    const order = exitIntent();
    order.metadata.lot_held_quantities = held;
    expect(divergedLotRefusal(order, held)).toBeUndefined();
  });

  it('reads a lot missing from the recorded set as 0', () => {
    const order = exitIntent();
    order.metadata.lot_held_quantities = [{ idempotency_key: 'lot-1', held: 4 }];
    expect(divergedLotRefusal(order, held)).toBe(
      "exit intent for 'AAPL' refused: lot 'lot-2' now holds 6 but the intent recorded 0 — the covered lot set has diverged since the Trader keyed this exit",
    );
  });
});
