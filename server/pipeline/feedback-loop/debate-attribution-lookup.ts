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

/** Returns undefined if no `DebateLog` row was ever written for this debate_id. */
export function getContributionsForAttribution(
  store: DebateLogStore,
  debate_id: string,
): AnalystContribution[] | undefined {
  return store.getByDebateId(debate_id)?.contributions;
}
