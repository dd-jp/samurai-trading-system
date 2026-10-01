import { describe, expect, it } from 'vitest';
import type { BrokerFillId, NormalizedFill } from '../../shared/index.js';
import { mergeSplitsIntoLots } from './ingest-fills.js';
import { flattenDivergence, flattenStoreState } from './reconcile.js';
import { sweepDivergence } from './residual-protection-sweep.js';
import type { UnresolvedFlattenSubmission } from './types.js';

function flattenRow(
  overrides: Partial<UnresolvedFlattenSubmission> = {},
): UnresolvedFlattenSubmission {
  return {
    idempotency_key: 'flatten-1',
    instrument: 'AAPL',
    status: 'submitted',
    submitted_at: new Date('2026-07-15T14:00:00Z'),
    order_state: null,
    cancel_attempted_at: null,
    terminal_unswept_checked_at: null,
    ...overrides,
  };
}

function fill(id: string): NormalizedFill {
  return {
    client_order_id: 'flatten-1',
    broker_fill_id: id as BrokerFillId,
    leg: 'exit',
    price: 100,
    qty: 1,
    fee: 0,
    timestamp: new Date('2026-07-15T14:00:00Z'),
  };
}

describe('flattenStoreState', () => {
  it.each([
    ['submitting', 'pending'],
    ['submitted', 'submitted'],
  ] as const)('reads a %s row as %s', (status, state) => {
    expect(flattenStoreState(flattenRow({ status }))).toBe(state);
  });
});

describe('flattenDivergence', () => {
  it('builds a flatten-kind divergence from the row', () => {
    expect(flattenDivergence(flattenRow(), 'submitted', 'filled', 'adopted', 'why')).toEqual({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      store_state: 'submitted',
      broker_state: 'filled',
      action: 'adopted',
      kind: 'flatten',
      reason: 'why',
    });
  });
});

describe('sweepDivergence', () => {
  it('builds a sweep-kind divergence with no broker state', () => {
    const position = { idempotency_key: 'lot-1', instrument: 'AAPL', order_state: 'filled' };
    expect(
      sweepDivergence(position as Parameters<typeof sweepDivergence>[0], 'undetermined', 'why'),
    ).toEqual({
      idempotency_key: 'lot-1',
      instrument: 'AAPL',
      store_state: 'filled',
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason: 'why',
    });
  });
});

describe('mergeSplitsIntoLots', () => {
  it('appends to known buckets, opens new ones, and returns only splits for unknown lots', () => {
    const byLot = new Map([['lot-1', [fill('a')]]]);
    const unattributed = mergeSplitsIntoLots(
      byLot,
      [
        ['lot-1', [fill('b')]],
        ['lot-2', [fill('c')]],
        ['lot-3', [fill('d')]],
      ],
      new Set(['lot-1', 'lot-2']),
    );
    expect(Object.fromEntries(byLot)).toEqual({
      'lot-1': [fill('a'), fill('b')],
      'lot-2': [fill('c')],
      'lot-3': [fill('d')],
    });
    expect(unattributed).toEqual([['lot-3', [fill('d')]]]);
  });
});
