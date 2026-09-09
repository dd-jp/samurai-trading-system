import { describe, expect, it } from 'vitest';
import { debateDegradedGloss } from './debate-termination.ts';

describe('debateDegradedGloss', () => {
  it('glosses an llm_failure truncation', () => {
    expect(
      debateDegradedGloss({ termination: 'latency_truncated', termination_cause: 'llm_failure' }),
    ).toBe('degraded — an LLM call failed outright');
  });

  it('glosses a budget truncation', () => {
    expect(
      debateDegradedGloss({ termination: 'latency_truncated', termination_cause: 'budget' }),
    ).toBe('degraded — latency budget exceeded');
  });

  it('glosses a truncated row with no recorded cause (pre-migration 0051)', () => {
    expect(
      debateDegradedGloss({ termination: 'latency_truncated', termination_cause: undefined }),
    ).toBe('degraded — latency budget truncated it (cause not recorded)');
  });

  it('is null for a converged debate', () => {
    expect(
      debateDegradedGloss({ termination: 'converged', termination_cause: undefined }),
    ).toBeNull();
  });

  it('is null for a non-converged (real disagreement) debate', () => {
    expect(
      debateDegradedGloss({ termination: 'non_converged', termination_cause: undefined }),
    ).toBeNull();
  });

  it('is null for a pre-migration-0041 row with no termination at all', () => {
    expect(
      debateDegradedGloss({ termination: undefined, termination_cause: undefined }),
    ).toBeNull();
  });
});
