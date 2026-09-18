import { isDegradedDecision } from '../../../contracts/index.js';
import type { DebateResult } from '../../pipeline/debate-engine/index.js';

export { isDegradedDecision };

export function debateDecisionWord(debate: DebateResult): string {
  if (debate.rate_limited !== undefined) {
    return 'not_admitted';
  }
  if (debate.timed_out !== undefined) {
    return debate.rounds_completed === 0 ? 'budget_exhausted' : 'timed_out_partial';
  }
  if (!debate.read) {
    return 'unread';
  }
  return debate.direction;
}
