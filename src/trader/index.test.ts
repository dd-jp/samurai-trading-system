/**
 * Trader-side stub verifying DebateResult.direction/debate_id flow into
 * OrderIntent.metadata (issue #62 acceptance criterion). Not the real
 * Trader — that's epic #54 / ticket #73. This only proves the type-level
 * join the Trader will rely on.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DebateResult } from '../debate-engine/index.js';
import type { OrderIntentMetadata } from '../shared/types.js';

function stubMetadataFromDebate(debate: DebateResult): OrderIntentMetadata {
  return {
    debate_id: debate.debate_id,
    conviction: debate.confidence,
    converged: debate.converged,
    sizing: {
      base_risk_fraction: 0,
      conviction_multiplier: 1,
      vol_floor_factor: 1,
      non_converged_haircut: debate.converged ? 1 : 0.5,
      cosine_multiplier: 0.75,
    },
    cosine_precedent: {
      neighbor_count: 0,
      weighted_mean_r: null,
      no_precedent: true,
    },
  };
}

describe('OrderIntentMetadata.debate_id (Trader-side stub)', () => {
  it('carries DebateResult.debate_id through to OrderIntent.metadata', () => {
    const debate: DebateResult = {
      synthesis: 'Analysts broadly agree on upside momentum with one dissent.',
      position: 'Enter long with reduced size given open disagreement.',
      confidence: 0.64,
      contributions: [],
      disagreement_summary: 'Sentiment analyst flags overextension risk.',
      open_items: ['overextension risk unresolved'],
      converged: false,
      rounds_completed: 3,
      latency_ms: 12_450,
      direction: 'bullish',
      debate_id: 'debate-abc123',
    };

    const metadata = stubMetadataFromDebate(debate);

    expectTypeOf(metadata).toMatchTypeOf<OrderIntentMetadata>();
    expect(metadata.debate_id).toBe(debate.debate_id);
    expect(metadata.conviction).toBe(debate.confidence);
    expect(metadata.converged).toBe(debate.converged);
  });
});
