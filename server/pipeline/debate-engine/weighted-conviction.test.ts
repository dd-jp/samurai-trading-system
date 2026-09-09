/**
 * Weighted debates (#435 part 2). The property the spec makes
 * non-negotiable — identity at the neutral seed — is the first test, because
 * without it the first fortnight of any run silently differs from the
 * unweighted baseline it is being compared against.
 */
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
    // Not approximately. The factor is a ratio of weighted to unweighted
    // agreement, so equal weights make numerator and denominator identical —
    // which is what lets a soak's first fortnight be compared against an
    // unweighted baseline at all.
    const seeded = { technical: 1, sentiment: 1, fundamental: 1 };

    expect(weightedConvictionFactor(panel, 'bullish', seeded)).toBe(1);
  });

  it('is exactly 1 at any UNIFORM weight, not just 1.0', () => {
    // The seed value is a Feedback Loop config detail; the identity property
    // must not depend on it being 1.
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
    // A new analyst must not have its agreement discounted before it has had a
    // chance to earn a weight. Dropping to 0 would silence it entirely.
    const partial = weightedConvictionFactor(panel, 'bullish', { technical: 1 });

    expect(partial).toBe(1);
  });

  it('leaves conviction alone when nobody agrees with the mediator', () => {
    // `direction` is the mediator's synthesis, not a vote, so this happens.
    // With no agreement there is nothing for weights to say.
    expect(weightedConvictionFactor(panel, 'neutral', { technical: 5 })).toBe(1);
  });

  it('leaves conviction alone with no contributions at all', () => {
    expect(weightedConvictionFactor([], 'bullish', { technical: 5 })).toBe(1);
  });

  it('ignores a non-finite or non-positive weight rather than propagating it', () => {
    // A NaN would otherwise make the factor NaN, and NaN * confidence is NaN —
    // which then walks through every conviction comparison downstream, because
    // every comparison against NaN is false.
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
    // Identity by reference, so an unweighted run is provably untouched rather
    // than reconstructed into an equal-looking copy.
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
    // `confidence` is what the Trader's conviction floor and multiplier read.
    // A value above 1 would flow into sizing arithmetic that has never seen one.
    const weighted = applyAnalystWeights(result(panel, 0.95), {
      technical: 10,
      sentiment: 10,
      fundamental: 0.1,
    });

    expect(weighted.confidence).toBeLessThanOrEqual(1);
  });
});
