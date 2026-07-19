import { describe, expect, it } from 'vitest';
import { buildDebateLog, InMemoryDebateLogStore } from './debate-log-store.js';
import type { AnalystContribution, DebateResult } from './types.js';

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

function makeResult(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'Bulls have the stronger case this bar.',
    position: 'Buy',
    confidence: 0.7,
    contributions: [makeContribution()],
    disagreement_summary: 'Bear cites overextension; bull cites volume confirmation.',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 8000,
    direction: 'bullish',
    debate_id: 'debate-1',
    ...overrides,
  };
}

describe('buildDebateLog', () => {
  it('projects a completed DebateResult into a DebateLog row', () => {
    const result = makeResult();
    const bar_timestamp = new Date('2026-07-14T09:00:00Z');
    const created_at = new Date('2026-07-14T09:00:08Z');

    const log = buildDebateLog(result, 'BTC-USD', bar_timestamp, created_at);

    expect(log).toEqual({
      debate_id: 'debate-1',
      instrument: 'BTC-USD',
      bar_timestamp,
      contributions: result.contributions,
      direction: 'bullish',
      rounds: 2,
      created_at,
    });
  });
});

describe('InMemoryDebateLogStore', () => {
  it('a completed debate: row exists and is joinable by debate_id', () => {
    const store = new InMemoryDebateLogStore();
    const result = makeResult();
    const log = buildDebateLog(
      result,
      'BTC-USD',
      new Date('2026-07-14T09:00:00Z'),
      new Date('2026-07-14T09:00:08Z'),
    );

    store.writeLog(log);

    expect(store.getByDebateId('debate-1')).toEqual(log);
  });

  it('a crashed/incomplete debate: no row is written, so lookup is absent', () => {
    const store = new InMemoryDebateLogStore();

    // Simulates decision #10: a crash discards in-flight round state before
    // the debate ever resolves, so `writeLog` (the "Debate log write" step,
    // which only runs after resolution) is never called for this debate_id.
    expect(store.getByDebateId('debate-never-completed')).toBeUndefined();
  });

  it('does not conflate rows across distinct debate_ids', () => {
    const store = new InMemoryDebateLogStore();
    const first = buildDebateLog(
      makeResult({ debate_id: 'debate-1' }),
      'BTC-USD',
      new Date('2026-07-14T09:00:00Z'),
      new Date('2026-07-14T09:00:08Z'),
    );
    const second = buildDebateLog(
      makeResult({ debate_id: 'debate-2', direction: 'bearish' }),
      'ETH-USD',
      new Date('2026-07-14T09:05:00Z'),
      new Date('2026-07-14T09:05:07Z'),
    );

    store.writeLog(first);
    store.writeLog(second);

    expect(store.getByDebateId('debate-1')).toEqual(first);
    expect(store.getByDebateId('debate-2')).toEqual(second);
  });
});
