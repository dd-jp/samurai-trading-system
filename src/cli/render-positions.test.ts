/**
 * `renderPositions` (#97 acceptance criteria): unrealized PnL computed from
 * the current mark for both buy and sell positions. Asserts on formatted
 * output given a fake `QueryStore`, not on real store/database behavior
 * (cli-spec.md "Testing Decisions").
 */
import { describe, expect, it } from 'vitest';
import type { Mark } from '../market-data-service/types.js';
import type { OpenPosition } from '../shared/types.js';
import { renderPositions } from './render-positions.js';
import type { QueryStore } from './types.js';

const AS_OF = new Date('2026-07-19T12:00:00Z');

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'AAPL-2026-07-19T09:30:00Z',
    debate_id: 'debate-abc123',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 100,
    filled_size: 100,
    avg_entry_price: 100,
    stop: 95,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['order-1'],
    opened_at: AS_OF,
    decision_timestamp: AS_OF,
    ...overrides,
  };
}

function makeMark(price: number, overrides: Partial<Mark> = {}): Mark {
  return { price, observed_at: AS_OF, source: 'test', asset_class: 'stocks', ...overrides };
}

function fakeStore(overrides: Partial<QueryStore> = {}): QueryStore {
  return {
    getRecentDebates: () => [],
    getTickStatus: () => null,
    getOpenPositions: () => [],
    getVerdictHistory: () => [],
    getAnalystWeights: () => ({}),
    getAttribution: () => ({}),
    getDailyMetrics: () => {
      throw new Error('not used in these tests');
    },
    getMark: () => makeMark(0),
    ...overrides,
  };
}

describe('renderPositions', () => {
  it('shows unrealized PnL for a long position computed from the current mark', () => {
    const store = fakeStore({
      getOpenPositions: () => [
        makePosition({ instrument: 'AAPL', side: 'buy', avg_entry_price: 100, filled_size: 10 }),
      ],
      getMark: () => makeMark(110),
    });

    const output = renderPositions(store, AS_OF);

    expect(output).toContain('AAPL');
    expect(output).toContain('unrealized_pnl=100');
  });

  it('shows unrealized PnL for a short position computed from the current mark', () => {
    const store = fakeStore({
      getOpenPositions: () => [
        makePosition({ instrument: 'ETH-USD', side: 'sell', avg_entry_price: 100, filled_size: 5 }),
      ],
      getMark: () => makeMark(90),
    });

    const output = renderPositions(store, AS_OF);

    expect(output).toContain('ETH-USD');
    expect(output).toContain('unrealized_pnl=50');
  });

  it('renders a sane empty state when there are no open positions', () => {
    const store = fakeStore();

    const output = renderPositions(store, AS_OF);

    expect(output).toContain('No open positions.');
  });

  it('renders one row per position', () => {
    const store = fakeStore({
      getOpenPositions: () => [
        makePosition({ instrument: 'AAPL' }),
        makePosition({ instrument: 'TSLA' }),
      ],
      getMark: () => makeMark(100),
    });

    const output = renderPositions(store, AS_OF);

    expect(output).toContain('AAPL');
    expect(output).toContain('TSLA');
  });
});
