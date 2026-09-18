import type { VerdictDecision } from '../types.js';

const NOTABLE_NO_GO_REASONS: ReadonlySet<string> = new Set([
  'breaker',
  'human_rejected',
  'timeout',
]);

export function isNotableVerdict(decision: VerdictDecision): boolean {
  if (decision.status === 'go') return true;
  return decision.no_go_reason !== null && NOTABLE_NO_GO_REASONS.has(decision.no_go_reason);
}
