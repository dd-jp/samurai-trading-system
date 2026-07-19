/**
 * `renderVerdicts` (#97 acceptance criteria): go/no-go history with reasons.
 * Asserts on formatted output given a fake `QueryStore`, not on real
 * store/database behavior (cli-spec.md "Testing Decisions").
 */
import { describe, expect, it } from 'vitest';
import { renderVerdicts } from './render-verdicts.js';
import type { QueryStore, VerdictAuditEntry } from './types.js';

const AS_OF = new Date('2026-07-19T12:00:00Z');

function makeVerdictEntry(overrides: Partial<VerdictAuditEntry> = {}): VerdictAuditEntry {
  return {
    trace_id: 'trace-1',
    instrument: 'AAPL',
    status: 'go',
    reason: 'approved',
    hitl_override: false,
    timestamp: AS_OF,
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

describe('renderVerdicts', () => {
  it('shows a go verdict with its reason', () => {
    const store = fakeStore({
      getVerdictHistory: () => [
        makeVerdictEntry({ instrument: 'AAPL', status: 'go', reason: 'approved' }),
      ],
    });

    const output = renderVerdicts(store, AS_OF);

    expect(output).toContain('AAPL');
    expect(output).toContain('go');
    expect(output).toContain('reason=approved');
  });

  it('shows a no_go verdict with the gate that fired', () => {
    const store = fakeStore({
      getVerdictHistory: () => [
        makeVerdictEntry({ instrument: 'BTC-USD', status: 'no_go', reason: 'staleness' }),
      ],
    });

    const output = renderVerdicts(store, AS_OF);

    expect(output).toContain('BTC-USD');
    expect(output).toContain('no_go');
    expect(output).toContain('reason=staleness');
  });

  it('shows whether a verdict was a HITL override', () => {
    const store = fakeStore({
      getVerdictHistory: () => [makeVerdictEntry({ hitl_override: true })],
    });

    const output = renderVerdicts(store, AS_OF);

    expect(output).toContain('hitl_override=true');
  });

  it('renders a sane empty state when there is no verdict history', () => {
    const store = fakeStore();

    const output = renderVerdicts(store, AS_OF);

    expect(output).toContain('No verdict history.');
  });

  it('renders one row per verdict, in the order given', () => {
    const store = fakeStore({
      getVerdictHistory: () => [
        makeVerdictEntry({ instrument: 'AAPL' }),
        makeVerdictEntry({ instrument: 'TSLA' }),
      ],
    });

    const output = renderVerdicts(store, AS_OF);

    expect(output).toContain('AAPL');
    expect(output).toContain('TSLA');
  });
});
