/**
 * `renderDebates` (#98 acceptance criteria): recent completed debates with
 * contributions/direction, a coarse tick-in-progress line sourced from
 * `getTickStatus`, and — the named unit test — no in-progress line when no
 * tick is active. Asserts on formatted output given a fake `QueryStore`, not
 * on real store/database behavior (cli-spec.md "Testing Decisions").
 */
import { describe, expect, it } from 'vitest';
import type { AnalystContribution } from '../debate-engine/types.js';
import type { DebateLog } from '../shared/types.js';
import { renderDebates } from './render-debates.js';
import type { QueryStore, TickStatus } from './types.js';

const AS_OF = new Date('2026-07-19T12:00:00Z');

function makeContribution(overrides: Partial<AnalystContribution> = {}): AnalystContribution {
  return {
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    stance_during_debate: ['bullish', 'bullish'],
    final_position: 'bullish',
    rationale: 'Volume confirms breakout.',
    influence_score: 0.6,
    ...overrides,
  };
}

function makeDebateLog(overrides: Partial<DebateLog> = {}): DebateLog {
  return {
    debate_id: 'debate-1',
    instrument: 'BTC-USD',
    bar_timestamp: new Date('2026-07-19T09:00:00Z'),
    contributions: [makeContribution()],
    direction: 'bullish',
    rounds: 2,
    created_at: new Date('2026-07-19T09:00:08Z'),
    ...overrides,
  };
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
    getMark: () => {
      throw new Error('not used in these tests');
    },
    ...overrides,
  };
}

describe('renderDebates', () => {
  it('shows the N most recent completed debates with contributions and direction', () => {
    const debates = [
      makeDebateLog({ debate_id: 'debate-1', instrument: 'BTC-USD', direction: 'bullish' }),
      makeDebateLog({
        debate_id: 'debate-2',
        instrument: 'ETH-USD',
        direction: 'bearish',
        contributions: [
          makeContribution({
            analyst_id: 'analyst-sentiment-1',
            analyst_type: 'sentiment',
            final_position: 'bearish',
            influence_score: 0.4,
          }),
        ],
      }),
    ];
    const store = fakeStore({ getRecentDebates: () => debates });

    const output = renderDebates(store, AS_OF);

    expect(output).toContain('BTC-USD');
    expect(output).toContain('bullish');
    expect(output).toContain('analyst-technical-1');
    expect(output).toContain('ETH-USD');
    expect(output).toContain('bearish');
    expect(output).toContain('analyst-sentiment-1');
  });

  it('with no active tick, produces no in-progress line', () => {
    const store = fakeStore({
      getRecentDebates: () => [makeDebateLog()],
      getTickStatus: () => null,
    });

    const output = renderDebates(store, AS_OF);

    expect(output).not.toContain('tick in progress');
  });

  it("shows 'tick in progress for {instrument}' when current_tick has an active row", () => {
    const tickStatus: TickStatus = {
      instrument: 'AAPL',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: 'trace-aapl-1400',
    };
    const store = fakeStore({ getTickStatus: () => tickStatus });

    const output = renderDebates(store, AS_OF);

    expect(output).toContain('tick in progress for AAPL');
  });

  it('renders a sane empty state when there are no completed debates', () => {
    const store = fakeStore();

    const output = renderDebates(store, AS_OF);

    expect(output).toContain('No completed debates.');
  });
});
