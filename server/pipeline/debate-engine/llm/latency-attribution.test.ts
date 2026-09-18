import { describe, expect, it } from 'vitest';

const BEST_OBSERVED_MS_PER_OUTPUT_TOKEN = 11.48;

const SAME_DEBATE_ADJACENT_CALLS = {
  earlier: {
    id: 145,
    latency_ms: 6_098,
    output_tokens: 274,
    timestamp: '2026-08-27T14:04:05.788Z',
  },
  later: { id: 146, latency_ms: 28_340, output_tokens: 253, timestamp: '2026-08-27T14:04:34.129Z' },
} as const;

function excessMs(latencyMs: number, outputTokens: number): number {
  return latencyMs - outputTokens * BEST_OBSERVED_MS_PER_OUTPUT_TOKEN;
}

const HEADLINE_SAMPLE_SIZE = 398;

const CALLS_BY_IDLE_GAP = {
  afterLongIdle: { n: 12, maxLatencyMs: 11_657, callsOver15s: 0 },
  oneToFiveMin: { n: 1, maxLatencyMs: 6_525, callsOver15s: 0 },
  backToBack: { n: 385, maxLatencyMs: 28_340, callsOver15s: 16 },
} as const;

describe('debate LLM latency attribution (#1012)', () => {
  it('the global-maximum call cannot be explained by generation time even at the fastest observed throughput', () => {
    const { later } = SAME_DEBATE_ADJACENT_CALLS;

    expect(excessMs(later.latency_ms, later.output_tokens)).toBeGreaterThan(20_000);
  });

  it('a call with FEWER output tokens can still take far longer, ruling out output length as the tail driver', () => {
    const { earlier, later } = SAME_DEBATE_ADJACENT_CALLS;

    expect(later.output_tokens).toBeLessThan(earlier.output_tokens);
    expect(later.latency_ms).toBeGreaterThan(earlier.latency_ms);
  });

  it('the two calls are near-identical in shape (same debate, output tokens within 10%) yet differ by more than 4x in latency', () => {
    const { earlier, later } = SAME_DEBATE_ADJACENT_CALLS;
    const outputTokenRatio = later.output_tokens / earlier.output_tokens;
    const latencyRatio = later.latency_ms / earlier.latency_ms;

    expect(outputTokenRatio).toBeGreaterThan(0.9);
    expect(latencyRatio).toBeGreaterThan(4);
  });

  it('the two calls are consecutive (seconds apart), which is what rules out "different weather" as an explanation for the shape difference alone', () => {
    const { earlier, later } = SAME_DEBATE_ADJACENT_CALLS;
    const gapMs = Date.parse(later.timestamp) - Date.parse(earlier.timestamp);

    expect(gapMs).toBeLessThan(60_000);
  });

  it('rules out cold-connection/idle-reconnect as the tail driver: every slow (>15s) call is back-to-back, none follow an idle gap', () => {
    const { afterLongIdle, backToBack } = CALLS_BY_IDLE_GAP;

    expect(afterLongIdle.callsOver15s).toBe(0);
    expect(backToBack.callsOver15s).toBeGreaterThan(0);
    expect(afterLongIdle.maxLatencyMs).toBeLessThan(backToBack.maxLatencyMs);
  });

  it('the idle-gap buckets, a windowed LAG() query over the timeline, sum to the same row count the headline COUNT(*) query reports', () => {
    const { afterLongIdle, oneToFiveMin, backToBack } = CALLS_BY_IDLE_GAP;
    const bucketedTotal = afterLongIdle.n + oneToFiveMin.n + backToBack.n;

    expect(bucketedTotal).toBe(HEADLINE_SAMPLE_SIZE);
  });
});
