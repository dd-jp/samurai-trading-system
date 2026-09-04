/**
 * Feedback-Loop-side stub read for #63 — proves the `DebateLog` /
 * `debate_id` join ahead of the full Feedback Loop build-out (#91). See
 * docs/specs/feedback-loop-spec.md ("Module: Weight Attribution"): FL reads
 * `AnalystContribution[]` (influence_score, final_position) from the debate
 * log at trade close, joined by `debate_id` — not from the ephemeral,
 * no-persistence `DebateResult` (decision #10).
 */
import type { DebateLogStore } from '../../shared/index.js';
import type { AnalystContribution } from '../debate-engine/index.js';

/**
 * Returns undefined if no `DebateLog` row was ever written for this
 * `debate_id`, OR if the row's `termination` is `'latency_truncated'`
 * (#1081).
 *
 * A latency-truncated debate's `contributions` are whatever partial mediator
 * state existed the instant `enforceLatencyBudget` fired — not a completed
 * per-analyst assessment of the bar. Crediting or blaming analysts off it
 * would move Feedback Loop weights on an infrastructure timeout, not
 * evidence, which is exactly the confound #1081 exists to remove. Treated
 * the same as "no row": SKIPPED, not zero-attributed (`accumulateCredit`'s
 * doc comment).
 *
 * A row with `termination` absent (a pre-0041 row, or one written by a
 * caller that predates this migration) is NOT excluded here — the row makes
 * no claim about whether it was truncated, so this preserves the prior
 * (attributed) behaviour rather than guessing.
 */
export function getContributionsForAttribution(
  store: DebateLogStore,
  debate_id: string,
): AnalystContribution[] | undefined {
  const row = store.getByDebateId(debate_id);
  if (row === undefined || row.termination === 'latency_truncated') {
    return undefined;
  }
  return row.contributions;
}
