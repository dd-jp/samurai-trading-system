import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AnalystContribution, AnalystView, DebateResult, Direction } from './types.js';

describe('Direction', () => {
  it('accepts only bullish, bearish, neutral', () => {
    const bullish: Direction = 'bullish';
    const bearish: Direction = 'bearish';
    const neutral: Direction = 'neutral';

    expect([bullish, bearish, neutral]).toEqual(['bullish', 'bearish', 'neutral']);
    // @ts-expect-error — not a valid Direction
    const invalid: Direction = 'sideways';
    expect(invalid).toBeDefined();
  });
});

describe('AnalystView', () => {
  it('matches the upstream contract shape', () => {
    const view: AnalystView = {
      trace_id: 'trace-1',
      analyst_id: 'analyst-technical-1',
      analyst_type: 'technical',
      direction: 'bullish',
      confidence: 0.82,
      key_points: ['RSI oversold bounce', 'volume confirms breakout'],
      timestamp: new Date('2026-07-14T09:00:00Z'),
    };

    expectTypeOf(view).toMatchTypeOf<AnalystView>();
    expect(Object.keys(view).sort()).toEqual(
      [
        'trace_id',
        'analyst_id',
        'analyst_type',
        'direction',
        'confidence',
        'key_points',
        'timestamp',
      ].sort(),
    );
    expect(view.timestamp).toBeInstanceOf(Date);
    expect(Array.isArray(view.key_points)).toBe(true);
  });
});

describe('AnalystContribution', () => {
  it('matches the per-analyst breakdown shape', () => {
    const contribution: AnalystContribution = {
      analyst_id: 'analyst-technical-1',
      analyst_type: 'technical',
      stance_during_debate: ['bullish', 'bullish', 'neutral'],
      final_position: 'neutral',
      rationale: 'Shifted after bear persona raised divergence concerns.',
      influence_score: 0.35,
    };

    expectTypeOf(contribution).toMatchTypeOf<AnalystContribution>();
    expect(contribution.stance_during_debate.every((d) => typeof d === 'string')).toBe(true);
    expect(contribution.stance_during_debate.length).toBe(3);
  });
});

describe('DebateResult', () => {
  it('matches the downstream contract shape, including the direction/debate_id additions', () => {
    const result: DebateResult = {
      synthesis: 'Analysts broadly agree on upside momentum with one dissent.',
      position: 'Enter long with reduced size given open disagreement.',
      confidence: 0.64,
      contributions: [
        {
          analyst_id: 'analyst-technical-1',
          analyst_type: 'technical',
          stance_during_debate: ['bullish'],
          final_position: 'bullish',
          rationale: 'Momentum confirmed across timeframes.',
          influence_score: 0.5,
        },
      ],
      disagreement_summary: 'Sentiment analyst flags overextension risk.',
      open_items: ['overextension risk unresolved'],
      converged: false,
      rounds_completed: 3,
      latency_ms: 12_450,
      direction: 'bullish',
      debate_id: 'debate-abc123',
    };

    expectTypeOf(result).toMatchTypeOf<DebateResult>();
    expect(result.rounds_completed).toBeLessThanOrEqual(3);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.debate_id).toBe('string');
    expect(['bullish', 'bearish', 'neutral']).toContain(result.direction);
  });

  it('allows converged: true with empty open_items', () => {
    const result: DebateResult = {
      synthesis: 'Full agreement across analysts.',
      position: 'Enter long at full size.',
      confidence: 0.95,
      contributions: [],
      disagreement_summary: 'None.',
      open_items: [],
      converged: true,
      rounds_completed: 1,
      latency_ms: 3_200,
      direction: 'bullish',
      debate_id: 'debate-def456',
    };

    expect(result.converged).toBe(true);
    expect(result.open_items).toHaveLength(0);
  });
});
