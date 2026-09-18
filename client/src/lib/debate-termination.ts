import type { DebateRow } from '@contracts';

export function debateDegradedGloss(
  debate: Pick<DebateRow, 'termination' | 'termination_cause'>,
): string | null {
  if (debate.termination !== 'latency_truncated') return null;
  if (debate.termination_cause === 'llm_failure') return 'degraded — an LLM call failed outright';
  if (debate.termination_cause === 'budget') return 'degraded — latency budget exceeded';
  return 'degraded — latency-truncated, cause not recorded';
}
