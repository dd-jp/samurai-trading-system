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

  it('glosses a truncated row with no recorded cause (pre-migration 0051) without naming a cause', () => {
    const gloss = debateDegradedGloss({
      termination: 'latency_truncated',
      termination_cause: undefined,
    });
    expect(gloss).toBe('degraded — latency-truncated, cause not recorded');
    expect(gloss).not.toMatch(/budget/i);
    expect(gloss).not.toMatch(/llm/i);
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
