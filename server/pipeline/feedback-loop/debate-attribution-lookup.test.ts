import type { AnalystContribution, DebateResult } from '../debate-engine/index.js';
import { buildDebateLog, InMemoryDebateLogStore } from '../debate-engine/index.js';
import { getContributionsForAttribution } from './debate-attribution-lookup.js';

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
    bar_timestamp: new Date('2026-07-14T09:00:00Z'),
    read: true,
    ...overrides,
  };
}

describe('getContributionsForAttribution', () => {
  it('joins by debate_id and returns the completed debate contributions', () => {
    const store = new InMemoryDebateLogStore();
    const result = makeResult();
    store.writeLog(buildDebateLog(result, 'BTC-USD', new Date('2026-07-14T09:00:08Z')));

    expect(getContributionsForAttribution(store, 'debate-1')).toEqual(result.contributions);
  });

  it('returns undefined for a debate_id with no DebateLog row (crashed/incomplete debate)', () => {
    const store = new InMemoryDebateLogStore();

    expect(getContributionsForAttribution(store, 'debate-never-completed')).toBeUndefined();
  });

  it('returns undefined for a debate the latency budget truncated, even though a row exists', () => {
    const store = new InMemoryDebateLogStore();
    const result = makeResult({
      converged: false,
      timed_out: { budget_ms: 60_000, elapsed_ms: 60_003 },
    });
    store.writeLog(buildDebateLog(result, 'AAPL', new Date('2026-07-14T09:00:08Z')));

    expect(getContributionsForAttribution(store, 'debate-1')).toBeUndefined();
  });

  it('still attributes a debate that genuinely failed to converge — no timeout', () => {
    const store = new InMemoryDebateLogStore();
    const result = makeResult({ converged: false });
    store.writeLog(buildDebateLog(result, 'AAPL', new Date('2026-07-14T09:00:08Z')));

    expect(getContributionsForAttribution(store, 'debate-1')).toEqual(result.contributions);
  });

  it('still attributes a pre-#1081 row with no termination recorded — makes no claim either way', () => {
    const store = new InMemoryDebateLogStore();
    store.writeLog({
      debate_id: 'debate-pre-1081',
      instrument: 'AAPL',
      bar_timestamp: new Date('2026-07-14T09:00:00Z'),
      contributions: [makeContribution()],
      direction: 'bullish',
      rounds: 2,
      created_at: new Date('2026-07-14T09:00:08Z'),
    });

    expect(getContributionsForAttribution(store, 'debate-pre-1081')).toEqual([makeContribution()]);
  });
});
