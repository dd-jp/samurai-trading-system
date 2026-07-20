import { describe, expect, it } from 'vitest';
import type { AnalystRoundStance } from './analyst-contribution.js';
import { computeConvictionScore } from './conviction-score.js';
import type { AnalystView } from './types.js';

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 1,
    key_points: ['Volume confirms breakout.', 'RSI not overbought.', 'Trend intact.'],
    timestamp: new Date('2026-07-14T09:00:00Z'),
    ...overrides,
  };
}

describe('computeConvictionScore', () => {
  it('scores 1.0 on full agreement with strong evidence', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bullish' }),
      makeView({ analyst_id: 'a3', direction: 'bullish' }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bullish' },
      { analyst_id: 'a3', round: 1, stance: 'bullish' },
    ];

    expect(computeConvictionScore(views, roundStances)).toBe(1);
  });

  it('scores 0.0 on full disagreement with weak evidence', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish', confidence: 0, key_points: [] }),
      makeView({ analyst_id: 'a2', direction: 'bearish', confidence: 0, key_points: [] }),
      makeView({ analyst_id: 'a3', direction: 'neutral', confidence: 0, key_points: [] }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bearish' },
      { analyst_id: 'a3', round: 1, stance: 'neutral' },
    ];

    expect(computeConvictionScore(views, roundStances)).toBe(0);
  });

  it('scores 0.5 on mixed signals with moderate evidence', () => {
    const views = [
      makeView({
        analyst_id: 'a1',
        direction: 'bullish',
        confidence: 0.5,
        key_points: ['Some support.'],
      }),
      makeView({
        analyst_id: 'a2',
        direction: 'neutral',
        confidence: 0.5,
        key_points: ['Some support.', 'More support.'],
      }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'neutral' },
    ];

    // Disagreement metric: spread 1 on a [-1,1] axis -> 1 - 1/2 = 0.5.
    // Evidence strength: avg key points 1.5/3 = 0.5, avg confidence 0.5 -> 0.5.
    // score = 0.6 * 0.5 + 0.4 * 0.5 = 0.5
    expect(computeConvictionScore(views, roundStances)).toBe(0.5);
  });

  it('returns a defined default score when there are no analyst views', () => {
    expect(computeConvictionScore([], [])).toBe(0.5);
  });

  it('returns a defined score when there are no round stances (no rounds run)', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bullish' }),
    ];

    const score = computeConvictionScore(views, []);

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBe(1);
  });

  it('falls back to the original view direction when computing agreement with no round stances', () => {
    const views = [
      makeView({ analyst_id: 'a1', direction: 'bullish' }),
      makeView({ analyst_id: 'a2', direction: 'bearish' }),
    ];

    const score = computeConvictionScore(views, []);

    expect(score).toBeLessThan(1);
  });

  it('always normalizes the score to the 0.0-1.0 range', () => {
    const views = [
      makeView({ analyst_id: 'a1', confidence: 1, key_points: Array(10).fill('point') }),
      makeView({ analyst_id: 'a2', confidence: 1, key_points: Array(10).fill('point') }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bullish' },
    ];

    const score = computeConvictionScore(views, roundStances);

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores partial agreement as a spread between the extremes on the bearish-bullish axis', () => {
    const views = [
      makeView({ analyst_id: 'a1', confidence: 1, key_points: Array(3).fill('point') }),
      makeView({ analyst_id: 'a2', confidence: 1, key_points: Array(3).fill('point') }),
      makeView({ analyst_id: 'a3', confidence: 1, key_points: Array(3).fill('point') }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bullish' },
      { analyst_id: 'a3', round: 1, stance: 'neutral' },
    ];

    // Disagreement metric: spread 1 (bullish=1, neutral=0) on a [-1,1] axis -> 1 - 1/2 = 0.5.
    // Evidence strength: 1.0 (saturated key points, full confidence).
    // score = 0.6 * 0.5 + 0.4 * 1 = 0.7
    expect(computeConvictionScore(views, roundStances)).toBeCloseTo(0.7, 5);
  });
});
