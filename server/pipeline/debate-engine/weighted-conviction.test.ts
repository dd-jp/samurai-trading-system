import type { AnalystContribution, DebateResult } from './types.js';
import { applyAnalystWeights, weightedConvictionFactor } from './weighted-conviction.js';

function contribution(
  analyst_id: string,
  final_position: 'bullish' | 'bearish' | 'neutral',
): AnalystContribution {
  return {
    analyst_id,
    analyst_type: analyst_id,
    stance_during_debate: [],
    final_position,
    rationale: 'because',
    influence_score: 0,
  };
}

function result(contributions: AnalystContribution[], confidence = 0.6): DebateResult {
  return {
    synthesis: 's',
    position: 'p',
    confidence,
    contributions,
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 1,
    latency_ms: 1,
    direction: 'bullish',
    debate_id: 'debate-1',
    bar_timestamp: new Date('2026-07-15T10:00:00Z'),
    read: true,
  };
}

describe('weightedConvictionFactor', () => {
  const panel = [
    contribution('technical', 'bullish'),
    contribution('sentiment', 'bullish'),
    contribution('fundamental', 'bearish'),
  ];

  it('is EXACTLY 1 at the neutral seed', () => {
    const seeded = { technical: 1, sentiment: 1, fundamental: 1 };

    expect(weightedConvictionFactor(panel, 'bullish', seeded)).toBe(1);
  });

  it('is exactly 1 at any UNIFORM weight, not just 1.0', () => {
    expect(
      weightedConvictionFactor(panel, 'bullish', {
        technical: 0.5,
        sentiment: 0.5,
        fundamental: 0.5,
      }),
    ).toBe(1);
  });

  it('raises conviction when the AGREEING analysts are better weighted', () => {
    const factor = weightedConvictionFactor(panel, 'bullish', {
      technical: 2,
      sentiment: 2,
      fundamental: 0.5,
    });

    expect(factor).toBeGreaterThan(1);
  });

  it('lowers conviction when the agreeing analysts are worse weighted', () => {
    const factor = weightedConvictionFactor(panel, 'bullish', {
      technical: 0.5,
      sentiment: 0.5,
      fundamental: 2,
    });

    expect(factor).toBeLessThan(1);
  });

  it('treats an analyst with no weight row as neutral, not as zero', () => {
    const partial = weightedConvictionFactor(panel, 'bullish', { technical: 1 });

    expect(partial).toBe(1);
  });

  it('leaves conviction alone when nobody agrees with the mediator', () => {
    expect(weightedConvictionFactor(panel, 'neutral', { technical: 5 })).toBe(1);
  });

  it('leaves conviction alone with no contributions at all', () => {
    expect(weightedConvictionFactor([], 'bullish', { technical: 5 })).toBe(1);
  });

  it('ignores a non-finite or non-positive weight rather than propagating it', () => {
    const factor = weightedConvictionFactor(panel, 'bullish', {
      technical: Number.NaN,
      sentiment: -1,
      fundamental: 1,
    });

    expect(Number.isFinite(factor)).toBe(true);
    expect(factor).toBe(1);
  });
});

describe('applyAnalystWeights', () => {
  const panel = [
    contribution('technical', 'bullish'),
    contribution('sentiment', 'bullish'),
    contribution('fundamental', 'bearish'),
  ];

  it('returns the SAME object at the neutral seed', () => {
    const original = result(panel);

    expect(applyAnalystWeights(original, { technical: 1, sentiment: 1, fundamental: 1 })).toBe(
      original,
    );
  });

  it('scales confidence and leaves everything else alone', () => {
    const original = result(panel, 0.5);
    const weighted = applyAnalystWeights(original, {
      technical: 2,
      sentiment: 2,
      fundamental: 0.5,
    });

    expect(weighted.confidence).toBeGreaterThan(0.5);
    expect(weighted.debate_id).toBe(original.debate_id);
    expect(weighted.direction).toBe(original.direction);
    expect(weighted.contributions).toBe(original.contributions);
  });

  it('clamps to 1 — a high confidence times a factor above 1 must not exceed the range', () => {
    const weighted = applyAnalystWeights(result(panel, 0.95), {
      technical: 10,
      sentiment: 10,
      fundamental: 0.1,
    });

    expect(weighted.confidence).toBeLessThanOrEqual(1);
  });
});
