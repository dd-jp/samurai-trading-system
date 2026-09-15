import type { DebateRow } from '@contracts';

/**
 * The operator-facing gloss for a degraded debate (#1396), shared by both
 * renderers of `DebateRow` — `whyTaken` (ReviewTab.tsx) and `DebateSection`
 * (TraceSections.tsx) — so a degraded row cannot show its cause in one and
 * drop it in the other. `docs/coding-standards.md`'s #1080 entry names
 * exactly this failure mode for a different field on the same wire type.
 *
 * `null` when there is nothing to gloss: a converged/non-converged row, or
 * one written before migration 0041, where `termination` itself is absent
 * and genuinely indeterminate rather than known-normal.
 */
export function debateDegradedGloss(
  debate: Pick<DebateRow, 'termination' | 'termination_cause'>,
): string | null {
  if (debate.termination !== 'latency_truncated') return null;
  if (debate.termination_cause === 'llm_failure') return 'degraded — an LLM call failed outright';
  if (debate.termination_cause === 'budget') return 'degraded — latency budget exceeded';
  // Truncated, but written before migration 0051 — the cause is genuinely
  // indeterminate (could be budget expiry or an escaped LLM failure), so the
  // gloss must not name either one
  return 'degraded — latency-truncated, cause not recorded';
}
