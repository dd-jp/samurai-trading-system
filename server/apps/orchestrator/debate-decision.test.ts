import type { DebateResult } from '../../pipeline/debate-engine/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { AnalystViewRelay, buildControlDebateStep } from './control-arm.js';
import { debateDecisionWord, isDegradedDecision } from './debate-decision.js';

const BAR = new Date('2026-09-03T14:00:00.000Z');

function resolvedDebate(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'the panel converged',
    position: 'bullish: momentum intact',
    confidence: 0.71,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 21_400,
    direction: 'bullish',
    debate_id: 'debate-1',
    bar_timestamp: BAR,
    read: true,
    ...overrides,
  };
}

describe('debateDecisionWord', () => {
  it('records the direction of a debate that resolved on its own terms', () => {
    expect(debateDecisionWord(resolvedDebate())).toBe('bullish');
    expect(debateDecisionWord(resolvedDebate({ direction: 'neutral', confidence: 0.2 }))).toBe(
      'neutral',
    );
  });

  it('names a budget that fired before any round completed', () => {
    const starved = resolvedDebate({
      direction: 'neutral',
      confidence: 0,
      converged: false,
      rounds_completed: 0,
      timed_out: { budget_ms: 60_000, elapsed_ms: 60_002 },
    });

    expect(debateDecisionWord(starved)).toBe('budget_exhausted');
  });

  it('separates a truncated synthesis from an absent one', () => {
    const partial = resolvedDebate({
      converged: false,
      rounds_completed: 1,
      timed_out: { budget_ms: 60_000, elapsed_ms: 60_001 },
    });

    expect(debateDecisionWord(partial)).toBe('timed_out_partial');
  });

  it('names a debate that was never admitted, ahead of any budget it never ran under', () => {
    const refused = resolvedDebate({
      direction: 'neutral',
      confidence: 0,
      converged: false,
      rounds_completed: 0,
      rate_limited: { reason: 'spend cap reached' },
    });

    expect(debateDecisionWord(refused)).toBe('not_admitted');
  });

  it('names a result marked unread ahead of its bare direction (#1393)', () => {
    const unread = resolvedDebate({
      direction: 'neutral',
      confidence: 0,
      converged: false,
      rounds_completed: 0,
      read: false,
    });

    expect(debateDecisionWord(unread)).toBe('unread');
    expect(isDegradedDecision(debateDecisionWord(unread))).toBe(true);
  });

  it('leaves the control arm writing its bare direction (#1080 AC6)', async () => {
    const relay = new AnalystViewRelay();
    const control = buildControlDebateStep(relay);

    const result = await control({
      trace_id: 'trace-1:control',
      instrument: 'QQQ',
      asset_class: 'stocks',
      views: [],
      clock: new SimulatedClock(BAR),
      bar: BAR,
    });

    expect(result.rounds_completed).toBe(0);
    expect(result.confidence).toBe(0);
    expect(debateDecisionWord(result)).toBe('neutral');
    expect(isDegradedDecision(debateDecisionWord(result))).toBe(false);
  });

  it('reports exactly the degraded words as degraded', () => {
    expect(isDegradedDecision('budget_exhausted')).toBe(true);
    expect(isDegradedDecision('timed_out_partial')).toBe(true);
    expect(isDegradedDecision('not_admitted')).toBe(true);
    expect(isDegradedDecision('unread')).toBe(true);
    expect(isDegradedDecision('bullish')).toBe(false);
    expect(isDegradedDecision('neutral')).toBe(false);
    expect(isDegradedDecision('quorum_skip')).toBe(false);
    expect(isDegradedDecision(null)).toBe(false);
  });
});
