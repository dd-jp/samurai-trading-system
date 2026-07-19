import { describe, expect, it } from 'vitest';
import type { AnalystRoundStance } from './analyst-contribution.js';
import { buildAnalystContributions } from './analyst-contribution.js';
import type { AnalystView } from './types.js';

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'analyst-technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['Volume confirms breakout.', 'RSI not overbought.'],
    timestamp: new Date('2026-07-14T09:00:00Z'),
    ...overrides,
  };
}

describe('buildAnalystContributions', () => {
  it('builds one contribution per analyst view, preserving order', () => {
    const views = [
      makeView({ analyst_id: 'a1', analyst_type: 'technical' }),
      makeView({ analyst_id: 'a2', analyst_type: 'fundamental', direction: 'bearish' }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bearish' },
    ];

    const contributions = buildAnalystContributions(views, roundStances);

    expect(contributions).toHaveLength(2);
    expect(contributions[0].analyst_id).toBe('a1');
    expect(contributions[1].analyst_id).toBe('a2');
  });

  it('captures analyst_id, analyst_type, and rationale from the source view', () => {
    const views = [
      makeView({
        analyst_id: 'a1',
        analyst_type: 'sentiment',
        key_points: ['Social sentiment turning positive.', 'News flow neutral.'],
      }),
    ];

    const [contribution] = buildAnalystContributions(views, []);

    expect(contribution.analyst_id).toBe('a1');
    expect(contribution.analyst_type).toBe('sentiment');
    expect(contribution.rationale).toBe('Social sentiment turning positive.; News flow neutral.');
  });

  it('orders stance_during_debate by round regardless of input order', () => {
    const views = [makeView({ analyst_id: 'a1' })];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 2, stance: 'neutral' },
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a1', round: 3, stance: 'bearish' },
    ];

    const [contribution] = buildAnalystContributions(views, roundStances);

    expect(contribution.stance_during_debate).toEqual(['bullish', 'neutral', 'bearish']);
    expect(contribution.final_position).toBe('bearish');
  });

  it('falls back to the original view direction when no round stances were recorded', () => {
    const views = [makeView({ analyst_id: 'a1', direction: 'bullish' })];

    const [contribution] = buildAnalystContributions(views, []);

    expect(contribution.stance_during_debate).toEqual([]);
    expect(contribution.final_position).toBe('bullish');
  });

  it('scores influence 0 when the analyst never changes stance across rounds', () => {
    const views = [makeView({ analyst_id: 'a1' })];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a1', round: 2, stance: 'bullish' },
      { analyst_id: 'a1', round: 3, stance: 'bullish' },
    ];

    const [contribution] = buildAnalystContributions(views, roundStances);

    expect(contribution.influence_score).toBe(0);
  });

  it('scores influence 0 when only a single round stance is recorded', () => {
    const views = [makeView({ analyst_id: 'a1' })];
    const roundStances: AnalystRoundStance[] = [{ analyst_id: 'a1', round: 1, stance: 'bullish' }];

    const [contribution] = buildAnalystContributions(views, roundStances);

    expect(contribution.influence_score).toBe(0);
  });

  it('scores influence 0.5 when the analyst flips once across three rounds', () => {
    const views = [makeView({ analyst_id: 'a1' })];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a1', round: 2, stance: 'bullish' },
      { analyst_id: 'a1', round: 3, stance: 'bearish' },
    ];

    const [contribution] = buildAnalystContributions(views, roundStances);

    expect(contribution.influence_score).toBe(0.5);
  });

  it('scores influence 1.0 when the analyst flips every round (hard cap, 3 rounds)', () => {
    const views = [makeView({ analyst_id: 'a1' })];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a1', round: 2, stance: 'bearish' },
      { analyst_id: 'a1', round: 3, stance: 'neutral' },
    ];

    const [contribution] = buildAnalystContributions(views, roundStances);

    expect(contribution.influence_score).toBe(1);
  });

  it('tracks multiple analysts independently across a multi-round debate', () => {
    const views = [
      makeView({ analyst_id: 'a1', analyst_type: 'technical' }),
      makeView({ analyst_id: 'a2', analyst_type: 'fundamental', direction: 'bearish' }),
    ];
    const roundStances: AnalystRoundStance[] = [
      { analyst_id: 'a1', round: 1, stance: 'bullish' },
      { analyst_id: 'a1', round: 2, stance: 'bullish' },
      { analyst_id: 'a1', round: 3, stance: 'bullish' },
      { analyst_id: 'a2', round: 1, stance: 'bearish' },
      { analyst_id: 'a2', round: 2, stance: 'neutral' },
      { analyst_id: 'a2', round: 3, stance: 'bullish' },
    ];

    const contributions = buildAnalystContributions(views, roundStances);

    expect(contributions[0].stance_during_debate).toEqual(['bullish', 'bullish', 'bullish']);
    expect(contributions[0].final_position).toBe('bullish');
    expect(contributions[0].influence_score).toBe(0);

    expect(contributions[1].stance_during_debate).toEqual(['bearish', 'neutral', 'bullish']);
    expect(contributions[1].final_position).toBe('bullish');
    expect(contributions[1].influence_score).toBe(1);
  });

  it('returns an empty list when there are no analyst views', () => {
    expect(buildAnalystContributions([], [])).toEqual([]);
  });
});
